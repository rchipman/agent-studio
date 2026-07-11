//! reason.rs
//!
//! Reasoning / chat LLM provider (TIN-1696, TIN-1789). One entry point —
//! [`complete`] — behind which the backend is either the **Gemini** REST API
//! (preferred when an API key is configured) or a local **Ollama** instruct
//! model (the offline fallback).
//!
//! ## Backend selection (TIN-1789)
//!
//! The local Ollama models Rob's machine can run were returning
//! `continuityScore: 0.0` on every write and flagging noise as conflicts — not
//! capable enough for the judgment workload. Gemini has a genuinely free API
//! tier well-suited to it, so when a Gemini key is configured we route through
//! it; otherwise we fall back to Ollama, and if neither is available every call
//! is a clean `Err` so callers degrade calmly.
//!
//! * **Gemini** — `POST generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
//!   key in the `x-goog-api-key` header (never in the URL/logs). The system/user
//!   shape is remapped to Gemini's `system_instruction` + `contents`/`parts`.
//!   The key lives in the OS keychain (see `settings::resolve_gemini_key`).
//! * **Ollama** — local HTTP at `http://localhost:11434`. We auto-detect an
//!   installed instruct model (`GET /api/tags`) and chat with it
//!   (`POST /api/chat`, non-streaming). Nothing leaves the machine; no API key.
//!
//! The four public functions (`complete`, `complete_with`, `detect_model`,
//! `reachable`) keep their exact signatures so no caller
//! (`continuity.rs`, `audit.rs`, `cli.rs`, `frontmatter.rs`) needs to change.
//!
//! The public surface is consumed by the audit pass (TIN-1695), not yet wired
//! into a command, hence the module `allow(dead_code)`.
#![allow(dead_code)]

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const OLLAMA_BASE: &str = "http://localhost:11434";

/// Gemini REST base. The model id and `:generateContent` are appended per call.
const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com";
/// The Gemini model used for continuity/judgment work. `gemini-2.0-flash` is on
/// the free tier and fast — well-matched to short classification/judgment calls.
const GEMINI_MODEL: &str = "gemini-2.0-flash";
/// Low temperature: grounded, repeatable judgments, not prose. Shared by both
/// backends.
const REASON_TEMPERATURE: f32 = 0.1;

/// True if `model` names a Gemini model (routes to the Gemini backend). Ollama
/// model ids look like `llama3.1:8b`; Gemini ids like `gemini-2.0-flash`.
fn is_gemini_model(model: &str) -> bool {
    model.starts_with("gemini")
}

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

/// Detect a usable local Ollama instruct model, if Ollama is reachable.
async fn detect_ollama_model() -> Result<String> {
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

/// The model the reasoning provider will use. When a Gemini key is configured
/// (TIN-1789) that backend is preferred and its model id is returned without a
/// network round-trip — a Gemini call is only attempted when work actually
/// arrives, and it falls back to Ollama on failure. With no key, we fall through
/// to local Ollama detection.
///
/// The returned id is also used by `audit.rs` as part of its verdict-cache key,
/// so switching backends (Ollama ↔ Gemini) naturally invalidates stale verdicts.
pub async fn detect_model() -> Result<String> {
    if crate::settings::resolve_gemini_key().is_some() {
        return Ok(GEMINI_MODEL.to_string());
    }
    detect_ollama_model().await
}

/// True if a reasoning model is available right now — a configured Gemini key or
/// a reachable Ollama with a usable model. This gates the callers' "degrade
/// calmly" paths; the actual call still falls back / errors cleanly if the
/// chosen backend turns out to be unreachable at request time.
pub async fn reachable() -> bool {
    detect_model().await.is_ok()
}

// ── Public entry points ──────────────────────────────────────────────────────

/// Run one chat completion. `system` sets the task framing; `user` is the
/// content to reason over. Returns the assistant's text.
///
/// Backend selection (TIN-1789): if a Gemini key is configured, try Gemini and
/// fall back to Ollama on error; with no key, use Ollama directly. If neither is
/// available the result is a clean `Err` so callers degrade calmly.
pub async fn complete(system: &str, user: &str) -> Result<String> {
    if let Some(key) = crate::settings::resolve_gemini_key() {
        match gemini_complete(GEMINI_MODEL, system, user, &key).await {
            Ok(out) => return Ok(out),
            Err(e) => {
                log::warn!("[reason] Gemini call failed, falling back to Ollama: {e}");
            }
        }
    }
    let model = detect_ollama_model().await?;
    ollama_complete(&model, system, user).await
}

/// Like [`complete`] but against an explicit model id (used by `audit.rs`, which
/// resolves the id once via [`detect_model`] and threads it through so it can key
/// its verdict cache). Routes to the Gemini backend for a `gemini-*` id (with the
/// same Ollama fallback as [`complete`]), otherwise to Ollama.
pub async fn complete_with(model: &str, system: &str, user: &str) -> Result<String> {
    if is_gemini_model(model) {
        if let Some(key) = crate::settings::resolve_gemini_key() {
            match gemini_complete(model, system, user, &key).await {
                Ok(out) => return Ok(out),
                Err(e) => {
                    log::warn!("[reason] Gemini call failed, falling back to Ollama: {e}");
                }
            }
        }
        // Key removed since detection, or Gemini errored — fall back to Ollama.
        let fallback = detect_ollama_model().await?;
        return ollama_complete(&fallback, system, user).await;
    }
    ollama_complete(model, system, user).await
}

// ── Ollama backend ───────────────────────────────────────────────────────────

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

/// One non-streaming chat completion against a local Ollama instruct model.
async fn ollama_complete(model: &str, system: &str, user: &str) -> Result<String> {
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let body = ChatRequest {
        model,
        messages: vec![
            ChatMessage { role: "system", content: system },
            ChatMessage { role: "user", content: user },
        ],
        stream: false,
        options: ChatOptions { temperature: REASON_TEMPERATURE },
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

// ── Gemini backend (TIN-1789) ────────────────────────────────────────────────

/// A Gemini `content` block: an ordered list of `parts`, with an optional role.
/// `system_instruction` omits the role; `contents` entries carry `role: "user"`.
#[derive(Serialize)]
struct GeminiContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiGenConfig {
    temperature: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiRequest {
    system_instruction: GeminiContent,
    contents: Vec<GeminiContent>,
    generation_config: GeminiGenConfig,
}

#[derive(Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiRespContent>,
}

#[derive(Deserialize)]
struct GeminiRespContent {
    #[serde(default)]
    parts: Vec<GeminiRespPart>,
}

#[derive(Deserialize)]
struct GeminiRespPart {
    #[serde(default)]
    text: String,
}

/// Build the Gemini `generateContent` request body from a system/user pair.
/// Pure (no I/O) so the message-shape remapping can be unit-tested in isolation.
fn build_gemini_request(system: &str, user: &str, temperature: f32) -> GeminiRequest {
    GeminiRequest {
        system_instruction: GeminiContent {
            role: None,
            parts: vec![GeminiPart { text: system.to_string() }],
        },
        contents: vec![GeminiContent {
            role: Some("user"),
            parts: vec![GeminiPart { text: user.to_string() }],
        }],
        generation_config: GeminiGenConfig { temperature },
    }
}

/// Extract the assistant text from a parsed Gemini response: concatenate the
/// parts of the first candidate. Pure so response parsing can be tested without
/// the network. Errors on a missing/empty candidate or empty text.
fn extract_gemini_text(resp: &GeminiResponse) -> Result<String> {
    let candidate = resp
        .candidates
        .first()
        .ok_or_else(|| anyhow!("Gemini returned no candidates (possibly filtered)"))?;
    let content = candidate
        .content
        .as_ref()
        .ok_or_else(|| anyhow!("Gemini candidate had no content"))?;
    let text: String = content.parts.iter().map(|p| p.text.as_str()).collect();
    if text.trim().is_empty() {
        return Err(anyhow!("Gemini returned empty text"));
    }
    Ok(text)
}

/// One completion against the Gemini `generateContent` REST endpoint. The API
/// key is sent in the `x-goog-api-key` header (kept out of the URL and logs).
async fn gemini_complete(model: &str, system: &str, user: &str, api_key: &str) -> Result<String> {
    let client = reqwest::Client::builder().use_rustls_tls().build()?;
    let body = build_gemini_request(system, user, REASON_TEMPERATURE);
    let url = format!("{GEMINI_BASE}/v1beta/models/{model}:generateContent");
    let resp = client
        .post(&url)
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await
        .context("Gemini generateContent request failed")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Gemini error {status}: {text}"));
    }
    let parsed: GeminiResponse = resp.json().await.context("parse Gemini response")?;
    extract_gemini_text(&parsed)
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

    // ── Gemini backend routing (pure) ──────────────────────────────────────────

    #[test]
    fn is_gemini_model_matches_gemini_ids_only() {
        assert!(is_gemini_model("gemini-2.0-flash"));
        assert!(is_gemini_model("gemini-1.5-pro"));
        assert!(!is_gemini_model("llama3.1:8b"));
        assert!(!is_gemini_model("qwen2.5-coder:7b"));
        assert!(!is_gemini_model(""));
    }

    // ── Gemini request shape (pure remap) ──────────────────────────────────────

    #[test]
    fn build_gemini_request_maps_system_and_user_shape() {
        let req = build_gemini_request("You are a judge.", "Compare A and B.", 0.1);
        let v = serde_json::to_value(&req).expect("serialize");

        // systemInstruction carries the system text with no role (camelCased on
        // the wire to match the Gemini v1beta REST schema).
        assert_eq!(v["systemInstruction"]["parts"][0]["text"], "You are a judge.");
        assert!(
            v["systemInstruction"].get("role").is_none(),
            "systemInstruction must not carry a role"
        );

        // contents carries the user text with role "user".
        assert_eq!(v["contents"][0]["role"], "user");
        assert_eq!(v["contents"][0]["parts"][0]["text"], "Compare A and B.");

        // generationConfig is camelCased on the wire, temperature threaded through
        // (f32 → JSON widens to f64, so compare with a tolerance).
        let temp = v["generationConfig"]["temperature"].as_f64().expect("temperature is a number");
        assert!((temp - 0.1).abs() < 1e-6, "temperature ~= 0.1, got {temp}");
    }

    // ── Gemini response parsing (pure) ─────────────────────────────────────────

    #[test]
    fn extract_gemini_text_reads_first_candidate() {
        // Shape of a real generateContent response.
        let json = r#"{
            "candidates": [
                { "content": { "parts": [ { "text": "cold" } ], "role": "model" } }
            ]
        }"#;
        let resp: GeminiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(extract_gemini_text(&resp).unwrap(), "cold");
    }

    #[test]
    fn extract_gemini_text_concatenates_multiple_parts() {
        let json = r#"{
            "candidates": [
                { "content": { "parts": [ { "text": "one " }, { "text": "two" } ] } }
            ]
        }"#;
        let resp: GeminiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(extract_gemini_text(&resp).unwrap(), "one two");
    }

    #[test]
    fn extract_gemini_text_errors_on_no_candidates() {
        // A safety-filtered response can come back with an empty candidate list.
        let resp: GeminiResponse = serde_json::from_str(r#"{ "candidates": [] }"#).unwrap();
        assert!(extract_gemini_text(&resp).is_err());
    }

    #[test]
    fn extract_gemini_text_errors_on_empty_text() {
        let json = r#"{ "candidates": [ { "content": { "parts": [ { "text": "  " } ] } } ] }"#;
        let resp: GeminiResponse = serde_json::from_str(json).unwrap();
        assert!(extract_gemini_text(&resp).is_err());
    }

    #[test]
    fn extract_gemini_text_errors_on_missing_content() {
        // A candidate with no content (e.g. blocked with finishReason only).
        let json = r#"{ "candidates": [ { "finishReason": "SAFETY" } ] }"#;
        let resp: GeminiResponse = serde_json::from_str(json).unwrap();
        assert!(extract_gemini_text(&resp).is_err());
    }

    // Round-trip against the real Gemini API; ignored by default (needs a key).
    //   STUDIO_GEMINI_API_KEY=… cargo test --lib reason -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs STUDIO_GEMINI_API_KEY and network"]
    async fn gemini_round_trip() {
        let key = std::env::var("STUDIO_GEMINI_API_KEY").expect("set STUDIO_GEMINI_API_KEY");
        let out = gemini_complete(
            GEMINI_MODEL,
            "You answer with a single word.",
            "What is the opposite of hot? Reply with one word.",
            &key,
        )
        .await
        .expect("Gemini should respond");
        assert!(out.to_lowercase().contains("cold"), "expected 'cold', got {out:?}");
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
