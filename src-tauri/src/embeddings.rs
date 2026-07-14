//! embeddings.rs
//!
//! Async embedding pipeline for TIN-1631.
//!
//! ## Responsibilities
//!
//! 1. `chunk_text` — split markdown body into ~400-word segments with ~50-word
//!    overlap (word-count approximation; avoids a tokeniser dependency).
//! 2. `fingerprint` — SHA-256 hex of a chunk's text, used as a cache key.
//! 3. `embed` — POST to OpenAI `text-embedding-3-small`, returns one `Vec<f32>`
//!    per input string.
//! 4. `index_file` — per-file driver: chunk → skip-if-cached → embed new chunks
//!    → upsert into the `chunks` table (from search.rs).
//! 5. `index_embeddings` — walk every `.md` file in the memory root and call
//!    `index_file` for each one. Intended to run as a background tokio task;
//!    FTS5 search never waits on this.
//!
//! ## Key resolution
//!
//! `resolve_api_key` checks the macOS keychain (via `settings::reveal_embedding_key`
//! logic) then falls back to `STUDIO_EMBEDDING_API_KEY`. Returns `None` if no
//! key is available — callers skip embedding silently.
//!
//! The OpenAI HTTP path (`embed`, `real_embed`, `resolve_api_key`,
//! `index_embeddings`) is currently dormant — the app defaults to the bundled
//! local model (TIN-1690). It is retained as a selectable provider for the
//! embedding provider abstraction (TIN-1693), hence the module `allow(dead_code)`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::{fs, io};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::search::{embedding_to_blob, EMBEDDING_DIM};

// ── Constants ────────────────────────────────────────────────────────────────

/// Approximate words per chunk segment.
const CHUNK_WORDS: usize = 400;
/// Approximate words of overlap between consecutive chunks.
const OVERLAP_WORDS: usize = 50;
/// OpenAI model id.
const EMBED_MODEL: &str = "text-embedding-3-small";
/// OpenAI embeddings endpoint.
const EMBED_URL: &str = "https://api.openai.com/v1/embeddings";
/// Maximum chunks to send in a single API request (OpenAI allows up to 2048
/// items per call; we stay conservative so a single large file doesn't time
/// out).
const BATCH_SIZE: usize = 96;

// ── Chunking ─────────────────────────────────────────────────────────────────

/// Split `body` into overlapping segments of approximately `CHUNK_WORDS` words
/// each, with `OVERLAP_WORDS` words carried over from the previous chunk.
///
/// Empty or whitespace-only input returns an empty vec.  Text shorter than one
/// chunk is returned as a single element.
pub fn chunk_text(body: &str) -> Vec<String> {
    let words: Vec<&str> = body.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0_usize;

    loop {
        let end = (start + CHUNK_WORDS).min(words.len());
        chunks.push(words[start..end].join(" "));
        if end >= words.len() {
            break;
        }
        // Advance by (CHUNK_WORDS - OVERLAP_WORDS) so the next chunk re-uses
        // the last OVERLAP_WORDS words of this one.
        start += CHUNK_WORDS.saturating_sub(OVERLAP_WORDS);
    }

    chunks
}

// ── Fingerprinting ───────────────────────────────────────────────────────────

/// Stable SHA-256 hex digest of `chunk`.  Used as a cache key so we can skip
/// re-embedding unchanged text.
pub fn fingerprint(chunk: &str) -> String {
    let mut h = Sha256::new();
    h.update(chunk.as_bytes());
    format!("{:x}", h.finalize())
}

// ── OpenAI API types ─────────────────────────────────────────────────────────

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedData>,
}

#[derive(Deserialize)]
struct EmbedData {
    embedding: Vec<f32>,
    index: usize,
}

// ── Embedding ────────────────────────────────────────────────────────────────

/// POST `chunks` to OpenAI and return one `Vec<f32>` per chunk, preserving
/// input order. Batches into groups of `BATCH_SIZE` to stay within API limits.
///
/// Returns `Err` on network / API failures. The caller (`index_file`) logs and
/// continues so a single bad file doesn't abort a whole-root index run.
pub async fn embed(chunks: Vec<String>, api_key: &str) -> anyhow::Result<Vec<Vec<f32>>> {
    if chunks.is_empty() {
        return Ok(Vec::new());
    }

    // Build client with rustls (no native-tls).
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()?;

    let mut results: Vec<(usize, Vec<f32>)> = Vec::with_capacity(chunks.len());
    let mut global_offset = 0_usize;

    for batch in chunks.chunks(BATCH_SIZE) {
        let req_body = EmbedRequest { model: EMBED_MODEL, input: batch };
        let resp = client
            .post(EMBED_URL)
            .bearer_auth(api_key)
            .json(&req_body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("OpenAI embeddings error {status}: {text}"));
        }

        let parsed: EmbedResponse = resp.json().await?;
        for item in parsed.data {
            if item.embedding.len() != EMBEDDING_DIM {
                return Err(anyhow::anyhow!(
                    "expected {EMBEDDING_DIM} dims, got {}",
                    item.embedding.len()
                ));
            }
            results.push((global_offset + item.index, item.embedding));
        }
        global_offset += batch.len();
    }

    // Re-sort by original index (OpenAI guarantees order within a batch but
    // let's be safe across batches).
    results.sort_by_key(|(i, _)| *i);
    Ok(results.into_iter().map(|(_, v)| v).collect())
}

// ── Key resolution ───────────────────────────────────────────────────────────

/// Resolve the embedding API key: keychain first, then `STUDIO_EMBEDDING_API_KEY`.
/// Returns `None` if no key is available — callers should skip embedding silently.
pub fn resolve_api_key() -> Option<String> {
    // Try keychain via the settings helper.
    use crate::settings::{KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        if let Ok(secret) = entry.get_password() {
            let trimmed = secret.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    // Fall back to env var.
    if let Ok(val) = std::env::var("STUDIO_EMBEDDING_API_KEY") {
        let trimmed = val.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

// ── Per-file indexing ────────────────────────────────────────────────────────

/// Check whether a chunk at `(file_path, chunk_idx)` is already stored with
/// the given sha256.  Returns `true` when the DB row exists and the hash
/// matches — i.e. we can safely skip re-embedding.
fn chunk_is_cached(conn: &Connection, file_path: &str, chunk_idx: i64, sha: &str) -> bool {
    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT sha256 FROM chunks WHERE file_path = ?1 AND chunk_idx = ?2",
        params![file_path, chunk_idx],
        |row| row.get(0),
    );
    match result {
        Ok(stored_sha) => stored_sha == sha,
        Err(_) => false,
    }
}

/// Delete all chunk rows for `file_path` that are at or beyond `keep_count`.
/// Called after indexing so stale trailing chunks (file got shorter) are removed.
fn prune_stale_chunks(conn: &Connection, file_path: &str, keep_count: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM chunks WHERE file_path = ?1 AND chunk_idx >= ?2",
        params![file_path, keep_count],
    )?;
    Ok(())
}

/// Upsert a chunk row.  If a row already exists for `(file_path, chunk_idx)`
/// but with a different sha256 (content changed), it is replaced; if the hash
/// matches we skip (see `chunk_is_cached`).
fn upsert_chunk(
    conn: &Connection,
    file_path: &str,
    chunk_idx: i64,
    content: &str,
    sha256: &str,
    embedding: &[f32],
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO chunks (file_path, chunk_idx, content, sha256, embedding)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(file_path, chunk_idx) DO UPDATE SET
           content   = excluded.content,
           sha256    = excluded.sha256,
           embedding = excluded.embedding",
        params![file_path, chunk_idx, content, sha256, embedding_to_blob(embedding)],
    )?;
    Ok(())
}

/// The embedder function signature used by `index_file`.
///
/// Takes owned `Vec<String>` inputs and an owned `String` API key (owned to
/// avoid higher-ranked lifetime issues with async closures), returns one
/// `Vec<f32>` per input.
pub type EmbedFn = fn(Vec<String>, String) -> EmbedFuture;

/// The boxed future an [`EmbedFn`] returns — pulled out as its own alias
/// because the inline `Pin<Box<dyn Future<...> + Send>>` spelling trips
/// clippy's `type_complexity` lint at every call site.
pub type EmbedFuture = std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<Vec<Vec<f32>>>> + Send>>;

/// Wrapper around the OpenAI `embed` function with the `EmbedFn` signature.
pub fn real_embed(chunks: Vec<String>, api_key: String) -> EmbedFuture {
    Box::pin(async move { embed(chunks, &api_key).await })
}

/// Local (candle) embedder with the `EmbedFn` signature — runs the bundled model
/// in-process; the API-key argument is ignored. CPU-bound, but it runs on the
/// dedicated background embedding thread (or via `spawn_blocking` for queries).
pub fn local_real_embed(chunks: Vec<String>, _api_key: String) -> EmbedFuture {
    Box::pin(async move { crate::local_embed::embed(chunks) })
}

/// Index a single file: read → chunk → skip cached → embed new → upsert.
///
/// `embedder` takes owned inputs to avoid higher-ranked lifetime issues with
/// async functions. In production, pass `real_embed`; in tests, pass a fake
/// that returns deterministic dummy vectors without hitting the network.
///
/// **Send-safety**: All SQLite operations are completed synchronously *before*
/// and *after* the `.await` on the embedder, so `&Connection` is not held
/// across any `await` point and the future is `Send`.
pub async fn index_file(
    path: &Path,
    conn: &Connection,
    api_key: &str,
    embedder: EmbedFn,
) -> anyhow::Result<()> {
    let body = fs::read_to_string(path)
        .map_err(|e: io::Error| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let file_path = path.to_string_lossy().to_string();
    let chunks = chunk_text(&body);
    let total = chunks.len() as i64;

    // ── Phase 1: sync DB reads (no await) ────────────────────────────────────
    // Collect which chunks need (re-)embedding. All DB access happens here,
    // before we hold any reference across an await point.
    let to_embed: Vec<(i64, String, String)> = chunks
        .iter()
        .enumerate()
        .filter_map(|(idx, content)| {
            let sha = fingerprint(content);
            if chunk_is_cached(conn, &file_path, idx as i64, &sha) {
                None
            } else {
                Some((idx as i64, content.clone(), sha))
            }
        })
        .collect();

    // ── Phase 2: async embed (conn not held) ─────────────────────────────────
    let embeddings = if to_embed.is_empty() {
        vec![]
    } else {
        let texts: Vec<String> = to_embed.iter().map(|(_, c, _)| c.clone()).collect();
        let api_key_owned = api_key.to_string();
        // conn is NOT used after this point until the future resolves.
        embedder(texts, api_key_owned).await?
    };

    // ── Phase 3: sync DB writes (no await) ───────────────────────────────────
    for ((chunk_idx, content, sha), embedding) in to_embed.iter().zip(embeddings.iter()) {
        upsert_chunk(conn, &file_path, *chunk_idx, content, sha, embedding)?;
    }
    prune_stale_chunks(conn, &file_path, total)?;
    Ok(())
}

// ── Root-level background pass ───────────────────────────────────────────────

/// Walk every `.md` file under `root` (skipping hidden paths and `MEMORY.md`)
/// and embed each one, storing results in the `chunks` table.
///
/// Opens its own SQLite connection to `root` (WAL mode allows concurrent
/// access alongside the FTS5 connection), so the future is `Send` and safe
/// to spawn via `tauri::async_runtime::spawn`.
///
/// Intended to run as a **background** task after the fast, sync FTS5
/// `build_index` — FTS5 search never waits on this.  Any single-file failure
/// is logged and the walk continues.
pub async fn index_embeddings(root: PathBuf, api_key: String) {
    // Open a dedicated connection for the background task.
    let conn = match crate::search::init_db(&root) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[embeddings] background db open failed: {e}");
            return;
        }
    };

    let mut files = Vec::new();
    collect_md_files_emb(&root, &mut files);

    for path in files {
        if let Err(e) = index_file(&path, &conn, &api_key, real_embed).await {
            log::warn!("[embeddings] skipping {}: {e}", path.display());
        }
    }
}

/// Background embedding pass using the bundled **local** candle model — no API
/// key, fully offline. Same shape as [`index_embeddings`] but in-process. The
/// first call loads (and on first ever run downloads) the model; if that fails,
/// every file is skipped and search stays BM25-only.
pub async fn index_embeddings_local(root: PathBuf) {
    let conn = match crate::search::init_db(&root) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[embeddings] background db open failed: {e}");
            return;
        }
    };

    let mut files = Vec::new();
    collect_md_files_emb(&root, &mut files);

    for path in files {
        if let Err(e) = index_file(&path, &conn, "", local_real_embed).await {
            log::warn!("[embeddings] local skip {}: {e}", path.display());
        }
    }
    log::info!("[embeddings] local pass complete");
}

/// Recursively collect `.md` files, mirroring search.rs's `collect_md_files`.
fn collect_md_files_emb(dir: &Path, results: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if full.is_dir() {
            collect_md_files_emb(&full, results);
        } else if name.ends_with(".md") && name != "MEMORY.md" {
            results.push(full);
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{init_db, insert_chunk, register_sqlite_vec, EMBEDDING_DIM};
    use rusqlite::Connection;
    use std::fs;

    fn mem_db() -> Connection {
        register_sqlite_vec();
        // Use init_db on a temp dir so the UNIQUE constraint is applied.
        let tmp = std::env::temp_dir().join(format!(
            "emb-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        init_db(&tmp).unwrap()
    }

    /// Fake embedder with the `EmbedFn` signature — returns deterministic unit
    /// vectors without hitting the network.
    fn fake_embed(chunks: Vec<String>, _key: String) -> EmbedFuture {
        Box::pin(async move {
            let mut out = Vec::new();
            for (i, _) in chunks.iter().enumerate() {
                let mut v = vec![0.0_f32; EMBEDDING_DIM];
                v[i % EMBEDDING_DIM] = 1.0;
                out.push(v);
            }
            Ok(out)
        })
    }

    // ── chunk_text ────────────────────────────────────────────────────────────

    #[test]
    fn chunk_text_empty_input() {
        assert!(chunk_text("").is_empty());
        assert!(chunk_text("   \n  ").is_empty());
    }

    #[test]
    fn chunk_text_short_text_single_chunk() {
        let text = "Hello world, this is a short document.";
        let chunks = chunk_text(text);
        assert_eq!(chunks.len(), 1, "short text produces exactly one chunk");
        // Content should round-trip through the join.
        assert_eq!(chunks[0].split_whitespace().count(), 7);
    }

    #[test]
    fn chunk_text_long_text_produces_multiple_chunks() {
        // Generate a text clearly longer than CHUNK_WORDS (400).
        let word = "word";
        let body: String = (0..1000).map(|_| word).collect::<Vec<_>>().join(" ");
        let chunks = chunk_text(&body);
        assert!(chunks.len() >= 3, "1000 words with 400/50 params → >= 3 chunks");
        for c in &chunks {
            assert!(
                c.split_whitespace().count() <= CHUNK_WORDS,
                "no chunk exceeds CHUNK_WORDS"
            );
        }
    }

    #[test]
    fn chunk_text_overlap_is_present() {
        // Build text with identifiable words so we can verify the overlap.
        let words: Vec<String> = (0..600_u32).map(|i| format!("w{i}")).collect();
        let body = words.join(" ");
        let chunks = chunk_text(&body);
        assert!(chunks.len() >= 2, "need at least 2 chunks");

        // Last OVERLAP_WORDS words of chunk 0 should appear at the start of chunk 1.
        let c0_words: Vec<&str> = chunks[0].split_whitespace().collect();
        let tail: Vec<&str> = c0_words[c0_words.len() - OVERLAP_WORDS..].to_vec();
        let c1_start: Vec<&str> = chunks[1].split_whitespace().take(OVERLAP_WORDS).collect();
        assert_eq!(tail, c1_start, "overlap words must carry over");
    }

    #[test]
    fn chunk_text_exact_chunk_size_no_extra_chunk() {
        // Exactly CHUNK_WORDS words → single chunk, no spurious second one.
        let body: String = (0..CHUNK_WORDS).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let chunks = chunk_text(&body);
        assert_eq!(chunks.len(), 1);
    }

    // ── fingerprint ───────────────────────────────────────────────────────────

    #[test]
    fn fingerprint_is_stable() {
        let fp1 = fingerprint("hello world");
        let fp2 = fingerprint("hello world");
        assert_eq!(fp1, fp2, "fingerprint must be deterministic");
    }

    #[test]
    fn fingerprint_changes_on_edit() {
        let fp1 = fingerprint("hello world");
        let fp2 = fingerprint("hello world!");
        assert_ne!(fp1, fp2, "even a single character change must alter the fingerprint");
    }

    #[test]
    fn fingerprint_is_hex_sha256() {
        let fp = fingerprint("test");
        assert_eq!(fp.len(), 64, "SHA-256 hex is always 64 chars");
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "all hex digits");
    }

    // ── cache / skip logic ────────────────────────────────────────────────────

    #[test]
    fn chunk_is_cached_returns_false_when_absent() {
        let conn = mem_db();
        assert!(!chunk_is_cached(&conn, "missing.md", 0, "any-sha"));
    }

    #[test]
    fn chunk_is_cached_returns_false_on_sha_mismatch() {
        let conn = mem_db();
        let v = vec![0.0_f32; EMBEDDING_DIM];
        insert_chunk(&conn, "a.md", 0, "content", "sha-original", &v).unwrap();
        assert!(!chunk_is_cached(&conn, "a.md", 0, "sha-different"));
    }

    #[test]
    fn chunk_is_cached_returns_true_on_match() {
        let conn = mem_db();
        let v = vec![0.0_f32; EMBEDDING_DIM];
        insert_chunk(&conn, "a.md", 0, "content", "sha-original", &v).unwrap();
        assert!(chunk_is_cached(&conn, "a.md", 0, "sha-original"));
    }

    // ── index_file cache-skip logic ───────────────────────────────────────────
    //
    // We verify skip/re-embed behavior by inspecting the `sha256` stored in
    // the DB rather than relying on a shared global counter (which would race
    // in parallel test runs).

    #[tokio::test]
    async fn index_file_skips_unchanged_chunks() {
        let conn = mem_db();
        let tmp = std::env::temp_dir().join("emb-skip-test");
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("test.md");
        let content = "alpha beta gamma";
        fs::write(&file, content).unwrap();

        // First index: row should be inserted with the correct sha256.
        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let stored_sha: String = conn
            .query_row(
                "SELECT sha256 FROM chunks WHERE file_path = ?1 AND chunk_idx = 0",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .expect("chunk row should exist after first index");

        let expected_sha = fingerprint(&chunk_text(content)[0]);
        assert_eq!(stored_sha, expected_sha, "sha256 stored correctly after first index");

        // Second index with identical content — sha matches cache → no upsert
        // needed.  The stored sha must be unchanged.
        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let sha_after: String = conn
            .query_row(
                "SELECT sha256 FROM chunks WHERE file_path = ?1 AND chunk_idx = 0",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sha_after, expected_sha, "sha256 must be unchanged after second (cached) index");
    }

    #[tokio::test]
    async fn index_file_re_embeds_on_content_change() {
        let conn = mem_db();
        let tmp = std::env::temp_dir().join("emb-change-test");
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("change.md");

        fs::write(&file, "original content here").unwrap();
        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let sha_before: String = conn
            .query_row(
                "SELECT sha256 FROM chunks WHERE file_path = ?1 AND chunk_idx = 0",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .expect("chunk should exist after first index");

        // Mutate the file — sha will change, triggering a re-embed.
        let new_content = "completely different content now in here";
        fs::write(&file, new_content).unwrap();
        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let sha_after: String = conn
            .query_row(
                "SELECT sha256 FROM chunks WHERE file_path = ?1 AND chunk_idx = 0",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();

        assert_ne!(sha_before, sha_after, "sha256 must change after content edit → re-embed happened");
        let expected_new_sha = fingerprint(&chunk_text(new_content)[0]);
        assert_eq!(sha_after, expected_new_sha, "new sha256 matches new content's fingerprint");
    }

    #[tokio::test]
    async fn index_file_prunes_stale_chunks() {
        let conn = mem_db();
        let tmp = std::env::temp_dir().join("emb-prune-test");
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("prune.md");

        // Write a long file that produces 2+ chunks.
        let long: String = (0..500).map(|i: u32| format!("w{i}")).collect::<Vec<_>>().join(" ");
        fs::write(&file, &long).unwrap();

        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let count_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE file_path = ?1",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(count_before >= 2, "long file must produce multiple chunks");

        // Rewrite with a short file (single chunk).
        fs::write(&file, "short").unwrap();
        index_file(&file, &conn, "dummy-key", fake_embed).await.unwrap();

        let count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE file_path = ?1",
                params![file.to_string_lossy().to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count_after, 1, "stale trailing chunks must be pruned");
    }
}
