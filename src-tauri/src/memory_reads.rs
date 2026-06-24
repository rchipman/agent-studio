//! memory_reads.rs
//!
//! Read-tracking for memory notes (TIN-1745). Records how many times a note
//! has been surfaced — either via the `recall` CLI subcommand or via a GUI
//! open — so a future salience signal can weight notes the agent or human
//! returns to most often.
//!
//! **Design constraints**
//! - One row per note (path is the PK), UPSERTed on each read. No per-event
//!   rows: reads are high-volume and the aggregate is all Phase 2 needs.
//! - Lives in the SAME `.studio-index.db` the rest of the app uses (the
//!   managed `search::Db` connection). No second DB, no new crate.
//! - Schema is lazily ensured via the same `ensure_*` pattern as
//!   `memory_audit.rs` — safe to call repeatedly, idempotent.
//! - The reads data is in a separate table and NEVER enters the searchable
//!   `memory_files` / `memory_fts` tables (it is not memory content).

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::search::Db;

// ── Schema ───────────────────────────────────────────────────────────────────

const READS_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS memory_reads (
        path         TEXT PRIMARY KEY,
        read_count   INTEGER NOT NULL DEFAULT 0,
        last_read_ts TEXT NOT NULL
    );
";

/// Ensure the `memory_reads` table exists on the connection. Idempotent
/// (`IF NOT EXISTS`). Mirrors the lazy-ensure pattern from `memory_audit.rs`.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(READS_SCHEMA)
}

// ── Core read operations (free functions, testable without Tauri state) ───────

/// UPSERT one read for `path` at `ts` (an RFC 3339 / ISO 8601 string):
/// - First read for a path → inserts with `read_count = 1`.
/// - Subsequent reads → increments `read_count` and updates `last_read_ts`.
///
/// Ensures the schema before operating so callers don't have to.
pub fn record_read(conn: &Connection, path: &str, ts: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "INSERT INTO memory_reads (path, read_count, last_read_ts)
         VALUES (?1, 1, ?2)
         ON CONFLICT(path) DO UPDATE SET
           read_count   = read_count + 1,
           last_read_ts = excluded.last_read_ts",
        params![path, ts],
    )?;
    Ok(())
}

/// The aggregate read stats for a single note. `None` when the path has never
/// been seen.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadStats {
    pub read_count: i64,
    pub last_read_ts: String,
}

/// Look up the aggregate read stats for `path`. Returns `None` for an
/// unknown path. Pure of Tauri state for testing.
pub fn get_reads(conn: &Connection, path: &str) -> rusqlite::Result<Option<ReadStats>> {
    use rusqlite::OptionalExtension;
    ensure_schema(conn)?;
    conn.query_row(
        "SELECT read_count, last_read_ts FROM memory_reads WHERE path = ?1",
        params![path],
        |r| {
            Ok(ReadStats {
                read_count: r.get(0)?,
                last_read_ts: r.get(1)?,
            })
        },
    )
    .optional()
}

/// Return the top `k` most-read notes, ordered by `read_count` descending.
/// For Phase 2 salience signal — callers can ask for the hottest notes to
/// boost their rank. Returns up to `k` rows; fewer if fewer exist.
pub fn top_reads(conn: &Connection, k: usize) -> rusqlite::Result<Vec<(String, ReadStats)>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT path, read_count, last_read_ts
         FROM memory_reads
         ORDER BY read_count DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![k as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            ReadStats {
                read_count: r.get(1)?,
                last_read_ts: r.get(2)?,
            },
        ))
    })?;
    rows.collect()
}

// ── IPC type ─────────────────────────────────────────────────────────────────

/// Input for `record_note_open`. Matches the project IPC convention: commands
/// take a single `payload` struct (camelCase on the wire).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordNoteOpenInput {
    pub path: String,
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Record a GUI open of a memory note. Called fire-and-forget from the
/// frontend's `loadFile` path; never blocks the UI.
#[tauri::command]
pub fn record_note_open(payload: RecordNoteOpenInput, db: State<'_, Db>) -> Result<(), String> {
    let ts = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    record_read(&conn, &payload.path, &ts).map_err(|e| e.to_string())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory connection with just the reads schema applied. Mirrors the
    /// `mem_db()` helper in `memory_audit.rs`.
    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn record_read_inserts_then_increments() {
        let conn = mem_db();
        let ts1 = "2026-06-24T10:00:00Z";
        let ts2 = "2026-06-24T11:00:00Z";

        // First read → inserts with count 1.
        record_read(&conn, "studio/pricing.md", ts1).unwrap();
        let stats = get_reads(&conn, "studio/pricing.md").unwrap().expect("row exists after first read");
        assert_eq!(stats.read_count, 1, "first read inserts with count 1");
        assert_eq!(stats.last_read_ts, ts1, "last_read_ts set on first read");

        // Second read → count goes to 2, ts updates.
        record_read(&conn, "studio/pricing.md", ts2).unwrap();
        let stats2 = get_reads(&conn, "studio/pricing.md").unwrap().expect("row still exists");
        assert_eq!(stats2.read_count, 2, "second read increments count to 2");
        assert_eq!(stats2.last_read_ts, ts2, "last_read_ts updated to the newer timestamp");
    }

    #[test]
    fn get_reads_returns_none_for_unknown_path() {
        let conn = mem_db();
        // Insert a row for a different path so the table is not empty.
        record_read(&conn, "studio/a.md", "2026-06-24T10:00:00Z").unwrap();
        let result = get_reads(&conn, "studio/nope.md").unwrap();
        assert!(result.is_none(), "unknown path returns None: {result:?}");
    }

    #[test]
    fn top_reads_orders_by_count_desc() {
        let conn = mem_db();
        let ts = "2026-06-24T10:00:00Z";

        // a.md: 3 reads, b.md: 1 read, c.md: 2 reads
        for _ in 0..3 {
            record_read(&conn, "a.md", ts).unwrap();
        }
        record_read(&conn, "b.md", ts).unwrap();
        for _ in 0..2 {
            record_read(&conn, "c.md", ts).unwrap();
        }

        let top = top_reads(&conn, 3).unwrap();
        assert_eq!(top.len(), 3, "all three paths returned");
        assert_eq!(top[0].0, "a.md", "most-read note first");
        assert_eq!(top[0].1.read_count, 3);
        assert_eq!(top[1].0, "c.md", "second most-read note second");
        assert_eq!(top[1].1.read_count, 2);
        assert_eq!(top[2].0, "b.md", "least-read note last");
        assert_eq!(top[2].1.read_count, 1);
    }

    #[test]
    fn top_reads_respects_limit() {
        let conn = mem_db();
        let ts = "2026-06-24T10:00:00Z";
        for i in 0..5_u32 {
            // Give each note a distinct count so the order is deterministic.
            for _ in 0..=i {
                record_read(&conn, &format!("note-{i}.md"), ts).unwrap();
            }
        }
        let top = top_reads(&conn, 2).unwrap();
        assert_eq!(top.len(), 2, "limit caps the result set");
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        // Calling ensure_schema twice on the same connection must not error.
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap(); // idempotent
        record_read(&conn, "x.md", "2026-06-24T00:00:00Z").unwrap();
        let s = get_reads(&conn, "x.md").unwrap().unwrap();
        assert_eq!(s.read_count, 1);
    }
}
