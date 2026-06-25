//! transcript.rs
//!
//! Reads Claude Code `.jsonl` session transcripts from the transcripts root
//! (default: `~/.claude/projects`), indexes their content into a separate
//! `transcript_fts` FTS5 table in the SAME `.studio-index.db` database as the
//! memory index, and exposes four Tauri commands:
//!
//!   - `list_transcript_projects` — project dirs + session counts + last date
//!   - `list_sessions`            — sessions in a project, newest first
//!   - `get_session`              — threaded turns (main + subagents) for a file
//!   - `search_transcripts`       — FTS across all indexed transcript content
//!
//! The transcripts root is read from persisted settings at command invocation
//! time (not at startup), so it reflects changes made in the Settings modal
//! without requiring a restart.
//!
//! ── Session identity & sidecar grouping (TIN-1721) ───────────────────────────
//! A *session* is a TOP-LEVEL `<project>/<sessionId>.jsonl` file. Its subagents
//! live in `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`. Sidecar
//! files are NEVER returned by `list_sessions` as standalone sessions; they are
//! stitched into the parent by `get_session`, and their body text is indexed
//! into FTS under the PARENT session's path so a hit resolves to the parent.
//!
//! ── Spawn linkage (TIN-1721 investigation, verified against ~/.claude) ────────
//! Each subagent ships a sibling `agent-<agentId>.meta.json` containing
//! `{ toolUseId, agentType, description }`. `toolUseId` matches the `id` of the
//! `Task`/`Agent` tool_use block in the PARENT session that spawned the agent
//! (verified: 769/769 sidecars carry a meta.json with a toolUseId, and the
//! parent's `toolUseResult` block independently echoes the same agentId).
//! We therefore surface `spawned_by = toolUseId` and resolve `agent_label` from
//! the meta's `description` / spawning tool_use `subagent_type`. This is a clean
//! id↔id link; no timestamp-ordering fallback is needed. (If a meta.json is ever
//! missing we fall back to the agentId itself / first-timestamp ordering.)
//!
//! ── Token rollup (TIN-1725, Rust half) ───────────────────────────────────────
//! `SessionSummary.usage` sums `message.usage` token sub-keys across the main
//! thread AND all subagents; `models` lists distinct `message.model` values.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, State};

use crate::search::Db;

// ── Schema ───────────────────────────────────────────────────────────────────

const TRANSCRIPT_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS transcript_sessions (
        path       TEXT PRIMARY KEY,
        project    TEXT NOT NULL DEFAULT '',
        date_iso   TEXT NOT NULL DEFAULT '',
        mtime      INTEGER NOT NULL DEFAULT 0,
        first_msg  TEXT NOT NULL DEFAULT '',
        cwd        TEXT NOT NULL DEFAULT ''
    );

    -- Standalone FTS5 table: stores project + full text directly.
    -- path_ref links back to transcript_sessions without a content= join.
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        path_ref UNINDEXED,
        project  UNINDEXED,
        body
    );
";

/// Ensure the transcript schema exists on the connection (called lazily).
/// Also runs additive migrations for columns added after TIN-1721/TIN-1725
/// (CREATE TABLE IF NOT EXISTS won't add columns to pre-existing tables).
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(TRANSCRIPT_SCHEMA)?;
    // Additive migrations: ignore "duplicate column" errors if already present.
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT ''",
        [],
    );
    // TIN-1725: cached metric columns (nullable = not yet computed).
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN turn_count INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN subagent_count INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN input_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN output_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN cache_creation_input_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN cache_read_input_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN models TEXT",
        [],
    );
    // TIN-1759: archive timestamp (NULL = not yet archived). The PK stays the
    // LIVE path, so FTS / metrics / calendar are entirely untouched.
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN archived_at INTEGER",
        [],
    );
    Ok(())
}

// ── Types returned to the frontend ──────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    pub media_type: String,
    pub data: String, // full base64 data
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptProject {
    pub project: String,
    pub session_count: usize,
    pub last_date: String,
    /// Real working directory from a session's first-line `cwd` metadata, so the
    /// frontend can show a true path basename instead of decoding the dash-slug.
    pub cwd: String,
}

/// Token rollup. u64 sums across a session including its subagents.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageRollup {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    /// Project dir this session belongs to (for clean badge keying on the
    /// all-projects list, where rows come from many projects).
    pub project: String,
    pub date: String,
    pub first_message: String,
    pub cwd: String,
    /// Distinct subagent ids stitched under this session.
    pub subagent_count: usize,
    /// Total turn count (main thread + subagent turns).
    pub turn_count: usize,
    /// Token rollup summed across main + subagents.
    pub usage: UsageRollup,
    /// Distinct `message.model` values seen across the session.
    pub models: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Normalised display role ("human"/"assistant") — kept for the frontend.
    pub role: String,
    /// Serialised display text.
    pub content: String,
    /// True when this turn contains tool calls / tool results.
    pub has_tool_use: bool,
    /// For tool-use turns: a short summary of the tool names used.
    pub tool_summary: String,
    // ── TIN-1721 threading additions (additive; frontend ignores unknown) ──
    /// True for subagent (sidechain) turns and controller→subagent prompts.
    pub is_sidechain: bool,
    pub uuid: String,
    pub parent_uuid: Option<String>,
    /// Subagent id for sidechain turns; None on the main thread.
    pub agent_id: Option<String>,
    /// Human label for the subagent (subagent_type / description / "agent").
    pub agent_label: Option<String>,
    /// Spawning `Task`/`Agent` tool_use id (from the sidecar meta.json).
    pub spawned_by: Option<String>,
    /// Inline images attached to this turn (base64-encoded).
    pub images: Vec<ImageBlock>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResult {
    pub project: String,
    pub session_path: String,
    pub snippet: String,
}

// ── Input structs (IPC convention: payload for >= 2 args) ────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsInput {
    pub project: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSessionInput {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTranscriptsInput {
    pub q: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsByDayInput {
    pub project: String,
}

/// One entry in the per-day rollup returned by `sessions_by_day`.
/// `date` is YYYY-MM-DD; `count` is the number of sessions on that date.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub date: String,
    pub count: usize,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

fn transcripts_root_from_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let s = crate::settings::load_settings(app);
    let t = s.transcripts_root.trim().to_string();
    if t.is_empty() {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".claude/projects")
    } else {
        PathBuf::from(t)
    }
}

/// Is this path a sidecar subagent file (under a `subagents/` dir and/or named
/// `agent-*.jsonl`)? Such files are never standalone sessions.
fn is_subagent_path(path: &Path) -> bool {
    let in_subagents_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n == "subagents")
        .unwrap_or(false);
    let agent_named = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("agent-"))
        .unwrap_or(false);
    in_subagents_dir || agent_named
}

/// Given a top-level session file `<project>/<sessionId>.jsonl`, return the path
/// to its `subagents/` directory (`<project>/<sessionId>/subagents`), if any.
fn subagents_dir_for(session_path: &Path) -> Option<PathBuf> {
    let stem = session_path.file_stem()?.to_str()?;
    let parent = session_path.parent()?;
    let dir = parent.join(stem).join("subagents");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Collect the subagent `.jsonl` files for a session, sorted by filename for a
/// deterministic order (first-timestamp ordering is implicit in the agent root).
pub(crate) fn collect_subagent_files(session_path: &Path) -> Vec<PathBuf> {
    let dir = match subagents_dir_for(session_path) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut files: Vec<PathBuf> = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files
}

// ── JSONL parsing ─────────────────────────────────────────────────────────────

/// A fully-parsed transcript line carrying both display fields and the threading
/// / usage metadata needed for stitching and rollups.
struct ParsedLine {
    role: String,        // normalised "human"/"assistant"
    content: String,     // display text
    has_tool_use: bool,
    tool_summary: String,
    images: Vec<ImageBlock>,
    is_sidechain: bool,
    uuid: String,
    parent_uuid: Option<String>,
    agent_id: Option<String>,
    /// model on assistant lines, if present.
    model: Option<String>,
    /// usage token sub-keys on assistant lines, if present.
    usage: UsageRollup,
    has_usage: bool,
}

/// Extract the plain-text content and tool-use info from a single JSONL line.
/// Returns (role, text, has_tool_use, tool_summary) for the legacy display path.
/// Kept as a thin wrapper over `parse_line_full` so existing tests still pass.
#[cfg(test)]
fn parse_line(line: &str) -> Option<(String, String, bool, String)> {
    let p = parse_line_full(line)?;
    Some((p.role, p.content, p.has_tool_use, p.tool_summary))
}

/// Full parse: display fields + threading + usage metadata.
fn parse_line_full(line: &str) -> Option<ParsedLine> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;

    // Claude Code uses a wrapper object with a `type` field. The inner message
    // has `role` and `content`. A flat format ({role, content}) is also handled.
    let (role_raw, content_val, message) = if let Some(msg) = v.get("message") {
        let role = msg
            .get("role")
            .or_else(|| v.get("type"))
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_string();
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        (role, content, Some(msg))
    } else {
        let role = v
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_string();
        let content = v.get("content").cloned().unwrap_or(Value::Null);
        (role, content, None)
    };

    // Normalise role; skip system / metadata lines.
    let role = match role_raw.as_str() {
        "human" | "user" => "human".to_string(),
        "assistant" => "assistant".to_string(),
        _ => return None,
    };

    let (text, has_tool_use, tool_summary, images) = extract_content(&content_val);
    if text.is_empty() && !has_tool_use && images.is_empty() {
        return None;
    }

    // Threading metadata (present on Claude Code wrapped lines; absent on flat).
    let is_sidechain = v
        .get("isSidechain")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let uuid = v
        .get("uuid")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    let parent_uuid = v
        .get("parentUuid")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());
    let agent_id = v
        .get("agentId")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());

    // Usage + model live on the inner message (assistant lines).
    let mut usage = UsageRollup::default();
    let mut has_usage = false;
    let mut model = None;
    if let Some(msg) = message {
        model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());
        if let Some(u) = msg.get("usage").and_then(|u| u.as_object()) {
            has_usage = true;
            let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            usage = UsageRollup {
                input_tokens: g("input_tokens"),
                output_tokens: g("output_tokens"),
                cache_creation_input_tokens: g("cache_creation_input_tokens"),
                cache_read_input_tokens: g("cache_read_input_tokens"),
            };
        }
    }

    Some(ParsedLine {
        role,
        content: text,
        has_tool_use,
        tool_summary,
        images,
        is_sidechain,
        uuid,
        parent_uuid,
        agent_id,
        model,
        usage,
        has_usage,
    })
}

/// Parse a `content` value (string or array of content blocks).
fn extract_content(content: &Value) -> (String, bool, String, Vec<ImageBlock>) {
    match content {
        Value::String(s) => (s.clone(), false, String::new(), Vec::new()),
        Value::Array(blocks) => {
            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_names: Vec<String> = Vec::new();
            let mut has_tool_use = false;
            let mut images: Vec<ImageBlock> = Vec::new();

            for block in blocks {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push(t.to_string());
                        }
                    }
                    "tool_use" => {
                        has_tool_use = true;
                        if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                            let short = shorten_tool_name(name);
                            if !tool_names.contains(&short) {
                                tool_names.push(short);
                            }
                        }
                    }
                    "tool_result" => {
                        has_tool_use = true;
                    }
                    "image" => {
                        if let Some(src) = block.get("source") {
                            let src_type =
                                src.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            if src_type == "base64" {
                                if let (Some(mt), Some(d)) = (
                                    src.get("media_type").and_then(|m| m.as_str()),
                                    src.get("data").and_then(|d| d.as_str()),
                                ) {
                                    // Cap at 2MB of base64 (≈1.5MB decoded) to avoid
                                    // unbounded DOM. base64 char ≈ 0.75 bytes;
                                    // 2_621_440 chars ≈ 2MB decoded.
                                    const MAX_B64: usize = 2_621_440;
                                    if d.len() <= MAX_B64 {
                                        images.push(ImageBlock {
                                            media_type: mt.to_string(),
                                            data: d.to_string(),
                                        });
                                    }
                                }
                            }
                            // url-type images: not yet observed in the wild; skip.
                        }
                    }
                    _ => {}
                }
            }

            let summary = tool_names.join(" · ");
            (text_parts.join("\n\n"), has_tool_use, summary, images)
        }
        _ => (String::new(), false, String::new(), Vec::new()),
    }
}

fn shorten_tool_name(name: &str) -> String {
    let stripped = name.trim_start_matches("mcp__").trim_start_matches("mcp_");
    let last = stripped.split("__").last().unwrap_or(stripped);
    let mut chars = last.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

/// Read a top-level session file and return its main-thread turns (legacy
/// display path; no subagents). Used by the indexer for first_msg / FTS body.
fn parse_session_file(path: &Path) -> Vec<Turn> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line_full)
        .map(parsed_to_turn)
        .collect()
}

/// TIN-1759: read context for the `get_session` archive fallback. Holds the
/// transcripts root + archive root so a deleted live file can resolve to its
/// archived `.zst`. `None` means "no archive fallback" (the indexer path, which
/// only ever reads fresh live files).
#[derive(Clone, Copy)]
struct ReadCtx<'a> {
    transcripts_root: &'a Path,
    archive_root: &'a Path,
}

/// Read one transcript file with the archive fallback (TIN-1759):
///   1. live path exists  → read live (freshest; Claude Code may be appending),
///   2. else archived `.zst` exists → decode it,
///   3. else None.
/// With no ctx, only step 1 applies.
fn read_transcript_text(path: &Path, ctx: Option<ReadCtx>) -> Option<String> {
    if path.exists() {
        return fs::read_to_string(path).ok();
    }
    let ctx = ctx?;
    let archived =
        crate::archive::live_to_archived(path, ctx.transcripts_root, ctx.archive_root)?;
    if archived.exists() {
        return crate::archive::read_maybe_zst(&archived).ok();
    }
    None
}

/// Parse a session file with the archive fallback.
fn parse_session_file_ctx(path: &Path, ctx: Option<ReadCtx>) -> Vec<Turn> {
    let raw = match read_transcript_text(path, ctx) {
        Some(s) => s,
        None => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line_full)
        .map(parsed_to_turn)
        .collect()
}

/// Enumerate a session's subagent `.jsonl` files, falling back to the ARCHIVE
/// sidecar dir when the live session has been pruned. Returns LIVE paths (the
/// reader resolves each to its archived copy), so downstream meta/label logic is
/// unchanged whether the bytes are live or archived.
fn collect_subagent_files_ctx(session_path: &Path, ctx: Option<ReadCtx>) -> Vec<PathBuf> {
    let live = collect_subagent_files(session_path);
    if !live.is_empty() {
        return live;
    }
    // Live session pruned: list the archived sidecar dir and map back to live
    // paths so live_to_archived round-trips them.
    let ctx = match ctx {
        Some(c) => c,
        None => return Vec::new(),
    };
    let archived_session =
        match crate::archive::live_to_archived(session_path, ctx.transcripts_root, ctx.archive_root)
        {
            Some(p) => p,
            None => return Vec::new(),
        };
    // archived_session = <arch>/<proj>/<sess>.jsonl.zst ; subagents live under
    // <arch>/<proj>/<sess>/subagents/agent-*.jsonl.zst.
    let stem = match archived_session
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".jsonl.zst"))
    {
        Some(s) => s.to_string(),
        None => return Vec::new(),
    };
    let archived_dir = match archived_session.parent() {
        Some(p) => p.join(&stem).join("subagents"),
        None => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(&archived_dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.starts_with("agent-") && name.ends_with(".jsonl.zst") {
                // Map the archived sidecar path back to its LIVE equivalent.
                let live_name = name.trim_end_matches(".zst");
                let live_dir = session_path
                    .parent()
                    .map(|d| d.join(&stem).join("subagents"))
                    .unwrap_or_default();
                out.push(live_dir.join(live_name));
            }
        }
    }
    out.sort();
    out
}

/// Read an `agent-<id>.meta.json` with the archive fallback. The meta is stored
/// uncompressed in the archive, so `read_maybe_zst` reads it directly.
fn read_agent_meta_ctx(agent_jsonl: &Path, ctx: Option<ReadCtx>) -> AgentMeta {
    let meta_path = agent_jsonl.with_extension("meta.json");
    if meta_path.exists() {
        return read_agent_meta(agent_jsonl);
    }
    // Live meta gone: resolve via the archive (jsonl → .zst → sibling meta.json).
    if let Some(ctx) = ctx {
        if let Some(archived_jsonl) =
            crate::archive::live_to_archived(agent_jsonl, ctx.transcripts_root, ctx.archive_root)
        {
            // archived_jsonl ends with .jsonl.zst; meta sits beside as .meta.json.
            if let Some(dir) = archived_jsonl.parent() {
                let archived_meta = dir.join(format!(
                    "{}.meta.json",
                    agent_jsonl
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default()
                ));
                if let Ok(raw) = fs::read_to_string(&archived_meta) {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        let s = |k: &str| {
                            v.get(k)
                                .and_then(|x| x.as_str())
                                .filter(|s| !s.is_empty())
                                .map(|s| s.to_string())
                        };
                        return AgentMeta {
                            tool_use_id: s("toolUseId"),
                            agent_type: s("agentType"),
                            description: s("description"),
                        };
                    }
                }
            }
        }
    }
    AgentMeta::default()
}

/// Convert a ParsedLine into a frontend Turn (main-thread defaults).
fn parsed_to_turn(p: ParsedLine) -> Turn {
    Turn {
        role: p.role,
        content: p.content,
        has_tool_use: p.has_tool_use,
        tool_summary: p.tool_summary,
        images: p.images,
        is_sidechain: p.is_sidechain,
        uuid: p.uuid,
        parent_uuid: p.parent_uuid,
        agent_id: p.agent_id,
        agent_label: None,
        spawned_by: None,
    }
}

/// Metadata from a subagent `agent-<id>.meta.json` sidecar.
#[derive(Default)]
struct AgentMeta {
    tool_use_id: Option<String>,
    agent_type: Option<String>,
    description: Option<String>,
}

/// Read `agent-<id>.meta.json` next to `agent_jsonl`, if present.
fn read_agent_meta(agent_jsonl: &Path) -> AgentMeta {
    let meta_path = agent_jsonl.with_extension("meta.json");
    let raw = match fs::read_to_string(&meta_path) {
        Ok(s) => s,
        Err(_) => return AgentMeta::default(),
    };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return AgentMeta::default(),
    };
    let s = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    AgentMeta {
        tool_use_id: s("toolUseId"),
        agent_type: s("agentType"),
        description: s("description"),
    }
}

/// Resolve a subagent's display label: meta.description → meta.agentType →
/// the line's agentType/subagentType → "agent".
fn resolve_agent_label(meta: &AgentMeta, line_agent_type: Option<&str>) -> String {
    meta.description
        .clone()
        .or_else(|| meta.agent_type.clone())
        .or_else(|| line_agent_type.map(|s| s.to_string()))
        .unwrap_or_else(|| "agent".to_string())
}

/// Build the stitched, threaded turn list for a session (no archive fallback).
/// Thin wrapper kept for existing tests.
#[cfg(test)]
fn build_threaded_turns(session_path: &Path) -> Vec<Turn> {
    build_threaded_turns_ctx(session_path, None)
}

/// Build the stitched, threaded turn list for a session: main thread first,
/// then each subagent's sub-thread appended in filename (≈ spawn) order. With a
/// `ReadCtx`, a pruned live file resolves to its archived `.zst` (TIN-1759).
fn build_threaded_turns_ctx(session_path: &Path, ctx: Option<ReadCtx>) -> Vec<Turn> {
    let mut turns: Vec<Turn> = parse_session_file_ctx(session_path, ctx);

    for agent_file in collect_subagent_files_ctx(session_path, ctx) {
        let meta = read_agent_meta_ctx(&agent_file, ctx);
        // agentType may also appear on the line as agentType/subagentType.
        let raw = match read_transcript_text(&agent_file, ctx) {
            Some(s) => s,
            None => continue,
        };
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            // Pull line-level agentType/subagentType as a label fallback when the
            // meta.json carried neither a description nor an agentType.
            let line_agent_type = serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|v| {
                    v.get("agentType")
                        .or_else(|| v.get("subagentType"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                });
            let p = match parse_line_full(line) {
                Some(p) => p,
                None => continue,
            };
            let agent_id = p
                .agent_id
                .clone()
                .or_else(|| agent_id_from_path(&agent_file));
            let mut turn = parsed_to_turn(p);
            turn.is_sidechain = true; // sidecar turns are always sidechain
            turn.agent_id = agent_id;
            turn.agent_label = Some(resolve_agent_label(&meta, line_agent_type.as_deref()));
            turn.spawned_by = meta.tool_use_id.clone();
            turns.push(turn);
        }
    }
    turns
}

/// Extract the agentId from a `agent-<id>.jsonl` filename.
fn agent_id_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("agent-"))
        .map(|s| s.to_string())
}

/// Compute the session summary metrics: subagent count, turn count, usage
/// rollup (main + subagents), distinct models, and cwd. Reads the files fresh.
fn compute_session_metrics(session_path: &Path) -> (usize, usize, UsageRollup, Vec<String>, String) {
    let mut usage = UsageRollup::default();
    let mut models: BTreeSet<String> = BTreeSet::new();
    let mut turn_count = 0usize;
    let mut cwd = String::new();

    // Main thread.
    if let Ok(raw) = fs::read_to_string(session_path) {
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            // cwd: first line carrying a non-empty cwd.
            if cwd.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                        if !c.is_empty() {
                            cwd = c.to_string();
                        }
                    }
                }
            }
            if let Some(p) = parse_line_full(line) {
                turn_count += 1;
                accumulate(&mut usage, &mut models, &p);
            }
        }
    }

    // Subagents.
    let agent_files = collect_subagent_files(session_path);
    let subagent_count = agent_files.len();
    for agent_file in &agent_files {
        if let Ok(raw) = fs::read_to_string(agent_file) {
            for line in raw.lines().filter(|l| !l.trim().is_empty()) {
                if let Some(p) = parse_line_full(line) {
                    turn_count += 1;
                    accumulate(&mut usage, &mut models, &p);
                }
            }
        }
    }

    (subagent_count, turn_count, usage, models.into_iter().collect(), cwd)
}

fn accumulate(usage: &mut UsageRollup, models: &mut BTreeSet<String>, p: &ParsedLine) {
    if p.has_usage {
        usage.input_tokens += p.usage.input_tokens;
        usage.output_tokens += p.usage.output_tokens;
        usage.cache_creation_input_tokens += p.usage.cache_creation_input_tokens;
        usage.cache_read_input_tokens += p.usage.cache_read_input_tokens;
    }
    if let Some(m) = &p.model {
        if !m.is_empty() {
            models.insert(m.clone());
        }
    }
}

/// Extract the date (YYYY-MM-DD) from a session file path or its mtime.
fn date_from_path_or_mtime(path: &Path) -> String {
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        if stem.len() >= 8 {
            let digits: String = stem.chars().take(8).filter(|c| c.is_ascii_digit()).collect();
            if digits.len() == 8 {
                // Only accept it as a YYYYMMDD date if the components are a real
                // calendar date. Claude Code names sessions with UUIDs, and ~2% of
                // them start with 8 digits (e.g. 60439699-…) that would otherwise
                // be misread as "6043-96-99". A plausible-year + valid month/day
                // gate rejects those UUID false positives; they fall to mtime.
                let y: u32 = digits[0..4].parse().unwrap_or(0);
                let m: u32 = digits[4..6].parse().unwrap_or(0);
                let d: u32 = digits[6..8].parse().unwrap_or(0);
                if (2000..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
                    return format!("{y:04}-{m:02}-{d:02}");
                }
            }
        }
    }
    if let Ok(meta) = fs::metadata(path) {
        if let Ok(modified) = meta.modified() {
            use std::time::{Duration, UNIX_EPOCH};
            let secs = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_secs();
            let days = secs / 86400;
            let (y, m, d) = days_to_ymd(days as u32);
            return format!("{y:04}-{m:02}-{d:02}");
        }
    }
    String::new()
}

/// Very simple epoch-days to (year, month, day) without external deps.
pub(crate) fn days_to_ymd(mut days: u32) -> (u32, u32, u32) {
    let mut year = 1970u32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let days_in_year = if leap { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days: [u32; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for md in &month_days {
        if days < *md {
            break;
        }
        days -= md;
        month += 1;
    }
    (year, month, days + 1)
}

/// Get mtime as u64 seconds.
pub(crate) fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })
        .unwrap_or(0)
}

/// First-line cwd metadata for a session file (scans for the first non-empty cwd).
/// Used in tests; compute_session_metrics also returns cwd as its last field.
#[allow(dead_code)]
fn cwd_from_session(path: &Path) -> String {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    return c.to_string();
                }
            }
        }
    }
    String::new()
}

// ── Indexing ─────────────────────────────────────────────────────────────────

/// Incrementally index all TOP-LEVEL session `.jsonl` files under `root`. The
/// indexed body INCLUDES subagent text (so a search hit can live in a subagent),
/// but the FTS `path_ref` is always the PARENT session path so hits resolve to
/// the parent, never the sidecar file.
fn build_transcript_index(root: &Path, conn: &Connection) -> rusqlite::Result<()> {
    ensure_schema(conn)?;

    let tx = conn.unchecked_transaction()?;
    {
        // Fetch mtime AND turn_count (NULL = metrics not yet cached).
        let mut check_row = tx.prepare(
            "SELECT mtime, turn_count FROM transcript_sessions WHERE path = ?1",
        )?;
        let mut upsert_session = tx.prepare(
            "INSERT INTO transcript_sessions (
                path, project, date_iso, mtime, first_msg, cwd,
                turn_count, subagent_count,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                models
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(path) DO UPDATE SET
               project=excluded.project,
               date_iso=excluded.date_iso,
               mtime=excluded.mtime,
               first_msg=excluded.first_msg,
               cwd=excluded.cwd,
               turn_count=excluded.turn_count,
               subagent_count=excluded.subagent_count,
               input_tokens=excluded.input_tokens,
               output_tokens=excluded.output_tokens,
               cache_creation_input_tokens=excluded.cache_creation_input_tokens,
               cache_read_input_tokens=excluded.cache_read_input_tokens,
               models=excluded.models",
        )?;
        let mut delete_fts = tx.prepare("DELETE FROM transcript_fts WHERE path_ref = ?1")?;
        let mut insert_fts =
            tx.prepare("INSERT INTO transcript_fts (path_ref, project, body) VALUES (?1, ?2, ?3)")?;

        for (project, jsonl_path) in collect_jsonl_files(root) {
            let current_mtime = mtime_secs(&jsonl_path);
            let path_str = jsonl_path.to_string_lossy().to_string();

            // (stored_mtime, metrics_cached)
            let stored: Option<(u64, bool)> = check_row
                .query_row(params![path_str], |r| {
                    let mtime = r.get::<_, i64>(0).map(|v| v as u64)?;
                    let has_metrics = r.get::<_, Option<i64>>(1)?.is_some();
                    Ok((mtime, has_metrics))
                })
                .ok();

            let mtime_unchanged = stored.map(|(m, _)| m) == Some(current_mtime);
            let metrics_cached = stored.map(|(_, h)| h).unwrap_or(false);

            if mtime_unchanged && metrics_cached {
                // Row is current and metrics are populated — skip entirely.
                continue;
            }

            let date = date_from_path_or_mtime(&jsonl_path);
            let turns = parse_session_file(&jsonl_path);

            let first_msg = turns
                .iter()
                .find(|t| t.role == "human")
                .map(|t| t.content.trim().chars().take(200).collect::<String>())
                .unwrap_or_default();

            // FTS body: main thread text PLUS all subagent text, so a hit inside
            // a subagent matches — but the row's path_ref stays the parent.
            let mut full_text: String = turns
                .iter()
                .map(|t| t.content.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            for agent_file in collect_subagent_files(&jsonl_path) {
                let sub = parse_session_file(&agent_file);
                if !sub.is_empty() {
                    full_text.push(' ');
                    full_text.push_str(
                        &sub.iter()
                            .map(|t| t.content.as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
            }

            // Compute metrics when mtime changed or they were never stored.
            let (subagent_count, turn_count, usage, models, cwd) =
                compute_session_metrics(&jsonl_path);
            let models_json =
                serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string());

            delete_fts.execute(params![path_str])?;
            upsert_session.execute(params![
                path_str,
                project,
                date,
                current_mtime as i64,
                first_msg,
                cwd,
                turn_count as i64,
                subagent_count as i64,
                usage.input_tokens as i64,
                usage.output_tokens as i64,
                usage.cache_creation_input_tokens as i64,
                usage.cache_read_input_tokens as i64,
                models_json,
            ])?;
            insert_fts.execute(params![path_str, project, full_text])?;
        }
    }
    tx.commit()
}

/// TIN-1759: run the archive pass under the indexer's lock when archiving is
/// enabled, then stamp `archived_at` on each (re)archived session. Called by the
/// indexing commands right after `build_transcript_index`, with the same `conn`
/// lock still held, so the archive never races a concurrent reindex. Any error
/// here is logged and swallowed — archiving must never break browsing/search.
fn maybe_archive_pass<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    transcripts_root: &Path,
    conn: &Connection,
) {
    let settings = crate::settings::load_settings(app);
    if !settings.archive_enabled {
        return;
    }
    let archive_root = match crate::archive::archive_root(app) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[archive] could not resolve archive root: {e}");
            return;
        }
    };
    let mut manifest = crate::archive::load_manifest(&archive_root);
    let written = match crate::archive::archive_pass(
        Some(app),
        transcripts_root,
        &archive_root,
        &mut manifest,
    ) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[archive] archive pass failed: {e}");
            return;
        }
    };
    // Stamp archived_at on the live-path PK rows for everything just archived.
    for (_session_id, live_path, archived_at) in &written {
        let _ = conn.execute(
            "UPDATE transcript_sessions SET archived_at = ?1 WHERE path = ?2",
            params![*archived_at as i64, live_path.to_string_lossy()],
        );
    }
}

// ── Background indexing (TIN-1769) ──────────────────────────────────────────────
//
// Indexing re-parses any `.jsonl` whose mtime changed since the last pass. An
// ACTIVE session file grows constantly and can be tens of MB (this session's own
// transcript was 28.8 MB), so a re-parse + FTS rebuild of it costs tens of
// seconds. Running that inline inside the read commands made opening Sessions
// take 30s+. So the read commands (list/projects/by-day/search) now ONLY query
// the cached table; indexing runs here, on a background thread off the shared Db
// mutex, and emits `transcripts://indexed` so the UI refetches when it lands.

/// Coalescing guard: a pass already running makes a new request a no-op.
static TRANSCRIPT_INDEXING: AtomicBool = AtomicBool::new(false);

/// Recompute `date_iso` for rows whose cached date is not a real calendar date —
/// the old UUID-as-YYYYMMDD bug (TIN-1770) left rows like "6043-96-99". The
/// affected files' mtimes have not changed, so a normal index pass would skip
/// them; this self-healing pass fixes them in place (cheap: path + mtime, no
/// JSONL parse). A no-op once everything is clean.
fn repair_implausible_dates(conn: &Connection) -> rusqlite::Result<()> {
    let bad: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT path FROM transcript_sessions
             WHERE date_iso != '' AND (
                 CAST(substr(date_iso, 1, 4) AS INTEGER) NOT BETWEEN 2000 AND 2100
              OR CAST(substr(date_iso, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
              OR CAST(substr(date_iso, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
             )",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for path in bad {
        let date = date_from_path_or_mtime(Path::new(&path));
        conn.execute(
            "UPDATE transcript_sessions SET date_iso = ?1 WHERE path = ?2",
            params![date, path],
        )?;
    }
    Ok(())
}

/// Build the transcript index on a background thread (own connection, off the
/// shared `Db` mutex), run the archive pass, then emit `transcripts://indexed`.
/// Coalesced — overlapping calls collapse to the one in-flight pass.
pub fn index_transcripts_bg<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if TRANSCRIPT_INDEXING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mem_root = crate::settings::resolved_memory_root(&app);
        let tx_root = transcripts_root_from_settings(&app);
        // Own connection to the same index DB (WAL + busy_timeout via init_db), so
        // the long parse never holds the shared mutex the read commands use.
        match crate::search::init_db(&mem_root) {
            Ok(conn) => {
                if let Err(e) = build_transcript_index(&tx_root, &conn) {
                    log::warn!("[transcripts] background index failed: {e}");
                }
                if let Err(e) = repair_implausible_dates(&conn) {
                    log::warn!("[transcripts] date repair failed: {e}");
                }
                maybe_archive_pass(&app, &tx_root, &conn);
            }
            Err(e) => log::error!("[transcripts] index db open failed: {e}"),
        }
        TRANSCRIPT_INDEXING.store(false, Ordering::SeqCst);
        let _ = app.emit("transcripts://indexed", ());
    });
}

/// Kick a background transcript reindex. Returns immediately; the cached reads
/// are already current, and the UI refetches on the `transcripts://indexed`
/// event when fresh data lands.
#[tauri::command]
pub fn refresh_transcripts<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    index_transcripts_bg(app);
    Ok(())
}

/// Walk `root`, yielding `(project_name, path_to_jsonl)` for every TOP-LEVEL
/// session `.jsonl` directly inside a project dir. Subagent sidecar files (under
/// a `subagents/` directory and/or named `agent-*.jsonl`) are NEVER yielded as
/// standalone sessions (TIN-1721). Hidden files/dirs are skipped.
pub(crate) fn collect_jsonl_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut results = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return results,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let project = name_str.to_string();
        collect_top_level_sessions(&project_path, &project, &mut results);
    }
    results
}

/// Collect only the TOP-LEVEL session files directly inside a project dir.
/// Per-session subagent files live in `<sessionId>/subagents/` and are skipped
/// here (they are stitched in by `get_session` and folded into FTS separately).
fn collect_top_level_sessions(project_dir: &Path, project: &str, out: &mut Vec<(String, PathBuf)>) {
    let entries = match fs::read_dir(project_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let p = entry.path();
        // Only direct-child `.jsonl` files that are not sidecars.
        if p.is_file() && name_str.ends_with(".jsonl") && !is_subagent_path(&p) {
            out.push((project.to_string(), p));
        }
        // Note: we deliberately do NOT recurse into `<sessionId>/` subdirs; a
        // session's subagents are resolved on demand from the session path.
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_transcript_projects(
    db: State<'_, Db>,
) -> Result<Vec<TranscriptProject>, String> {
    // Pure cached read — indexing runs in the background (see index_transcripts_bg).
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;

    // One row per project: count, latest date, and a representative cwd (the cwd
    // of the most recent session, so the frontend can show a real path).
    let mut stmt = conn
        .prepare(
            "SELECT project, COUNT(*) AS cnt, MAX(date_iso) AS last,
                    (SELECT cwd FROM transcript_sessions s2
                     WHERE s2.project = s1.project
                     ORDER BY date_iso DESC, path DESC LIMIT 1) AS cwd
             FROM transcript_sessions s1
             GROUP BY project
             ORDER BY last DESC, project ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok(TranscriptProject {
                project: r.get::<_, String>(0)?,
                session_count: r.get::<_, i64>(1)? as usize,
                last_date: r.get::<_, String>(2)?,
                cwd: r.get::<_, String>(3).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }
    Ok(projects)
}

#[tauri::command]
pub fn list_sessions(
    payload: ListSessionsInput,
    db: State<'_, Db>,
) -> Result<Vec<SessionSummary>, String> {
    // Pure cached read — indexing runs in the background (see index_transcripts_bg).
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;

    // An empty/absent project means "all projects": drop the WHERE clause so the
    // list spans every project, newest first (mirrors list_transcript_projects).
    let project_filter = payload.project.trim();
    let all_projects = project_filter.is_empty();

    // Select cached metric columns alongside the basics. Metrics are nullable
    // for rows indexed before TIN-1725 — those get lazy backfill below.
    let sql = if all_projects {
        "SELECT path, project, date_iso, first_msg, cwd, mtime,
                turn_count, subagent_count,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                models
         FROM transcript_sessions
         ORDER BY date_iso DESC, path DESC"
    } else {
        "SELECT path, project, date_iso, first_msg, cwd, mtime,
                turn_count, subagent_count,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                models
         FROM transcript_sessions
         WHERE project = ?1
         ORDER BY date_iso DESC, path DESC"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    // Row type: (path, project, date, first_msg, cwd, mtime,
    //            turn_count?, subagent_count?,
    //            input_tokens?, output_tokens?,
    //            cache_creation_input_tokens?, cache_read_input_tokens?,
    //            models?)
    type RawRow = (
        String, String, String, String, String, i64,
        Option<i64>, Option<i64>,
        Option<i64>, Option<i64>,
        Option<i64>, Option<i64>,
        Option<String>,
    );
    let map_row = |r: &rusqlite::Row| {
        Ok::<RawRow, rusqlite::Error>((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
            r.get::<_, String>(4).unwrap_or_default(),
            r.get::<_, i64>(5).unwrap_or(0),
            r.get(6)?, r.get(7)?,
            r.get(8)?, r.get(9)?,
            r.get(10)?, r.get(11)?,
            r.get(12)?,
        ))
    };
    let base: Vec<RawRow> = if all_projects {
        stmt.query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![project_filter], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut sessions = Vec::with_capacity(base.len());
    for (path, project, date, first_message, stored_cwd, _mtime,
         turn_count_opt, subagent_count_opt,
         input_opt, output_opt, cc_opt, cr_opt, models_opt) in base
    {
        let (subagent_count, turn_count, usage, models, cwd) =
            if let (Some(tc), Some(sc), Some(it), Some(ot), Some(cc), Some(cr), Some(ms)) = (
                turn_count_opt, subagent_count_opt,
                input_opt, output_opt, cc_opt, cr_opt, models_opt.as_deref(),
            ) {
                // Cache hit: build from stored values.
                let models: Vec<String> =
                    serde_json::from_str(ms).unwrap_or_default();
                let usage = UsageRollup {
                    input_tokens: it as u64,
                    output_tokens: ot as u64,
                    cache_creation_input_tokens: cc as u64,
                    cache_read_input_tokens: cr as u64,
                };
                (sc as usize, tc as usize, usage, models, stored_cwd)
            } else {
                // Lazy backfill: row predates TIN-1725 or was never fully indexed.
                let p = PathBuf::from(&path);
                let (sc, tc, u, m, c) = compute_session_metrics(&p);
                let models_json =
                    serde_json::to_string(&m).unwrap_or_else(|_| "[]".to_string());
                let file_mtime = mtime_secs(&p) as i64;
                let _ = conn.execute(
                    "UPDATE transcript_sessions SET
                        turn_count=?1, subagent_count=?2,
                        input_tokens=?3, output_tokens=?4,
                        cache_creation_input_tokens=?5, cache_read_input_tokens=?6,
                        models=?7, mtime=?8
                     WHERE path=?9",
                    params![
                        tc as i64, sc as i64,
                        u.input_tokens as i64, u.output_tokens as i64,
                        u.cache_creation_input_tokens as i64,
                        u.cache_read_input_tokens as i64,
                        models_json, file_mtime,
                        path,
                    ],
                );
                let cwd_out = if c.is_empty() { stored_cwd } else { c };
                (sc, tc, u, m, cwd_out)
            };

        sessions.push(SessionSummary {
            path,
            project,
            date,
            first_message,
            cwd,
            subagent_count,
            turn_count,
            usage,
            models,
        });
    }
    Ok(sessions)
}

#[tauri::command]
pub fn get_session<R: tauri::Runtime>(
    payload: GetSessionInput,
    app: tauri::AppHandle<R>,
) -> Result<Vec<Turn>, String> {
    let path = PathBuf::from(&payload.path);
    let transcripts_root = transcripts_root_from_settings(&app);
    let archive_root = crate::archive::archive_root(&app)?;
    let ctx = ReadCtx {
        transcripts_root: &transcripts_root,
        archive_root: &archive_root,
    };

    // Live file present → freshest read. Otherwise fall back to the archive (the
    // .zst may still exist after Claude Code pruned the live transcript).
    if path.exists() {
        return Ok(build_threaded_turns_ctx(&path, Some(ctx)));
    }
    if let Some(archived) =
        crate::archive::live_to_archived(&path, &transcripts_root, &archive_root)
    {
        if archived.exists() {
            return Ok(build_threaded_turns_ctx(&path, Some(ctx)));
        }
    }
    Err(format!("session file not found: {}", payload.path))
}

#[tauri::command]
pub fn search_transcripts(
    payload: SearchTranscriptsInput,
    db: State<'_, Db>,
) -> Result<Vec<TranscriptSearchResult>, String> {
    // Pure cached read — indexing runs in the background (see index_transcripts_bg).
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;

    let q = payload.q.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let fts_query = format!("\"{}\"*", q.replace('"', "\"\""));
    let mut stmt = conn
        .prepare(
            "SELECT tf.project, tf.path_ref,
                    snippet(transcript_fts, 2, '', '', '…', 20) AS snippet
             FROM transcript_fts tf
             WHERE transcript_fts MATCH ?1
             ORDER BY rank
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![fts_query], |r| {
            Ok(TranscriptSearchResult {
                project: r.get(0)?,
                session_path: r.get(1)?,
                snippet: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

/// Return per-day session counts for the given project.
///
/// Reuses the indexed `transcript_sessions` table (same index that
/// `list_sessions` reads). Groups rows by `date_iso`, ordered ascending,
/// so the frontend can build a calendar grid without further sorting.
#[tauri::command]
pub fn sessions_by_day(
    payload: SessionsByDayInput,
    db: State<'_, Db>,
) -> Result<Vec<DayCount>, String> {
    // Pure cached read — indexing runs in the background (see index_transcripts_bg).
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;

    // Empty/absent project → all-projects calendar (drop the WHERE project).
    let project_filter = payload.project.trim();
    let all_projects = project_filter.is_empty();

    let sql = if all_projects {
        "SELECT date_iso, COUNT(*) AS cnt
         FROM transcript_sessions
         WHERE date_iso != ''
         GROUP BY date_iso
         ORDER BY date_iso ASC"
    } else {
        "SELECT date_iso, COUNT(*) AS cnt
         FROM transcript_sessions
         WHERE project = ?1 AND date_iso != ''
         GROUP BY date_iso
         ORDER BY date_iso ASC"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let map_row = |r: &rusqlite::Row| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?));
    let rows: Vec<(String, i64)> = if all_projects {
        stmt.query_map([], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![project_filter], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut result = Vec::new();
    for (date, count) in rows {
        result.push(DayCount { date, count: count as usize });
    }
    Ok(result)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("transcript-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_jsonl(dir: &Path, name: &str, content: &str) {
        let p = dir.join(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn parse_flat_human_line() {
        let line = r#"{"role":"human","content":"hello world"}"#;
        let (role, text, has_tool, _) = parse_line(line).unwrap();
        assert_eq!(role, "human");
        assert_eq!(text, "hello world");
        assert!(!has_tool);
    }

    #[test]
    fn parse_wrapped_assistant_line() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]}}"#;
        let (role, text, _, _) = parse_line(line).unwrap();
        assert_eq!(role, "assistant");
        assert_eq!(text, "hi there");
    }

    #[test]
    fn parse_tool_use_block() {
        let line = r#"{"role":"assistant","content":[{"type":"text","text":"sure"},{"type":"tool_use","name":"Bash","input":{}}]}"#;
        let (_, text, has_tool, summary) = parse_line(line).unwrap();
        assert_eq!(text, "sure");
        assert!(has_tool);
        assert!(summary.contains("Bash"));
    }

    #[test]
    fn index_and_project_list() {
        let root = temp_root("projects");
        write_jsonl(
            &root,
            "attic/20260101T120000-abc.jsonl",
            "{\"role\":\"human\",\"content\":\"hello attic\"}\n{\"role\":\"assistant\",\"content\":\"hi\"}",
        );
        write_jsonl(
            &root,
            "studio/20260618T090000-def.jsonl",
            "{\"role\":\"human\",\"content\":\"hello studio\"}",
        );
        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT project, COUNT(*) FROM transcript_sessions GROUP BY project ORDER BY project")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "attic");
        assert_eq!(rows[1].0, "studio");
    }

    #[test]
    fn fts_search_finds_content() {
        let root = temp_root("fts");
        write_jsonl(
            &root,
            "attic/20260101T000000-x.jsonl",
            "{\"role\":\"human\",\"content\":\"rusqlite is great\"}",
        );
        write_jsonl(
            &root,
            "attic/20260102T000000-y.jsonl",
            "{\"role\":\"human\",\"content\":\"something unrelated\"}",
        );
        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        let fts_q = "\"rusqlite\"*";
        let mut stmt = conn
            .prepare("SELECT path_ref FROM transcript_fts WHERE transcript_fts MATCH ?1")
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map(params![fts_q], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(paths.len(), 1);
        assert!(paths[0].contains("x.jsonl"));
    }

    #[test]
    fn date_from_filename() {
        let p = PathBuf::from("/some/path/20260618T143022-abc.jsonl");
        assert_eq!(date_from_path_or_mtime(&p), "2026-06-18");
    }

    #[test]
    fn date_rejects_uuid_that_is_not_a_real_date() {
        // A UUID whose first 8 chars are all digits but form an impossible date
        // (month 96, day 99) must NOT be parsed as a date — it falls to mtime.
        // The file does not exist, so mtime also fails → empty (never "6043-96-99").
        let p = PathBuf::from("/some/path/60439699-7856-4bcd-af23-873720680000.jsonl");
        let got = date_from_path_or_mtime(&p);
        assert_ne!(got, "6043-96-99", "impossible date must be rejected");
        assert!(
            got.is_empty(),
            "no valid filename date + missing file → empty, got {got:?}"
        );
    }

    #[test]
    fn repair_fixes_implausible_cached_dates() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // A row left by the old bug, plus a good one.
        conn.execute(
            "INSERT INTO transcript_sessions (path, project, date_iso, mtime) VALUES
                ('/p/bad.jsonl', 'p', '6043-96-99', 0),
                ('/p/good.jsonl', 'p', '2026-06-18', 0)",
            [],
        )
        .unwrap();
        repair_implausible_dates(&conn).unwrap();
        let bad: String = conn
            .query_row(
                "SELECT date_iso FROM transcript_sessions WHERE path = '/p/bad.jsonl'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The bad path has no filename date and the file is missing → recomputes
        // to empty (no longer the garbage "6043-96-99").
        assert_ne!(bad, "6043-96-99", "implausible date repaired");
        let good: String = conn
            .query_row(
                "SELECT date_iso FROM transcript_sessions WHERE path = '/p/good.jsonl'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(good, "2026-06-18", "valid date left untouched");
    }

    #[test]
    fn shorten_tool_name_strips_prefix() {
        assert_eq!(shorten_tool_name("mcp__TalkToFigma__create_frame"), "Create_frame");
        assert_eq!(shorten_tool_name("Bash"), "Bash");
    }

    // ── TIN-1721 / TIN-1725 tests ───────────────────────────────────────────

    /// Build a realistic session with subagents on disk. Returns the root and
    /// the parent session path. The session id is `sess1`.
    fn write_session_with_subagents(root: &Path) -> PathBuf {
        // Parent top-level session (main thread). Includes a Task tool_use and
        // an assistant usage line.
        let parent = "proj/sess1.jsonl";
        let parent_body = concat!(
            r#"{"isSidechain":false,"type":"user","uuid":"u1","parentUuid":null,"cwd":"/Users/rob/Dev/demo","message":{"role":"user","content":"do a thing"}}"#, "\n",
            r#"{"isSidechain":false,"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":1},"content":[{"type":"text","text":"spawning"},{"type":"tool_use","id":"toolu_ABC","name":"Task","input":{"subagent_type":"Explore","description":"look around"}}]}}"#, "\n"
        );
        write_jsonl(root, parent, parent_body);

        // Subagent jsonl under sess1/subagents/agent-<id>.jsonl.
        let agent = "proj/sess1/subagents/agent-deadbeef.jsonl";
        let agent_body = concat!(
            r#"{"isSidechain":true,"type":"user","uuid":"su1","parentUuid":null,"agentId":"deadbeef","sessionId":"sess1","message":{"role":"user","content":"controller prompt to subagent"}}"#, "\n",
            r#"{"isSidechain":true,"type":"assistant","uuid":"sa1","parentUuid":"su1","agentId":"deadbeef","sessionId":"sess1","message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":200,"cache_creation_input_tokens":50,"cache_read_input_tokens":3},"content":[{"type":"text","text":"subagent found rusqlite-secret-token here"}]}}"#, "\n"
        );
        write_jsonl(root, agent, agent_body);

        // Sidecar meta.json with the spawn linkage.
        let meta = root.join("proj/sess1/subagents/agent-deadbeef.meta.json");
        fs::write(
            &meta,
            r#"{"agentType":"Explore","description":"look around","toolUseId":"toolu_ABC"}"#,
        )
        .unwrap();

        root.join(parent)
    }

    #[test]
    fn list_sessions_excludes_sidecars_includes_parent() {
        let root = temp_root("sidecar-exclude");
        write_session_with_subagents(&root);

        let collected = collect_jsonl_files(&root);
        // Exactly one top-level session, and it's sess1.jsonl (no agent-* file).
        assert_eq!(collected.len(), 1, "only the parent session is a session");
        let (_, p) = &collected[0];
        assert!(p.ends_with("sess1.jsonl"));
        assert!(!collected
            .iter()
            .any(|(_, p)| p.to_string_lossy().contains("agent-")));
    }

    #[test]
    fn get_session_stitches_subagent_turns() {
        let root = temp_root("stitch");
        let parent = write_session_with_subagents(&root);

        let turns = build_threaded_turns(&parent);
        // Main thread turns first (not sidechain), then subagent turns.
        let main: Vec<&Turn> = turns.iter().filter(|t| !t.is_sidechain).collect();
        let sub: Vec<&Turn> = turns.iter().filter(|t| t.is_sidechain).collect();
        assert!(!main.is_empty(), "has a main thread");
        assert_eq!(sub.len(), 2, "two subagent turns stitched in");

        // Subagent turns carry agent_id + label + spawned_by.
        for t in &sub {
            assert_eq!(t.agent_id.as_deref(), Some("deadbeef"));
            assert_eq!(t.agent_label.as_deref(), Some("look around"));
            assert_eq!(t.spawned_by.as_deref(), Some("toolu_ABC"));
        }
    }

    #[test]
    fn subagent_count_counts_distinct_agents() {
        let root = temp_root("subcount");
        let parent = write_session_with_subagents(&root);
        let (count, _turns, _u, _m, _cwd) = compute_session_metrics(&parent);
        assert_eq!(count, 1);

        // A session with no subagents → 0.
        write_jsonl(
            &root,
            "proj/lonely.jsonl",
            r#"{"isSidechain":false,"type":"user","uuid":"x","cwd":"/tmp","message":{"role":"user","content":"hi"}}"#,
        );
        let (c2, _, _, _, _) = compute_session_metrics(&root.join("proj/lonely.jsonl"));
        assert_eq!(c2, 0);
    }

    #[test]
    fn usage_rollup_sums_main_and_subagents() {
        let root = temp_root("usage");
        let parent = write_session_with_subagents(&root);
        let (_c, _t, usage, models, _cwd) = compute_session_metrics(&parent);
        // main: in10/out20/cc5/cr1 ; sub: in100/out200/cc50/cr3
        assert_eq!(usage.input_tokens, 110);
        assert_eq!(usage.output_tokens, 220);
        assert_eq!(usage.cache_creation_input_tokens, 55);
        assert_eq!(usage.cache_read_input_tokens, 4);
        // distinct models across main + subagent.
        assert!(models.contains(&"claude-opus-4-8".to_string()));
        assert!(models.contains(&"claude-sonnet-4-6".to_string()));
        assert_eq!(models.len(), 2);
    }

    #[test]
    fn cwd_populated_from_first_line_metadata() {
        let root = temp_root("cwd");
        let parent = write_session_with_subagents(&root);
        assert_eq!(cwd_from_session(&parent), "/Users/rob/Dev/demo");
        let (_, _, _, _, cwd) = compute_session_metrics(&parent);
        assert_eq!(cwd, "/Users/rob/Dev/demo");
    }

    #[test]
    fn fts_subagent_hit_resolves_to_parent_path() {
        let root = temp_root("fts-sub");
        let parent = write_session_with_subagents(&root);
        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        // The token only exists in the SUBAGENT body.
        let fts_q = "\"rusqlite-secret-token\"*";
        let mut stmt = conn
            .prepare("SELECT path_ref FROM transcript_fts WHERE transcript_fts MATCH ?1")
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map(params![fts_q], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(paths.len(), 1, "one hit");
        // It must resolve to the PARENT session path, never the sidecar file.
        assert_eq!(paths[0], parent.to_string_lossy());
        assert!(!paths[0].contains("agent-"));
        assert!(!paths[0].contains("subagents"));
    }

    // ── TIN-1751 all-projects list / calendar tests ─────────────────────────

    /// Query the session table the way `list_sessions` does: all projects when
    /// `project` is empty, otherwise filtered. Returns (path, project) rows in
    /// the same order the command emits.
    fn list_session_rows(conn: &Connection, project: &str) -> Vec<(String, String)> {
        let all = project.trim().is_empty();
        let sql = if all {
            "SELECT path, project FROM transcript_sessions ORDER BY date_iso DESC, path DESC"
        } else {
            "SELECT path, project FROM transcript_sessions WHERE project = ?1 ORDER BY date_iso DESC, path DESC"
        };
        let mut stmt = conn.prepare(sql).unwrap();
        let map = |r: &rusqlite::Row| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?));
        if all {
            stmt.query_map([], map).unwrap().filter_map(Result::ok).collect()
        } else {
            stmt.query_map(params![project], map).unwrap().filter_map(Result::ok).collect()
        }
    }

    #[test]
    fn list_sessions_empty_project_spans_all_projects() {
        let root = temp_root("all-projects-list");
        write_jsonl(
            &root,
            "attic/20260101T120000-a.jsonl",
            r#"{"role":"human","content":"hello attic"}"#,
        );
        write_jsonl(
            &root,
            "studio/20260618T090000-b.jsonl",
            r#"{"role":"human","content":"hello studio"}"#,
        );
        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        // Empty project → both sessions, newest (studio, Jun 18) first.
        let all = list_session_rows(&conn, "");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].1, "studio");
        assert_eq!(all[1].1, "attic");

        // A real project → only its rows, and each carries its project key.
        let only = list_session_rows(&conn, "attic");
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].1, "attic");
    }

    #[test]
    fn sessions_by_day_empty_project_spans_all_projects() {
        let root = temp_root("all-projects-day");
        // Two projects, both on the same day, plus a second day in one project.
        write_jsonl(&root, "attic/20260618T010000-a.jsonl", r#"{"role":"human","content":"x"}"#);
        write_jsonl(&root, "studio/20260618T020000-b.jsonl", r#"{"role":"human","content":"y"}"#);
        write_jsonl(&root, "studio/20260619T030000-c.jsonl", r#"{"role":"human","content":"z"}"#);
        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        // All-projects: Jun 18 has 2 (one per project), Jun 19 has 1.
        let mut stmt = conn
            .prepare(
                "SELECT date_iso, COUNT(*) FROM transcript_sessions
                 WHERE date_iso != '' GROUP BY date_iso ORDER BY date_iso ASC",
            )
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows, vec![
            ("2026-06-18".to_string(), 2),
            ("2026-06-19".to_string(), 1),
        ]);
    }

    // ── TIN-1752 image block tests ──────────────────────────────────────────

    #[test]
    fn parse_image_block_base64() {
        let line = r#"{"role":"user","content":[{"type":"text","text":"see attached"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}"#;
        let p = parse_line_full(line).unwrap();
        assert_eq!(p.images.len(), 1);
        assert_eq!(p.images[0].media_type, "image/png");
        assert_eq!(p.images[0].data, "iVBORw0KGgo=");
        assert_eq!(p.content, "see attached");
    }

    #[test]
    fn parse_no_image_block() {
        let line = r#"{"role":"human","content":"plain text only"}"#;
        let p = parse_line_full(line).unwrap();
        assert!(p.images.is_empty());
    }

    #[test]
    fn parse_image_oversized_dropped() {
        // Create a data string just over 2_621_440 chars (the cap).
        let big = "A".repeat(2_621_441);
        let line = format!(
            r#"{{"role":"user","content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{big}"}}}}]}}"#
        );
        // Should degrade: the line has a content block with no text, so parse_line_full
        // may return None (no text AND no tool_use). That's acceptable degradation.
        // If it returns Some, images must be empty.
        if let Some(p) = parse_line_full(&line) {
            assert!(p.images.is_empty(), "oversized image must be dropped");
        }
    }

    #[test]
    fn parse_malformed_image_block() {
        // Missing source field — should not crash, image is silently ignored.
        let line = r#"{"role":"user","content":[{"type":"image"},{"type":"text","text":"ok"}]}"#;
        let p = parse_line_full(line).unwrap();
        assert!(p.images.is_empty());
        assert_eq!(p.content, "ok");
    }

    // ── TIN-1725 metric caching tests ───────────────────────────────────────

    /// Helper: read cached metric columns from the DB for `path`.
    fn read_cached_metrics(
        conn: &Connection,
        path: &str,
    ) -> Option<(i64, i64, i64, i64, i64, i64, String)> {
        conn.query_row(
            "SELECT turn_count, subagent_count,
                    input_tokens, output_tokens,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    models
             FROM transcript_sessions WHERE path = ?1",
            params![path],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?.unwrap_or(-1),
                    r.get::<_, Option<i64>>(1)?.unwrap_or(-1),
                    r.get::<_, Option<i64>>(2)?.unwrap_or(-1),
                    r.get::<_, Option<i64>>(3)?.unwrap_or(-1),
                    r.get::<_, Option<i64>>(4)?.unwrap_or(-1),
                    r.get::<_, Option<i64>>(5)?.unwrap_or(-1),
                    r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                ))
            },
        )
        .ok()
    }

    /// After indexing, the DB must hold the correct metrics even if the JSONL
    /// file is subsequently deleted (proves the cache is the source of truth).
    #[test]
    fn cached_metrics_survive_file_deletion() {
        let root = temp_root("cache-delete");
        let parent_path = write_session_with_subagents(&root);
        let path_str = parent_path.to_string_lossy().to_string();

        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        // Verify metrics were stored in the DB.
        let m = read_cached_metrics(&conn, &path_str)
            .expect("metrics should be cached after indexing");
        // main: input10/output20/cc5/cr1 ; sub: input100/output200/cc50/cr3
        assert_eq!(m.2, 110, "input_tokens");
        assert_eq!(m.3, 220, "output_tokens");
        assert_eq!(m.4, 55,  "cache_creation_input_tokens");
        assert_eq!(m.5, 4,   "cache_read_input_tokens");
        assert!(m.1 >= 1, "subagent_count >= 1");

        // NOW delete the JSONL file.
        fs::remove_file(&parent_path).unwrap();
        assert!(!parent_path.exists());

        // Metrics in DB must still be correct — list_sessions reads the cache.
        let m2 = read_cached_metrics(&conn, &path_str)
            .expect("metrics still in DB after file deleted");
        assert_eq!(m2.2, 110, "input_tokens unchanged after deletion");
        assert_eq!(m2.3, 220, "output_tokens unchanged after deletion");
    }

    /// Rows with NULL metric columns (pre-TIN-1725 entries) get lazily filled
    /// on the first list_sessions call. We directly INSERT a row without metrics,
    /// then call list_sessions logic via `read_cached_metrics` after a lazy fill.
    #[test]
    fn lazy_backfill_populates_null_metric_rows() {
        let root = temp_root("lazy-backfill");
        let parent_path = write_session_with_subagents(&root);
        let path_str = parent_path.to_string_lossy().to_string();
        let current_mtime = mtime_secs(&parent_path) as i64;

        let conn = mem_db();
        // Insert the row WITHOUT metric columns (simulates a pre-TIN-1725 row).
        conn.execute(
            "INSERT INTO transcript_sessions (path, project, date_iso, mtime, first_msg, cwd)
             VALUES (?1, 'proj', '2026-06-01', ?2, 'do a thing', '/tmp')",
            params![path_str, current_mtime],
        )
        .unwrap();

        // Verify metrics are NULL.
        let (tc, sc, it, ot, cc, cr, ms) =
            read_cached_metrics(&conn, &path_str).unwrap();
        assert_eq!(tc, -1, "turn_count should be NULL before backfill");
        assert_eq!(sc, -1, "subagent_count should be NULL before backfill");

        // Simulate what list_sessions does on a NULL row: compute and write back.
        let (subagent_count, turn_count, usage, models, _cwd) =
            compute_session_metrics(&parent_path);
        let models_json = serde_json::to_string(&models).unwrap_or_default();
        conn.execute(
            "UPDATE transcript_sessions SET
                turn_count=?1, subagent_count=?2,
                input_tokens=?3, output_tokens=?4,
                cache_creation_input_tokens=?5, cache_read_input_tokens=?6,
                models=?7
             WHERE path=?8",
            params![
                turn_count as i64, subagent_count as i64,
                usage.input_tokens as i64, usage.output_tokens as i64,
                usage.cache_creation_input_tokens as i64,
                usage.cache_read_input_tokens as i64,
                models_json, path_str,
            ],
        )
        .unwrap();

        // After backfill the metrics must be correct.
        let (tc2, sc2, it2, ot2, cc2, cr2, ms2) =
            read_cached_metrics(&conn, &path_str).unwrap();
        assert!(tc2 > 0, "turn_count populated: {tc2}");
        assert_eq!(sc2, 1, "subagent_count");
        assert_eq!(it2, 110, "input_tokens");
        assert_eq!(ot2, 220, "output_tokens");
        assert_eq!(cc2, 55,  "cache_creation_input_tokens");
        assert_eq!(cr2, 4,   "cache_read_input_tokens");
        let parsed_models: Vec<String> = serde_json::from_str(&ms2).unwrap_or_default();
        assert_eq!(parsed_models.len(), 2, "two distinct models");

        // Suppress unused-variable warnings from the first read.
        let _ = (it, ot, cc, cr, ms);
    }

    /// When a file's mtime changes, re-indexing must recompute and overwrite
    /// the cached metrics with updated values.
    #[test]
    fn mtime_change_triggers_metric_recompute() {
        let root = temp_root("mtime-recompute");
        let parent_path = write_session_with_subagents(&root);
        let path_str = parent_path.to_string_lossy().to_string();

        let conn = mem_db();
        build_transcript_index(&root, &conn).unwrap();

        // Confirm initial metrics.
        let m1 = read_cached_metrics(&conn, &path_str).unwrap();
        assert_eq!(m1.2, 110, "initial input_tokens");

        // Overwrite the file with new content (just the main thread, 1 simple turn,
        // different token counts) and bump its mtime by touching it.
        let new_body = concat!(
            r#"{"isSidechain":false,"type":"user","uuid":"u2","parentUuid":null,"cwd":"/tmp","message":{"role":"user","content":"new content"}}"#, "\n",
            r#"{"isSidechain":false,"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","model":"claude-haiku","usage":{"input_tokens":5,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"ok"}]}}"#, "\n"
        );
        fs::write(&parent_path, new_body).unwrap();
        // Remove the subagent dir so count/tokens are purely from the new main body.
        let subagents_dir = parent_path
            .parent()
            .unwrap()
            .join(parent_path.file_stem().unwrap())
            .join("subagents");
        if subagents_dir.exists() {
            fs::remove_dir_all(&subagents_dir).unwrap();
        }

        // Force a different mtime by manipulating the stored value in the DB
        // (file system mtime resolution may be 1 s, so we fake the DB side).
        conn.execute(
            "UPDATE transcript_sessions SET mtime = 0 WHERE path = ?1",
            params![path_str],
        )
        .unwrap();

        // Re-index — should detect mtime mismatch and recompute.
        build_transcript_index(&root, &conn).unwrap();

        let m2 = read_cached_metrics(&conn, &path_str).unwrap();
        assert_eq!(m2.2, 5,  "input_tokens after recompute");
        assert_eq!(m2.3, 10, "output_tokens after recompute");
        assert_eq!(m2.4, 0,  "cache_creation after recompute");
    }
}
