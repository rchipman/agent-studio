//! transcript.rs
//!
//! Reads Claude Code `.jsonl` session transcripts from the transcripts root
//! (default: `~/.claude/projects`), indexes their content into a separate
//! `transcript_fts` FTS5 table in the SAME `.studio-index.db` database as the
//! memory index, and exposes four Tauri commands:
//!
//!   - `list_transcript_projects` — project dirs + session counts + last date
//!   - `list_sessions`            — sessions in a project, newest first
//!   - `get_session`              — parsed turns from a single `.jsonl` file
//!   - `search_transcripts`       — FTS across all indexed transcript content
//!
//! The transcripts root is read from persisted settings at command invocation
//! time (not at startup), so it reflects changes made in the Settings modal
//! without requiring a restart.
//!
//! JSONL format (one JSON object per line):
//!   { "type": "human"|"assistant"|"...", "message": { ... } }
//! or (Claude Code format):
//!   { "role": "human"|"assistant", "content": "..." | [...] }
//!
//! The indexer is incremental: files already in the index (keyed by path +
//! mtime) are skipped.

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
        first_msg  TEXT NOT NULL DEFAULT ''
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
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(TRANSCRIPT_SCHEMA)
}

// ── Types returned to the frontend ──────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptProject {
    pub project: String,
    pub session_count: usize,
    pub last_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub date: String,
    pub first_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    /// Serialised as a JSON string to keep the IPC payload simple.
    /// The frontend parses this to get the display text.
    pub content: String,
    /// True when this turn contains tool calls / tool results.
    pub has_tool_use: bool,
    /// For tool-use turns: a short summary of the tool names used.
    pub tool_summary: String,
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

// ── JSONL parsing ─────────────────────────────────────────────────────────────

/// Extract the plain-text content and tool-use info from a single JSONL line.
/// Returns (role, text, has_tool_use, tool_summary).
fn parse_line(line: &str) -> Option<(String, String, bool, String)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;

    // Claude Code uses a wrapper object with a `type` field.
    // The inner message has `role` and `content`.
    let (role_raw, content_val) = if let Some(msg) = v.get("message") {
        let role = msg.get("role")
            .or_else(|| v.get("type"))
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_string();
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        (role, content)
    } else {
        // Flat format: { "role": "...", "content": "..." }
        let role = v.get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("unknown")
            .to_string();
        let content = v.get("content").cloned().unwrap_or(Value::Null);
        (role, content)
    };

    // Normalise role.
    let role = match role_raw.as_str() {
        "human" | "user" => "human".to_string(),
        "assistant" => "assistant".to_string(),
        _ => return None, // skip system messages, metadata lines, etc.
    };

    // Extract text and tool-use summary from content.
    let (text, has_tool_use, tool_summary) = extract_content(&content_val);

    if text.is_empty() && !has_tool_use {
        return None;
    }

    Some((role, text, has_tool_use, tool_summary))
}

/// Parse a `content` value (string or array of content blocks).
fn extract_content(content: &Value) -> (String, bool, String) {
    match content {
        Value::String(s) => (s.clone(), false, String::new()),
        Value::Array(blocks) => {
            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_names: Vec<String> = Vec::new();
            let mut has_tool_use = false;

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
                            // Shorten common tool names for the summary line.
                            let short = shorten_tool_name(name);
                            if !tool_names.contains(&short) {
                                tool_names.push(short);
                            }
                        }
                    }
                    "tool_result" => {
                        has_tool_use = true;
                    }
                    _ => {}
                }
            }

            let summary = tool_names.join(" · ");
            (text_parts.join("\n\n"), has_tool_use, summary)
        }
        _ => (String::new(), false, String::new()),
    }
}

fn shorten_tool_name(name: &str) -> String {
    // Strip common prefixes from MCP-style tool names.
    let stripped = name
        .trim_start_matches("mcp__")
        .trim_start_matches("mcp_");
    // Take the last segment after double underscores.
    let last = stripped.split("__").last().unwrap_or(stripped);
    // Title-case it.
    let mut chars = last.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

/// Read a .jsonl file and return the list of turns.
fn parse_session_file(path: &Path) -> Vec<Turn> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line)
        .map(|(role, content, has_tool_use, tool_summary)| Turn {
            role,
            content,
            has_tool_use,
            tool_summary,
        })
        .collect()
}

/// Extract the date (YYYY-MM-DD) from a session file path or its mtime.
fn date_from_path_or_mtime(path: &Path) -> String {
    // Claude Code names sessions like `20260618T143022-abc.jsonl`; parse date.
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
    // Fallback: file mtime.
    if let Ok(meta) = fs::metadata(path) {
        if let Ok(modified) = meta.modified() {
            use std::time::{Duration, UNIX_EPOCH};
            let secs = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_secs();
            // Simple yyyy-mm-dd from unix timestamp (approximate, UTC).
            let days = secs / 86400;
            // Days since epoch to yyyy-mm-dd (Gregorian).
            let (y, m, d) = days_to_ymd(days as u32);
            return format!("{y:04}-{m:02}-{d:02}");
        }
    }
    String::new()
}

/// Very simple epoch-days to (year, month, day) without external deps.
fn days_to_ymd(mut days: u32) -> (u32, u32, u32) {
    // Epoch = 1970-01-01
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
    let month_days: [u32; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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

// ── Indexing ─────────────────────────────────────────────────────────────────

/// Incrementally index all `.jsonl` files under `root`. Files already in the
/// index whose mtime has not changed are skipped. Uses a standalone FTS5 table
/// (no content= tracking) so FTS text is stored independently and can hold the
/// full session body rather than just first_msg.
fn build_transcript_index(root: &Path, conn: &Connection) -> rusqlite::Result<()> {
    ensure_schema(conn)?;

    let tx = conn.unchecked_transaction()?;
    {
        let mut check_mtime = tx.prepare(
            "SELECT mtime FROM transcript_sessions WHERE path = ?1",
        )?;
        let mut upsert_session = tx.prepare(
            "INSERT INTO transcript_sessions (path, project, date_iso, mtime, first_msg)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
               project=excluded.project,
               date_iso=excluded.date_iso,
               mtime=excluded.mtime,
               first_msg=excluded.first_msg",
        )?;
        let mut delete_fts = tx.prepare(
            "DELETE FROM transcript_fts WHERE path_ref = ?1",
        )?;
        let mut insert_fts = tx.prepare(
            "INSERT INTO transcript_fts (path_ref, project, body) VALUES (?1, ?2, ?3)",
        )?;

        for (project, jsonl_path) in collect_jsonl_files(root) {
            let current_mtime = mtime_secs(&jsonl_path);
            let path_str = jsonl_path.to_string_lossy().to_string();

            // Skip if mtime unchanged.
            let stored_mtime: Option<u64> = check_mtime
                .query_row(params![path_str], |r| r.get::<_, i64>(0))
                .ok()
                .map(|v| v as u64);

            if stored_mtime == Some(current_mtime) {
                continue;
            }

            let date = date_from_path_or_mtime(&jsonl_path);
            let turns = parse_session_file(&jsonl_path);

            let first_msg = turns
                .iter()
                .find(|t| t.role == "human")
                .map(|t| {
                    let s = t.content.trim();
                    if s.len() > 200 { &s[..200] } else { s }
                })
                .unwrap_or("")
                .to_string();

            // Full text for FTS: all turns joined.
            let full_text: String = turns
                .iter()
                .map(|t| t.content.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            // Remove stale session + FTS rows.
            delete_fts.execute(params![path_str])?;
            upsert_session.execute(params![
                path_str,
                project,
                date,
                current_mtime as i64,
                first_msg,
            ])?;
            insert_fts.execute(params![path_str, project, full_text])?;
        }
    }
    tx.commit()
}

/// Walk `root`, yielding `(project_name, path_to_jsonl)` for every `.jsonl`
/// under a direct subdirectory of root. Skips hidden files and directories.
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
        collect_jsonl_recursive(&project_path, &project, &mut results);
    }
    results
}

fn collect_jsonl_recursive(dir: &Path, project: &str, out: &mut Vec<(String, PathBuf)>) {
    let entries = match fs::read_dir(dir) {
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
        if p.is_dir() {
            collect_jsonl_recursive(&p, project, out);
        } else if name_str.ends_with(".jsonl") {
            out.push((project.to_string(), p));
        }
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

    // Read from the sessions table.
    let mut stmt = conn.prepare(
        "SELECT project, COUNT(*) as cnt, MAX(date_iso) as last
         FROM transcript_sessions
         GROUP BY project
         ORDER BY last DESC, project ASC",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? as usize,
            r.get::<_, String>(2)?,
        ))
    }).map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    for row in rows {
        let (project, session_count, last_date) = row.map_err(|e| e.to_string())?;
        projects.push(TranscriptProject { project, session_count, last_date });
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

    let mut stmt = conn.prepare(
        "SELECT path, date_iso, first_msg FROM transcript_sessions
         WHERE project = ?1
         ORDER BY date_iso DESC, path DESC",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![payload.project], |r| {
        Ok(SessionSummary {
            path: r.get(0)?,
            date: r.get(1)?,
            first_message: r.get(2)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| e.to_string())?);
    }
    Ok(sessions)
}

#[tauri::command]
pub fn get_session(payload: GetSessionInput) -> Result<Vec<Turn>, String> {
    let path = PathBuf::from(&payload.path);
    if !path.exists() {
        return Err(format!("session file not found: {}", payload.path));
    }
    Ok(parse_session_file(&path))
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
    // transcript_fts columns: 0=path_ref (UNINDEXED), 1=project (UNINDEXED), 2=body
    let mut stmt = conn.prepare(
        "SELECT tf.project, tf.path_ref,
                snippet(transcript_fts, 2, '', '', '…', 20) AS snippet
         FROM transcript_fts tf
         WHERE transcript_fts MATCH ?1
         ORDER BY rank
         LIMIT 50",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![fts_query], |r| {
        Ok(TranscriptSearchResult {
            project: r.get(0)?,
            session_path: r.get(1)?,
            snippet: r.get(2)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
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
}
