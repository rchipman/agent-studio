//! local_embed.rs
//!
//! In-process embedding engine (TIN-1691) — pure-Rust BERT inference via candle,
//! no ONNX, no Python, no external server. Produces L2-normalized sentence
//! vectors locally so semantic search works out of the box.
//!
//! Model: `sentence-transformers/all-MiniLM-L6-v2` (384-dim). Mean-pooled over
//! token embeddings (attention-mask weighted), matching candle's canonical
//! sentence-embedding path. Weights + tokenizer are fetched once via hf-hub and
//! cached (default `~/.cache/huggingface`); after that the engine runs fully
//! offline. (bge-small is a drop-in later — same 384 dim, but CLS pooling.)
//!
//! The model is loaded lazily and cached behind a `Mutex` so the first `embed`
//! pays the load cost once. Any failure (no network on first run, missing
//! weights) returns `Err`, and callers fall back to BM25-only search.

use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer};

/// Default local model id (HuggingFace repo).
pub const LOCAL_MODEL: &str = "sentence-transformers/all-MiniLM-L6-v2";
/// Embedding width of [`LOCAL_MODEL`].
pub const LOCAL_DIM: usize = 384;

struct Engine {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

/// Local cache directory for model files: `~/.agent-studio/models/<model>/`.
fn model_dir() -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let leaf = LOCAL_MODEL.rsplit('/').next().unwrap_or("model");
    let dir = std::path::Path::new(&home).join(".agent-studio/models").join(leaf);
    std::fs::create_dir_all(&dir).context("create model cache dir")?;
    Ok(dir)
}

/// Ensure a model file is cached locally, downloading it once from the
/// HuggingFace CDN if absent. Returns the local path.
fn ensure_file(name: &str) -> Result<std::path::PathBuf> {
    let dest = model_dir()?.join(name);
    if dest.exists() && std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(dest);
    }
    let url = format!("https://huggingface.co/{LOCAL_MODEL}/resolve/main/{name}");
    let resp = ureq::get(&url).call().with_context(|| format!("download {name}"))?;
    // Stream to a temp file, then rename, so a partial download never looks cached.
    let tmp = dest.with_extension("part");
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&tmp).context("create temp model file")?;
    std::io::copy(&mut reader, &mut file).with_context(|| format!("write {name}"))?;
    drop(file);
    std::fs::rename(&tmp, &dest).context("finalize model file")?;
    Ok(dest)
}

impl Engine {
    /// Fetch (or load from cache) the model + tokenizer and build the engine.
    fn load() -> Result<Self> {
        let device = Device::Cpu;

        let config_path = ensure_file("config.json")?;
        let tokenizer_path = ensure_file("tokenizer.json")?;
        let weights_path = ensure_file("model.safetensors")?;

        let config: Config = serde_json::from_str(&std::fs::read_to_string(config_path)?)?;
        let mut tokenizer = Tokenizer::from_file(tokenizer_path).map_err(anyhow::Error::msg)?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            ..Default::default()
        }));

        // SAFETY: mmap of a trusted, locally-cached safetensors file.
        let vb = unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &device)? };
        let model = BertModel::load(vb, &config).context("load BERT weights")?;

        Ok(Self { model, tokenizer, device })
    }

    /// Embed a batch of texts into L2-normalized 384-d vectors.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(anyhow::Error::msg)?;

        // Build (batch, seq) tensors. BatchLongest padding makes every row equal
        // length, so a plain stack works.
        let mut id_rows = Vec::with_capacity(encodings.len());
        let mut mask_rows = Vec::with_capacity(encodings.len());
        for enc in &encodings {
            id_rows.push(Tensor::new(enc.get_ids(), &self.device)?);
            mask_rows.push(Tensor::new(enc.get_attention_mask(), &self.device)?);
        }
        let input_ids = Tensor::stack(&id_rows, 0)?;
        let attention_mask = Tensor::stack(&mask_rows, 0)?;
        let token_type_ids = input_ids.zeros_like()?;

        // (batch, seq, hidden)
        let hidden = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))?;

        // Mean pooling, weighted by the attention mask so padding doesn't count.
        let mask_f = attention_mask.to_dtype(DType::F32)?.unsqueeze(2)?; // (b, seq, 1)
        let summed = hidden.broadcast_mul(&mask_f)?.sum(1)?; // (b, hidden)
        let counts = mask_f.sum(1)?; // (b, 1)
        let mean = summed.broadcast_div(&counts)?;

        // L2 normalize so cosine similarity == dot product.
        let norm = mean.sqr()?.sum_keepdim(1)?.sqrt()?;
        let normalized = mean.broadcast_div(&norm)?;

        Ok(normalized.to_vec2::<f32>()?)
    }
}

/// Lazily-loaded shared engine. The first call loads the model (and downloads it
/// on first ever run); subsequent calls reuse it.
fn engine() -> Result<Arc<Engine>> {
    static CELL: OnceLock<Mutex<Option<Arc<Engine>>>> = OnceLock::new();
    let cell = CELL.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|e| anyhow::anyhow!("engine lock: {e}"))?;
    if let Some(e) = guard.as_ref() {
        return Ok(e.clone());
    }
    let e = Arc::new(Engine::load()?);
    *guard = Some(e.clone());
    Ok(e)
}

/// Embed texts locally. Matches the embedder shape used by the indexing pipeline
/// (owned inputs, one vector per input). Returns `Err` if the model can't load.
pub fn embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    engine()?.embed(&texts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum() // already L2-normalized
    }

    // Downloads ~90MB on first run, so it's ignored by default. Run with:
    //   cargo test --lib local_embed -- --ignored --nocapture
    #[test]
    #[ignore = "downloads the model on first run; run manually"]
    fn local_embed_dim_and_semantic_order() {
        let v = embed(vec![
            "the cat sat on the mat".to_string(),
            "a feline rested on the rug".to_string(),
            "quarterly financial report and revenue".to_string(),
        ])
        .expect("local embed should succeed once the model is cached");

        assert_eq!(v.len(), 3);
        assert_eq!(v[0].len(), LOCAL_DIM, "vectors are 384-d");

        // Normalized vectors → norm ~1.
        let norm0: f32 = v[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm0 - 1.0).abs() < 1e-3, "L2-normalized, got {norm0}");

        // The paraphrase is closer than the unrelated sentence.
        let related = cosine(&v[0], &v[1]);
        let unrelated = cosine(&v[0], &v[2]);
        assert!(
            related > unrelated,
            "paraphrase should be closer: related={related} unrelated={unrelated}"
        );
    }
}
