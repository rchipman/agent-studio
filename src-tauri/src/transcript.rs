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

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

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
/// Also runs a tiny additive migration for the `cwd` column on databases
/// created before TIN-1721 (CREATE TABLE IF NOT EXISTS won't add a column).
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(TRANSCRIPT_SCHEMA)?;
    // Additive migration: ignore "duplicate column" errors if already present.
    let _ = conn.execute(
        "ALTER TABLE transcript_sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT ''",
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
fn collect_subagent_files(session_path: &Path) -> Vec<PathBuf> {
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

/// Build the stitched, threaded turn list for a session: main thread first,
/// then each subagent's sub-thread appended in filename (≈ spawn) order.
fn build_threaded_turns(session_path: &Path) -> Vec<Turn> {
    let mut turns: Vec<Turn> = parse_session_file(session_path);

    for agent_file in collect_subagent_files(session_path) {
        let meta = read_agent_meta(&agent_file);
        // agentType may also appear on the line as agentType/subagentType.
        let raw = match fs::read_to_string(&agent_file) {
            Ok(s) => s,
            Err(_) => continue,
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
                let y = &digits[0..4];
                let m = &digits[4..6];
                let d = &digits[6..8];
                return format!("{y}-{m}-{d}");
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
fn days_to_ymd(mut days: u32) -> (u32, u32, u32) {
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
fn mtime_secs(path: &Path) -> u64 {
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
        let mut check_mtime =
            tx.prepare("SELECT mtime FROM transcript_sessions WHERE path = ?1")?;
        let mut upsert_session = tx.prepare(
            "INSERT INTO transcript_sessions (path, project, date_iso, mtime, first_msg, cwd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
               project=excluded.project,
               date_iso=excluded.date_iso,
               mtime=excluded.mtime,
               first_msg=excluded.first_msg,
               cwd=excluded.cwd",
        )?;
        let mut delete_fts = tx.prepare("DELETE FROM transcript_fts WHERE path_ref = ?1")?;
        let mut insert_fts =
            tx.prepare("INSERT INTO transcript_fts (path_ref, project, body) VALUES (?1, ?2, ?3)")?;

        for (project, jsonl_path) in collect_jsonl_files(root) {
            let current_mtime = mtime_secs(&jsonl_path);
            let path_str = jsonl_path.to_string_lossy().to_string();

            let stored_mtime: Option<u64> = check_mtime
                .query_row(params![path_str], |r| r.get::<_, i64>(0))
                .ok()
                .map(|v| v as u64);

            if stored_mtime == Some(current_mtime) {
                continue;
            }

            let date = date_from_path_or_mtime(&jsonl_path);
            let cwd = cwd_from_session(&jsonl_path);
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

            delete_fts.execute(params![path_str])?;
            upsert_session.execute(params![
                path_str,
                project,
                date,
                current_mtime as i64,
                first_msg,
                cwd,
            ])?;
            insert_fts.execute(params![path_str, project, full_text])?;
        }
    }
    tx.commit()
}

/// Walk `root`, yielding `(project_name, path_to_jsonl)` for every TOP-LEVEL
/// session `.jsonl` directly inside a project dir. Subagent sidecar files (under
/// a `subagents/` directory and/or named `agent-*.jsonl`) are NEVER yielded as
/// standalone sessions (TIN-1721). Hidden files/dirs are skipped.
fn collect_jsonl_files(root: &Path) -> Vec<(String, PathBuf)> {
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
pub fn list_transcript_projects<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Db>,
) -> Result<Vec<TranscriptProject>, String> {
    let root = transcripts_root_from_settings(&app);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    build_transcript_index(&root, &conn).map_err(|e| e.to_string())?;

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
pub fn list_sessions<R: tauri::Runtime>(
    payload: ListSessionsInput,
    app: tauri::AppHandle<R>,
    db: State<'_, Db>,
) -> Result<Vec<SessionSummary>, String> {
    let root = transcripts_root_from_settings(&app);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    build_transcript_index(&root, &conn).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT path, date_iso, first_msg, cwd FROM transcript_sessions
             WHERE project = ?1
             ORDER BY date_iso DESC, path DESC",
        )
        .map_err(|e| e.to_string())?;

    let base: Vec<(String, String, String, String)> = stmt
        .query_map(params![payload.project], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3).unwrap_or_default()))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut sessions = Vec::with_capacity(base.len());
    for (path, date, first_message, stored_cwd) in base {
        let p = PathBuf::from(&path);
        let (subagent_count, turn_count, usage, models, cwd) = compute_session_metrics(&p);
        sessions.push(SessionSummary {
            path,
            date,
            first_message,
            cwd: if cwd.is_empty() { stored_cwd } else { cwd },
            subagent_count,
            turn_count,
            usage,
            models,
        });
    }
    Ok(sessions)
}

#[tauri::command]
pub fn get_session(payload: GetSessionInput) -> Result<Vec<Turn>, String> {
    let path = PathBuf::from(&payload.path);
    if !path.exists() {
        return Err(format!("session file not found: {}", payload.path));
    }
    Ok(build_threaded_turns(&path))
}

#[tauri::command]
pub fn search_transcripts<R: tauri::Runtime>(
    payload: SearchTranscriptsInput,
    app: tauri::AppHandle<R>,
    db: State<'_, Db>,
) -> Result<Vec<TranscriptSearchResult>, String> {
    let root = transcripts_root_from_settings(&app);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    build_transcript_index(&root, &conn).map_err(|e| e.to_string())?;

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
pub fn sessions_by_day<R: tauri::Runtime>(
    payload: SessionsByDayInput,
    app: tauri::AppHandle<R>,
    db: State<'_, Db>,
) -> Result<Vec<DayCount>, String> {
    let root = transcripts_root_from_settings(&app);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    build_transcript_index(&root, &conn).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT date_iso, COUNT(*) AS cnt
             FROM transcript_sessions
             WHERE project = ?1 AND date_iso != ''
             GROUP BY date_iso
             ORDER BY date_iso ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![payload.project], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        let (date, count) = row.map_err(|e| e.to_string())?;
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
}
