//! settings.rs
//!
//! Persisted JSON settings (via `tauri-plugin-store`) plus secure storage of the
//! embedding API key (via the OS keychain, `keyring` crate — macOS Keychain).
//!
//! The store file holds only non-secret configuration: the memory + transcripts
//! roots and the session-archive retention policy. The embedding API key is
//! NEVER written to the store; it lives in the keychain and is only returned to
//! the frontend on explicit `reveal_embedding_key`.
//!
//! The search memory root is resolved from these settings (falling back to the
//! default), so `search.rs` indexes the configured root rather than a hardcoded
//! path.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_store::StoreExt;

// ── Constants ────────────────────────────────────────────────────────────────

/// The store file, relative to the app's data dir.
pub const STORE_FILE: &str = "settings.json";
/// The key under which the settings object is persisted in the store.
const SETTINGS_KEY: &str = "settings";

/// Keychain identifiers for the embedding API key.
/// Exposed `pub` so `embeddings::resolve_api_key` can access them without
/// duplicating the constants.
pub const KEYCHAIN_SERVICE: &str = "com.agent-studio.embedding";
pub const KEYCHAIN_ACCOUNT: &str = "embedding-api-key";

/// Keychain account for the Gemini reasoning API key (TIN-1789). Reuses the same
/// keychain *service* as the embedding/Linear keys (mirroring that precedent),
/// with a distinct account name so the three secrets never collide. Consumed by
/// `reason.rs` via [`resolve_gemini_key`]; like every other key it is NEVER
/// written to the settings JSON store.
pub const GEMINI_KEYCHAIN_ACCOUNT: &str = "gemini-api-key";

/// Environment-variable fallback for the Gemini key, mirroring
/// `STUDIO_EMBEDDING_API_KEY`. Lets headless/CI runs supply a key without the GUI.
pub const GEMINI_API_KEY_ENV: &str = "STUDIO_GEMINI_API_KEY";

// ── Types ────────────────────────────────────────────────────────────────────

/// Retention policy for the durable session archive (TIN-1759). Serialised as a
/// tagged object so the frontend can switch on `kind`:
///   { kind: "keepAll" }
///   { kind: "sizeCap", maxBytes }
///   { kind: "keepMonths", months }
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RetentionPolicy {
    KeepAll,
    #[serde(rename_all = "camelCase")]
    SizeCap { max_bytes: u64 },
    #[serde(rename_all = "camelCase")]
    KeepMonths { months: u32 },
}

/// Default size cap: 2 GiB. Archives are write-once / read-rarely, so a couple of
/// gigabytes covers a deep history without unbounded growth.
pub const DEFAULT_ARCHIVE_CAP_BYTES: u64 = 2_147_483_648;

fn default_archive_enabled() -> bool {
    true
}

fn default_retention_policy() -> RetentionPolicy {
    RetentionPolicy::SizeCap {
        max_bytes: DEFAULT_ARCHIVE_CAP_BYTES,
    }
}

/// The full settings shape persisted to the store. Secrets are excluded.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub memory_root: String,
    pub transcripts_root: String,
    /// TIN-1759: whether Studio copies each session out of Claude Code before it
    /// can prune them. Defaults to on for pre-existing stores.
    #[serde(default = "default_archive_enabled")]
    pub archive_enabled: bool,
    /// TIN-1759: retention policy applied by `run_retention_cleanup`.
    #[serde(default = "default_retention_policy")]
    pub retention_policy: RetentionPolicy,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            memory_root: default_memory_root_string(),
            transcripts_root: home_join(".claude/projects"),
            archive_enabled: default_archive_enabled(),
            retention_policy: default_retention_policy(),
        }
    }
}

/// The currently-resolved memory root, held in managed state so `search.rs`
/// commands can read it without re-loading the store on every call. Kept in
/// sync by `persist_settings` whenever the memory root changes.
pub struct MemoryRoot(pub Mutex<PathBuf>);

// ── Path helpers ─────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
}

fn home_join(rel: &str) -> String {
    home().join(rel).to_string_lossy().to_string()
}

/// The default memory root: `~/Projects/tfl/memory`.
pub fn default_memory_root() -> PathBuf {
    home().join("Projects/tfl/memory")
}

fn default_memory_root_string() -> String {
    default_memory_root().to_string_lossy().to_string()
}

// ── Store access ─────────────────────────────────────────────────────────────

/// Load settings from the store, falling back to defaults for a missing file or
/// any missing field.
pub fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return Settings::default(),
    };
    match store.get(SETTINGS_KEY) {
        Some(value) => serde_json::from_value(value).unwrap_or_default(),
        None => Settings::default(),
    }
}

/// Persist settings to the store and keep the managed `MemoryRoot` in sync.
fn persist_settings<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())?;

    // Keep the live memory root in sync for search.rs.
    if let Some(state) = app.try_state::<MemoryRoot>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = resolve_memory_root(&settings.memory_root);
        }
    }
    Ok(())
}

/// Resolve a stored memory-root string to a path, falling back to the default
/// when the stored value is empty.
pub fn resolve_memory_root(stored: &str) -> PathBuf {
    let trimmed = stored.trim();
    if trimmed.is_empty() {
        default_memory_root()
    } else {
        PathBuf::from(trimmed)
    }
}

/// The memory root resolved from the persisted settings (used at startup).
pub fn resolved_memory_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    resolve_memory_root(&load_settings(app).memory_root)
}

// ── Keychain (embedding API key) ─────────────────────────────────────────────

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn gemini_keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, GEMINI_KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

/// Resolve the Gemini reasoning API key: OS keychain first, then the
/// `STUDIO_GEMINI_API_KEY` env var. Returns `None` when no key is available so
/// `reason.rs` can fall back to Ollama (or degrade calmly). Mirrors
/// `embeddings::resolve_api_key` exactly, with the Gemini account/env var.
pub fn resolve_gemini_key() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, GEMINI_KEYCHAIN_ACCOUNT) {
        if let Ok(secret) = entry.get_password() {
            let trimmed = secret.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    if let Ok(val) = std::env::var(GEMINI_API_KEY_ENV) {
        let trimmed = val.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

// ── Reveal gate (hardening, TIN-1793) ────────────────────────────────────────
//
// A stored secret must never be handed back to the webview on a bare `invoke`.
// Before returning any plaintext key, we require a FRESH, explicit user action:
// a native OS confirmation dialog the user has to click through. Malicious or
// accidental JS can call the command, but it cannot approve the native prompt on
// the user's behalf — so a reveal only ever happens when a human just asked for
// it. The dialog is shown via the non-blocking callback API (safe to call from
// the command thread) and the result is awaited over a oneshot channel.

/// Show a native "reveal this secret?" confirmation. Returns true only when the
/// user explicitly clicks the reveal button. Any other outcome (Cancel, dialog
/// dismissed, channel dropped) denies the reveal.
pub async fn confirm_reveal<R: Runtime>(app: &AppHandle<R>, secret_label: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Reveal the stored {secret_label} in plain text?\n\nOnly do this if you asked to see it. The key will be shown in the app window."
        ))
        .title("Reveal secret")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Reveal".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.await.unwrap_or(false)
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<Settings, String> {
    Ok(load_settings(&app))
}

/// Input for `set_settings`. Per the IPC convention, commands with multiple
/// args take a single `payload` struct; here the single struct is the settings.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsInput {
    pub settings: Settings,
}

#[tauri::command]
pub fn set_settings<R: Runtime>(
    payload: SetSettingsInput,
    app: AppHandle<R>,
    db: State<'_, crate::search::Db>,
) -> Result<(), String> {
    let previous = load_settings(&app);
    let next = payload.settings;

    let memory_changed = resolve_memory_root(&previous.memory_root)
        != resolve_memory_root(&next.memory_root);

    persist_settings(&app, &next)?;

    // If the memory root changed, rebuild the index against the new root so
    // search reflects the new location immediately.
    if memory_changed {
        let root = resolve_memory_root(&next.memory_root);
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::search::build_index(&root, &conn).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Input for `set_retention_policy` (TIN-1759). The frontend sends the toggle
/// and the tagged policy together so they persist atomically.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRetentionPolicyInput {
    pub policy: RetentionPolicy,
    pub enabled: bool,
}

/// Persist the archive enable flag + retention policy to the settings store.
/// Nothing is archived or pruned here — that is the job of the indexer pass and
/// `run_retention_cleanup`. This only records intent.
#[tauri::command]
pub fn set_retention_policy<R: Runtime>(
    payload: SetRetentionPolicyInput,
    app: AppHandle<R>,
) -> Result<(), String> {
    let mut settings = load_settings(&app);
    settings.archive_enabled = payload.enabled;
    settings.retention_policy = payload.policy;
    persist_settings(&app, &settings)
}

/// Rebuild the search index against the currently-configured memory root.
#[tauri::command]
pub fn rebuild_index<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, crate::search::Db>,
) -> Result<usize, String> {
    let root = resolved_memory_root(&app);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::search::build_index(&root, &conn).map_err(|e| e.to_string())
}

/// Input for `set_embedding_key`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEmbeddingKeyInput {
    pub key: String,
}

#[tauri::command]
pub fn set_embedding_key(payload: SetEmbeddingKeyInput) -> Result<(), String> {
    let entry = keychain_entry()?;
    let key = payload.key.trim();
    if key.is_empty() {
        // Empty key clears the stored secret.
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
}

/// Returns "set" or "unset" without revealing the key.
#[tauri::command]
pub fn embedding_key_status() -> Result<String, String> {
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(_) => Ok("set".to_string()),
        Err(keyring::Error::NoEntry) => Ok("unset".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Returns the plaintext key, gated behind a fresh native confirmation (see
/// [`confirm_reveal`]). A bare JS `invoke` cannot obtain the secret without a
/// human clicking through the OS prompt.
#[tauri::command]
pub async fn reveal_embedding_key<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    if !confirm_reveal(&app, "embedding API key").await {
        return Err("Reveal cancelled.".to_string());
    }
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Keychain (Gemini reasoning API key, TIN-1789) ────────────────────────────
// Mirrors the embedding-key commands above exactly. The key is only ever stored
// in the OS keychain, never in the settings JSON store.

/// Input for `set_gemini_key`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGeminiKeyInput {
    pub key: String,
}

/// Store (or clear) the Gemini API key in the OS keychain. An empty key clears it.
#[tauri::command]
pub fn set_gemini_key(payload: SetGeminiKeyInput) -> Result<(), String> {
    let entry = gemini_keychain_entry()?;
    let key = payload.key.trim();
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
}

/// Returns "set" or "unset" without revealing the key.
#[tauri::command]
pub fn gemini_key_status() -> Result<String, String> {
    let entry = gemini_keychain_entry()?;
    match entry.get_password() {
        Ok(_) => Ok("set".to_string()),
        Err(keyring::Error::NoEntry) => Ok("unset".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Returns the plaintext Gemini key, gated behind a fresh native confirmation
/// (see [`confirm_reveal`]) — same hardening as the embedding key.
#[tauri::command]
pub async fn reveal_gemini_key<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    if !confirm_reveal(&app, "Gemini API key").await {
        return Err("Reveal cancelled.".to_string());
    }
    let entry = gemini_keychain_entry()?;
    match entry.get_password() {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_to_default_when_empty() {
        assert_eq!(resolve_memory_root(""), default_memory_root());
        assert_eq!(resolve_memory_root("   "), default_memory_root());
    }

    #[test]
    fn resolve_uses_stored_when_present() {
        assert_eq!(
            resolve_memory_root("/tmp/somewhere"),
            PathBuf::from("/tmp/somewhere")
        );
    }

    #[test]
    fn defaults_point_at_expected_roots() {
        let s = Settings::default();
        assert!(s.memory_root.ends_with("Projects/tfl/memory"));
        assert!(s.transcripts_root.ends_with(".claude/projects"));
    }

    #[test]
    fn settings_round_trip_through_json() {
        let s = Settings {
            memory_root: "/m".into(),
            transcripts_root: "/t".into(),
            archive_enabled: true,
            retention_policy: RetentionPolicy::SizeCap { max_bytes: 1024 },
        };
        let json = serde_json::to_value(&s).unwrap();
        // camelCase on the wire.
        assert!(json.get("memoryRoot").is_some());
        let back: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(back.memory_root, "/m");
        assert_eq!(back.transcripts_root, "/t");
        assert_eq!(
            back.retention_policy,
            RetentionPolicy::SizeCap { max_bytes: 1024 }
        );
    }

    #[test]
    fn archive_defaults_on_for_legacy_store() {
        // A store written before TIN-1759 lacks the archive fields. Serde defaults
        // must turn archiving on with the 2 GiB size cap. Any extra keys a legacy
        // store carried (e.g. the removed prompts/skills roots or agents) are
        // ignored on deserialize.
        let legacy = serde_json::json!({
            "memoryRoot": "/m",
            "promptsRoot": "/p",
            "skillsRoot": "/s",
            "transcriptsRoot": "/t",
            "agents": [{ "name": "claude", "command": "claude" }]
        });
        let s: Settings = serde_json::from_value(legacy).unwrap();
        assert!(s.archive_enabled);
        assert_eq!(
            s.retention_policy,
            RetentionPolicy::SizeCap {
                max_bytes: DEFAULT_ARCHIVE_CAP_BYTES
            }
        );
    }

    #[test]
    fn retention_policy_round_trips_each_variant() {
        for p in [
            RetentionPolicy::KeepAll,
            RetentionPolicy::SizeCap { max_bytes: 999 },
            RetentionPolicy::KeepMonths { months: 6 },
        ] {
            let v = serde_json::to_value(&p).unwrap();
            assert!(v.get("kind").is_some(), "tagged with kind");
            let back: RetentionPolicy = serde_json::from_value(v).unwrap();
            assert_eq!(back, p);
        }
    }
}
