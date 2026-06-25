//! reason.rs
//!
//! Reasoning / chat LLM provider (TIN-1696). One entry point —
//! [`complete`] — behind which the model can be a local Ollama instruct model
//! (the default, wired here), and later a bundled candle model or a remote API,
//! all selectable via the Settings Models framework.
//!
//! Ollama is local HTTP at `http://localhost:11434`. We auto-detect an installed
//! instruct model (`GET /api/tags`) and chat with it (`POST /api/chat`,
//! non-streaming). Nothing leaves the machine; no API key.
//!
//! Every failure path (Ollama not running, no usable model, bad response) is a
//! clean `Err` so callers — the consistency audit — can degrade calmly.
//!
//! The public surface is consumed by the audit pass (TIN-1695), not yet wired
//! into a command, hence the module `allow(dead_code)`.
#![allow(dead_code)]

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const OLLAMA_BASE: &str = "http://localhost:11434";

// ── Model discovery ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
}

/// Pick a usable instruct model from the installed list. Skips base/embedding
/// models (no chat behaviour), prefers a known general-instruct family, and
/// DEPRIORITIZES code-tuned models — the reasoning consumer (the contradiction
/// judge, TIN-1753) reasons over prose, where a `-coder` model is a weak
/// last-resort, not a preference. A code model is still chosen if it is the only
/// usable one. Pure so it can be unit-tested without a server.
fn pick_model(names: &[String]) -> Option<String> {
    let usable: Vec<&String> = names
        .iter()
        .filter(|n| {
            let l = n.to_lowercase();
            !l.contains("-base") && !l.contains(":base") && !l.contains("embed")
        })
        .collect();
    if usable.is_empty() {
        return None;
    }
    // Prefer a general instruct family (better at prose); earlier = stronger.
    const PREFERRED: &[&str] = &["llama3", "llama-3", "mistral", "qwen2.5", "qwen3", "gemma"];
    let score = |name: &str| -> i32 {
        let l = name.to_lowercase();
        let mut s = 0;
        // Code-tuned models are poor prose judges — heavy penalty, but not a ban.
        if l.contains("coder") || l.contains("-code") || l.contains(":code") {
            s -= 100;
        }
        for (i, fam) in PREFERRED.iter().enumerate() {
            if l.contains(fam) {
                s += 50 - i as i32;
                break;
            }
        }
        s
    };
    // Highest score wins; stable on ties (first usable in original order).
    usable
        .iter()
        .enumerate()
        .max_by_key(|(i, n)| (score(n), -(*i as i32)))
        .map(|(_, n)| (*n).clone())
}

/// The model the reasoning provider will use, if Ollama is reachable and has a
/// usable instruct model.
pub async fn detect_model() -> Result<String> {
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let resp = client
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .send()
        .await
        .context("Ollama not reachable on localhost:11434")?;
    if !resp.status().is_success() {
        return Err(anyhow!("Ollama /api/tags returned {}", resp.status()));
    }
    let tags: TagsResponse = resp.json().await.context("parse Ollama /api/tags")?;
    let names: Vec<String> = tags.models.into_iter().map(|m| m.name).collect();
    pick_model(&names).ok_or_else(|| {
        anyhow!("Ollama is running but has no instruct model. Try `ollama pull llama3.1:8b`.")
    })
}

/// True if a reasoning model is available right now.
pub async fn reachable() -> bool {
    detect_model().await.is_ok()
}

// ── Chat ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
    /// Lower temperature: we want grounded, repeatable judgments, not prose.
    options: ChatOptions,
}

#[derive(Serialize)]
struct ChatOptions {
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: ChatMessageOwned,
}

#[derive(Deserialize)]
struct ChatMessageOwned {
    content: String,
}

/// Run one chat completion against the local reasoning model. `system` sets the
/// task framing; `user` is the content to reason over. Returns the assistant's
/// text. Auto-detects the model when `model` is `None`.
pub async fn complete(system: &str, user: &str) -> Result<String> {
    let model = detect_model().await?;
    complete_with(&model, system, user).await
}

/// Like [`complete`] but against an explicit model id.
pub async fn complete_with(model: &str, system: &str, user: &str) -> Result<String> {
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let body = ChatRequest {
        model,
        messages: vec![
            ChatMessage { role: "system", content: system },
            ChatMessage { role: "user", content: user },
        ],
        stream: false,
        options: ChatOptions { temperature: 0.1 },
    };
    let resp = client
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&body)
        .send()
        .await
        .context("Ollama chat request failed")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama chat error {status}: {text}"));
    }
    let parsed: ChatResponse = resp.json().await.context("parse Ollama chat response")?;
    Ok(parsed.message.content)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // pick_model is pure — test the selection logic without a server.
    #[test]
    fn pick_model_skips_base_and_embed() {
        let names = vec![
            "qwen2.5-coder:1.5b-base".to_string(),
            "nomic-embed-text:latest".to_string(),
            "qwen2.5-coder:7b".to_string(),
        ];
        assert_eq!(pick_model(&names), Some("qwen2.5-coder:7b".to_string()));
    }

    #[test]
    fn pick_model_prefers_general_instruct_over_coder() {
        let names = vec![
            "qwen2.5-coder:7b".to_string(),
            "llama3.1:8b".to_string(),
        ];
        assert_eq!(pick_model(&names), Some("llama3.1:8b".to_string()));
    }

    #[test]
    fn pick_model_prefers_general_sibling_over_same_family_coder() {
        // The general qwen2.5:7b must beat its code-tuned sibling — the judge
        // reasons over prose, not code (TIN-1753). Both match the "qwen2.5"
        // family term, so the coder penalty is what must break the tie.
        let names = vec![
            "qwen2.5-coder:7b".to_string(),
            "qwen2.5:7b".to_string(),
        ];
        assert_eq!(pick_model(&names), Some("qwen2.5:7b".to_string()));
    }

    #[test]
    fn pick_model_falls_back_to_coder_when_only_option() {
        // A code model is a weak last-resort, not banned: if it is the only
        // usable instruct model, we still use it rather than degrade to nothing.
        let names = vec![
            "qwen2.5-coder:7b".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(pick_model(&names), Some("qwen2.5-coder:7b".to_string()));
    }

    #[test]
    fn pick_model_none_when_only_base_or_embed() {
        let names = vec![
            "qwen2.5-coder:1.5b-base".to_string(),
            "nomic-embed-text:latest".to_string(),
        ];
        assert_eq!(pick_model(&names), None);
    }

    // Round-trip against a running Ollama; ignored by default (needs the server).
    //   cargo test --lib reason -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs a running Ollama with an instruct model"]
    async fn reason_round_trip() {
        let out = complete(
            "You answer with a single word.",
            "What is the opposite of hot? Reply with one word.",
        )
        .await
        .expect("reasoning model should respond");
        assert!(!out.trim().is_empty(), "got a non-empty answer: {out:?}");
        assert!(out.to_lowercase().contains("cold"), "expected 'cold', got {out:?}");
    }
}
