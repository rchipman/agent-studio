//! memory_audit.rs
//!
//! Backend storage + commands for the memory audit trail (TIN-1728). Records
//! one row per change to a memory note — who changed it, when, an optional
//! continuity score, a short human summary, and a content hash — so the (future,
//! separate-ticket) history footer UI can show a per-note timeline.
//!
//! The audit table lives in the SAME `.studio-index.db` the rest of the app uses
//! (the managed `search::Db` connection); it does NOT open a second database.
//! Schema is created via the same `ensure_*` pattern as `transcript.rs` and the
//! `meta`/`chunks` tables in `search.rs`.
//!
//! Everything here is additive: no existing command, table, or type changes, so
//! the current frontend compiles unchanged. Callers are wired in their own
//! tickets (see the per-command comments).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::search::Db;

// ── Schema ───────────────────────────────────────────────────────────────────

const AUDIT_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS memory_audit (
        id               INTEGER PRIMARY KEY,
        path             TEXT NOT NULL,
        ts               TEXT NOT NULL DEFAULT '',
        actor_type       TEXT NOT NULL DEFAULT '',
        actor_id         TEXT NOT NULL DEFAULT '',
        continuity_score REAL,
        change_summary   TEXT NOT NULL DEFAULT '',
        content_hash     TEXT NOT NULL DEFAULT ''
    );

    -- Per-note history is the hot query (newest-first by path), so index path.
    CREATE INDEX IF NOT EXISTS memory_audit_path ON memory_audit(path);
";

/// Ensure the `memory_audit` table + index exist on the connection. Safe to call
/// repeatedly (idempotent `IF NOT EXISTS`). Follows the lazy-ensure pattern from
/// `transcript::ensure_schema`.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(AUDIT_SCHEMA)
}

// ── Content hash helper ──────────────────────────────────────────────────────

/// Stable SHA-256 hex digest of a note body, for callers to fill `content_hash`.
/// Reuses the existing `sha2` dependency (same hashing the embeddings cache uses
/// in `embeddings::fingerprint`) — no new crate. Deterministic: identical input
/// yields an identical hash; different input yields a different hash.
pub fn content_hash(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    format!("{:x}", h.finalize())
}

// ── IPC types ────────────────────────────────────────────────────────────────

/// Input for `record_memory_change`. Per the project IPC convention, commands
/// take a single `payload` struct.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMemoryChangeInput {
    pub path: String,
    /// One of `human` | `agent` | `external`.
    pub actor_type: String,
    pub actor_id: String,
    pub continuity_score: Option<f32>,
    pub change_summary: String,
    pub content_hash: String,
}

/// Input for `get_memory_history`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMemoryHistoryInput {
    pub path: String,
}

/// One row of a note's audit history, newest-first. (`content_hash` and `path`
/// are intentionally omitted — the footer UI shows actor + summary + score.)
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub ts: String,
    pub actor_type: String,
    pub actor_id: String,
    pub continuity_score: Option<f32>,
    pub change_summary: String,
}

// ── Pure DB ops (testable without Tauri state) ───────────────────────────────

/// Ensure the schema then insert one audit row, returning its new id. Free of
/// Tauri state so the headless `add-memory` endpoint (TIN-1731) can record an
/// `agent` audit row against a CLI-constructed connection.
pub fn record_change(conn: &Connection, input: &RecordMemoryChangeInput) -> rusqlite::Result<i64> {
    ensure_schema(conn)?;
    insert_change(conn, input)
}

/// Insert one audit row, returning its new id. `ts` is stamped here (UTC, RFC
/// 3339) so callers don't have to. Pure of Tauri state for testing.
fn insert_change(conn: &Connection, input: &RecordMemoryChangeInput) -> rusqlite::Result<i64> {
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO memory_audit
           (path, ts, actor_type, actor_id, continuity_score, change_summary, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            input.path,
            ts,
            input.actor_type,
            input.actor_id,
            input.continuity_score,
            input.change_summary,
            input.content_hash,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Read a note's audit history, newest-first (most recent change at index 0).
/// An unknown path yields an empty vec. Pure of Tauri state for testing.
fn history_for(conn: &Connection, path: &str) -> rusqlite::Result<Vec<AuditEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, ts, actor_type, actor_id, continuity_score, change_summary
         FROM memory_audit
         WHERE path = ?1
         ORDER BY id DESC",
    )?;
    let rows = stmt.query_map(params![path], |r| {
        Ok(AuditEntry {
            id: r.get(0)?,
            ts: r.get(1)?,
            actor_type: r.get(2)?,
            actor_id: r.get(3)?,
            continuity_score: r.get(4)?,
            change_summary: r.get(5)?,
        })
    })?;
    rows.collect()
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Record one change to a memory note, returning the new audit row id.
///
/// Callers (wired in their own tickets): the frontend save path, the file
/// watcher on external edits, and the memory-write endpoint will each call this
/// after a successful write.
#[tauri::command]
pub fn record_memory_change(
    payload: RecordMemoryChangeInput,
    db: State<'_, Db>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    insert_change(&conn, &payload).map_err(|e| e.to_string())
}

/// Return a note's change history, newest-first.
///
/// Caller (wired in its own ticket): the history-footer UI fetches this when a
/// note is opened to render the per-note timeline.
#[tauri::command]
pub fn get_memory_history(
    payload: GetMemoryHistoryInput,
    db: State<'_, Db>,
) -> Result<Vec<AuditEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    history_for(&conn, &payload.path).map_err(|e| e.to_string())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory connection with just the audit schema applied (the audit table
    /// is self-contained, so no full index schema is needed).
    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn record(
        path: &str,
        actor_type: &str,
        actor_id: &str,
        score: Option<f32>,
    ) -> RecordMemoryChangeInput {
        RecordMemoryChangeInput {
            path: path.to_string(),
            actor_type: actor_type.to_string(),
            actor_id: actor_id.to_string(),
            continuity_score: score,
            change_summary: format!("{actor_id} touched {path}"),
            content_hash: content_hash(path),
        }
    }

    #[test]
    fn history_returns_changes_newest_first() {
        let conn = mem_db();
        let id1 = insert_change(&conn, &record("a.md", "human", "rob", Some(0.9))).unwrap();
        let id2 = insert_change(&conn, &record("a.md", "agent", "poppy", Some(0.5))).unwrap();
        assert!(id2 > id1, "second insert gets a later id");

        let hist = history_for(&conn, "a.md").unwrap();
        assert_eq!(hist.len(), 2, "both changes recorded");
        // Newest-first: the agent change (inserted second) leads.
        assert_eq!(hist[0].id, id2);
        assert_eq!(hist[0].actor_type, "agent");
        assert_eq!(hist[0].actor_id, "poppy");
        assert_eq!(hist[1].id, id1);
        assert_eq!(hist[1].actor_type, "human");
        assert_eq!(hist[1].actor_id, "rob");
    }

    #[test]
    fn history_for_unknown_path_is_empty() {
        let conn = mem_db();
        insert_change(&conn, &record("a.md", "human", "rob", None)).unwrap();
        assert!(history_for(&conn, "nope.md").unwrap().is_empty(), "no rows for an unseen path");
    }

    #[test]
    fn continuity_score_round_trips_as_nullable() {
        let conn = mem_db();
        insert_change(&conn, &record("a.md", "agent", "poppy", Some(0.42))).unwrap();
        insert_change(&conn, &record("a.md", "external", "watcher", None)).unwrap();

        let hist = history_for(&conn, "a.md").unwrap();
        // Newest-first: the None (external) change leads, the scored one follows.
        assert_eq!(hist[0].continuity_score, None, "null score preserved");
        let scored = hist[1].continuity_score.expect("scored change keeps its value");
        assert!((scored - 0.42).abs() < 1e-6, "score value round-trips: {scored}");
    }

    #[test]
    fn content_hash_is_stable_and_distinct() {
        let a1 = content_hash("the body text");
        let a2 = content_hash("the body text");
        let b = content_hash("a different body");
        assert_eq!(a1, a2, "identical input → identical hash");
        assert_ne!(a1, b, "different input → different hash");
        // Hex SHA-256 is 64 chars.
        assert_eq!(a1.len(), 64, "sha-256 hex digest length");
    }
}
