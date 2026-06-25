//! suggestions.rs
//!
//! Ambient frontmatter suggestions — the persistent per-note suggestion store +
//! the incremental monitor that keeps it current (TIN-1762).
//!
//! It mirrors ambient consistency (`consistency.rs`, TIN-1761) one-for-one:
//!
//!   - The per-note confidence suggester (`frontmatter::suggest_one`, TIN-1758)
//!     computes a `ConfidenceResult` for one note on demand. On its own it forgets
//!     everything the moment it returns. Ambient suggestions makes that durable and
//!     incremental.
//!   - A persistent table, `frontmatter_suggestions`, holds ONE row per note that
//!     currently HAS a pending suggestion (i.e. its frontmatter is incomplete),
//!     keyed by `path`. A complete note has NO row.
//!   - A [`SuggesterMonitor`] handler rides TIN-1763's maintenance dispatch: on
//!     every note add/edit/delete it refreshes just that note's suggestion row,
//!     using `suggest_one`. It is content-hash cached, so an unchanged incomplete
//!     note is never recomputed.
//!   - The seed itself IS the existing streaming bulk pass — `suggest_all` still
//!     streams `suggest://result` and honours Stop, but it now ALSO upserts each
//!     `ConfidenceResult` into the table (and drops rows for notes that came back
//!     complete). After the seed, the ambient monitor maintains the table.
//!
//! Everything is degrade-safe: with no reasoning model `suggest_one` returns a
//! rules+path result (`degraded: true`) rather than erroring, so the monitor always
//! has a usable result to upsert and never blocks or fails the index pass.

use rusqlite::{params, Connection};
use tauri::State;

use crate::frontmatter::{audit_one, suggest_one, ConfidenceResult};
use crate::maintenance::{ChangeKind, MaintenanceHandler, NoteChange};
use crate::memory_audit::content_hash;
use crate::search::Db;

// ── Schema ──────────────────────────────────────────────────────────────────

const SUGGESTIONS_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS frontmatter_suggestions (
        path         TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL DEFAULT '',
        result_json  TEXT NOT NULL,
        overall      REAL NOT NULL DEFAULT 0,
        degraded     INTEGER NOT NULL DEFAULT 0,
        created_ts   TEXT NOT NULL DEFAULT ''
    );
";

/// Ensure the persistent suggestions table exists. Idempotent; called from the
/// maintenance `ensure_schema` path so the store is present before the monitor's
/// first dispatch and before any read command.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SUGGESTIONS_SCHEMA)
}

// ── Store helpers ─────────────────────────────────────────────────────────────

/// Delete the suggestion row for a path (the note became complete, or was
/// deleted). No-op if there was no row.
fn clear_path(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM frontmatter_suggestions WHERE path = ?1",
        params![path],
    )?;
    Ok(())
}

/// The stored content hash for a path, if a row exists. Used to skip recompute
/// when an incomplete note is re-indexed without its body changing.
fn stored_hash(conn: &Connection, path: &str) -> Option<String> {
    conn.query_row(
        "SELECT content_hash FROM frontmatter_suggestions WHERE path = ?1",
        params![path],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Upsert one suggestion row keyed by path: the serialized `ConfidenceResult`
/// plus its `overall`/`degraded` and the body's content hash for skip-if-unchanged.
fn upsert_suggestion(
    conn: &Connection,
    result: &ConfidenceResult,
    hash: &str,
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(result).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(e))
    })?;
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO frontmatter_suggestions
            (path, content_hash, result_json, overall, degraded, created_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            result_json  = excluded.result_json,
            overall      = excluded.overall,
            degraded     = excluded.degraded,
            created_ts   = excluded.created_ts",
        params![
            result.path,
            hash,
            json,
            result.overall as f64,
            result.degraded as i64,
            ts
        ],
    )?;
    Ok(())
}

// ── The monitor handler ───────────────────────────────────────────────────────

/// Incremental frontmatter-suggestion monitor. Registered in
/// `maintenance::default_handlers`, it refreshes one note's suggestion row on
/// every change so `frontmatter_suggestions` always reflects the *current* set of
/// notes that need a suggestion, without a full re-pass.
///
///   - **Added | Edited:** audit the note. If it is `complete`, drop any existing
///     row (nothing to suggest). Otherwise, if a row exists keyed by the same
///     `content_hash`, skip (cached, unchanged). Otherwise run `suggest_one` and
///     upsert the `ConfidenceResult`.
///   - **Deleted:** drop the row.
///
/// `suggest_one` is async; we drive it on a current-thread runtime the same way
/// `consistency.rs::refresh` drives `score_content_conn`. With no reasoning model
/// it degrades to a rules+path result (`degraded: true`) — so the handler always
/// upserts a usable row and never errors.
pub struct SuggesterMonitor;

impl SuggesterMonitor {
    /// Audit `path`/`content`; refresh its suggestion row accordingly. Factored
    /// out so the runtime-driving + DB work is testable without the dispatch.
    fn refresh(conn: &Connection, path: &str, content: &str) -> rusqlite::Result<()> {
        // Complete frontmatter → no suggestion; drop any stale row and return.
        let audit = audit_one(path, content);
        if audit.status == "complete" {
            return clear_path(conn, path);
        }

        // Incomplete: skip recompute if we already cached this exact body.
        let hash = content_hash(content);
        if stored_hash(conn, path).as_deref() == Some(hash.as_str()) {
            return Ok(());
        }

        // Drive the async suggester synchronously on a current-thread runtime
        // (the index pass that called us is itself synchronous). A runtime build
        // failure is non-fatal — log and leave the row as-is.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::warn!("[suggestions] runtime build failed for {path}: {e}");
                return Ok(());
            }
        };

        // The memory root and known projects, resolved from the index DB so the
        // path-derived project hint works the same as the command path. Defaults
        // cover the common case; a failed lookup just means rules-only.
        let root = crate::settings::default_memory_root();
        let known = known_projects(conn);

        // No reasoning model is started/awaited from inside the index pass; the
        // suggester degrades to rules+path with `model_up = false`. This keeps the
        // monitor bounded and never blocks on a network round-trip.
        let result = rt.block_on(suggest_one(
            path,
            content,
            &today(),
            &root,
            &known,
            false,
        ));

        upsert_suggestion(conn, &result, &hash)
    }
}

impl MaintenanceHandler for SuggesterMonitor {
    fn name(&self) -> &'static str {
        "SuggesterMonitor"
    }

    fn on_change(&self, conn: &Connection, change: &NoteChange) -> rusqlite::Result<()> {
        match change.kind {
            ChangeKind::Added | ChangeKind::Edited => {
                let content = change.content.as_deref().unwrap_or("");
                Self::refresh(conn, &change.path, content)
            }
            ChangeKind::Deleted => clear_path(conn, &change.path),
        }
    }
}

/// Today as `YYYY-MM-DD`, matching the suggester's date convention.
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Known project names: the default domains plus any distinct `projects` already
/// in the index. Mirrors `frontmatter::known_projects` but takes a borrowed
/// connection (the monitor already holds the DB lock).
fn known_projects(conn: &Connection) -> Vec<String> {
    const DEFAULTS: &[&str] =
        &["attic", "understory", "rearview", "website", "studio", "shared"];
    let mut set: Vec<String> = DEFAULTS.iter().map(|s| s.to_string()).collect();
    if let Ok(mut stmt) =
        conn.prepare("SELECT DISTINCT projects FROM memory_files WHERE projects != ''")
    {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for joined in rows.flatten() {
                for p in joined.split(',').filter(|s| !s.is_empty()) {
                    if !set.iter().any(|x| x == p) {
                        set.push(p.to_string());
                    }
                }
            }
        }
    }
    set
}

// ── Seed persistence (called from `suggest_all`) ──────────────────────────────

/// Persist one streamed `ConfidenceResult` into the table during the seed pass:
/// upsert the row keyed by path (with a fresh content hash from the note body).
/// `body` is the raw note content the suggestion was computed from.
///
/// The bulk pass (`suggest_all`) only ever produces results for INCOMPLETE notes,
/// so every result here is a real pending suggestion. Complete notes are never
/// streamed, but `seed_clear_complete` reconciles any stale rows for them.
pub fn persist_seed_result(
    conn: &Connection,
    result: &ConfidenceResult,
    body: &str,
) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    upsert_suggestion(conn, result, &content_hash(body))
}

/// Drop the suggestion row for a path that came back complete during the seed
/// (or any reconciliation). Keeps the table free of rows for healthy notes.
pub fn seed_clear_complete(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    clear_path(conn, path)
}

// ── Read commands (for the Fields UI) ─────────────────────────────────────────

/// Read every persisted suggestion back into the `ConfidenceResult` shape the
/// Fields view already consumes, so the view renders pre-computed suggestions
/// instead of recomputing. Order is stable (by `path`).
#[tauri::command]
pub fn all_suggestions(db: State<'_, Db>) -> Result<Vec<ConfidenceResult>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_suggestions(&conn).map_err(|e| e.to_string())
}

/// Core of [`all_suggestions`], taking a borrowed connection so it is unit
/// testable without Tauri state.
fn read_suggestions(conn: &Connection) -> rusqlite::Result<Vec<ConfidenceResult>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT result_json FROM frontmatter_suggestions ORDER BY path",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let json = row?;
        // A row that fails to deserialize is skipped rather than failing the read
        // (a schema drift on an old row must not blank the whole rail).
        match serde_json::from_str::<ConfidenceResult>(&json) {
            Ok(r) => out.push(r),
            Err(e) => log::warn!("[suggestions] skipping unparseable row: {e}"),
        }
    }
    Ok(out)
}

/// Status for the Fields rail count.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsStatus {
    /// Number of notes with a pending suggestion.
    pub count: usize,
}

/// Report how many notes currently have a pending suggestion.
#[tauri::command]
pub fn suggestions_status(db: State<'_, Db>) -> Result<SuggestionsStatus, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let count: usize = conn
        .query_row("SELECT COUNT(*) FROM frontmatter_suggestions", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())? as usize;
    Ok(SuggestionsStatus { count })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::Suggestion;
    use std::collections::HashMap;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    /// Helper: (path, content_hash, overall, degraded) rows, ordered by path.
    fn rows(conn: &Connection) -> Vec<(String, String, f64, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT path, content_hash, overall, degraded
                 FROM frontmatter_suggestions ORDER BY path",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// A note body with NO frontmatter → audit `missing` → has a suggestion.
    const INCOMPLETE: &str = "# A Note\n\nJust a body, no frontmatter at all.";
    /// A note body with COMPLETE frontmatter → no suggestion.
    const COMPLETE: &str =
        "---\nname: a\ntype: feedback\nprojects: studio\ncreated: 2026-06-22\nstatus: active\n---\nbody";

    fn dummy_result(path: &str, overall: f32, degraded: bool) -> ConfidenceResult {
        ConfidenceResult {
            path: path.to_string(),
            suggestion: Suggestion::default(),
            fields: HashMap::new(),
            overall,
            degraded,
        }
    }

    fn changed(path: &str, kind: ChangeKind, content: Option<&str>) -> NoteChange {
        NoteChange {
            path: path.to_string(),
            kind,
            content: content.map(|s| s.to_string()),
        }
    }

    // ── upsert / clear primitives ─────────────────────────────────────────────

    #[test]
    fn upsert_then_clear_round_trips() {
        let conn = mem_db();
        let r = dummy_result("/m/a.md", 0.8, true);
        upsert_suggestion(&conn, &r, "h1").unwrap();
        assert_eq!(rows(&conn).len(), 1);
        assert_eq!(rows(&conn)[0].1, "h1");
        // Re-upsert with a new hash overwrites the same row.
        upsert_suggestion(&conn, &r, "h2").unwrap();
        let rs = rows(&conn);
        assert_eq!(rs.len(), 1, "same path → one row");
        assert_eq!(rs[0].1, "h2");
        clear_path(&conn, "/m/a.md").unwrap();
        assert!(rows(&conn).is_empty());
    }

    // ── Monitor: incomplete note → upsert keyed by path ───────────────────────

    #[test]
    fn monitor_added_upserts_suggestion_for_incomplete_note() {
        let conn = mem_db();
        let monitor = SuggesterMonitor;
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Added, Some(INCOMPLETE)))
            .unwrap();
        let rs = rows(&conn);
        assert_eq!(rs.len(), 1, "an incomplete note gets a row");
        assert_eq!(rs[0].0, "/m/a.md");
        // No reasoning model in tests → degraded result persisted.
        assert_eq!(rs[0].3, 1, "no model → degraded=true persisted");
        // The cached hash matches the body, enabling skip-if-unchanged.
        assert_eq!(rs[0].1, content_hash(INCOMPLETE));
    }

    // ── Monitor: a now-complete note has its row deleted ──────────────────────

    #[test]
    fn monitor_edited_to_complete_deletes_row() {
        let conn = mem_db();
        let monitor = SuggesterMonitor;
        // First it is incomplete → row created.
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Added, Some(INCOMPLETE)))
            .unwrap();
        assert_eq!(rows(&conn).len(), 1);
        // Then it is edited to be complete → row dropped.
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Edited, Some(COMPLETE)))
            .unwrap();
        assert!(rows(&conn).is_empty(), "complete note → no suggestion row");
    }

    // ── Monitor: unchanged incomplete note is skipped (no recompute) ──────────

    #[test]
    fn monitor_unchanged_hash_is_skipped() {
        let conn = mem_db();
        let monitor = SuggesterMonitor;
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Added, Some(INCOMPLETE)))
            .unwrap();
        // Stamp a sentinel created_ts we can detect a recompute by.
        conn.execute(
            "UPDATE frontmatter_suggestions SET created_ts = 'SENTINEL' WHERE path = '/m/a.md'",
            [],
        )
        .unwrap();
        // Re-dispatch the SAME body → hash matches → no recompute → ts untouched.
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Edited, Some(INCOMPLETE)))
            .unwrap();
        let ts: String = conn
            .query_row(
                "SELECT created_ts FROM frontmatter_suggestions WHERE path = '/m/a.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ts, "SENTINEL", "unchanged note must not be recomputed");
    }

    // ── Monitor: Deleted removes the row ──────────────────────────────────────

    #[test]
    fn monitor_deleted_removes_row() {
        let conn = mem_db();
        let monitor = SuggesterMonitor;
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Added, Some(INCOMPLETE)))
            .unwrap();
        assert_eq!(rows(&conn).len(), 1);
        monitor
            .on_change(&conn, &changed("/m/a.md", ChangeKind::Deleted, None))
            .unwrap();
        assert!(rows(&conn).is_empty(), "deleted note → row removed");
    }

    // ── Degrade path: no model still upserts and never errors ─────────────────

    #[test]
    fn monitor_degrades_without_model_and_never_errors() {
        let conn = mem_db();
        let monitor = SuggesterMonitor;
        let res =
            monitor.on_change(&conn, &changed("/m/new.md", ChangeKind::Added, Some(INCOMPLETE)));
        assert!(res.is_ok(), "degrade path must not error: {res:?}");
        let rs = rows(&conn);
        assert_eq!(rs.len(), 1, "rules+path result is still persisted");
        assert_eq!(rs[0].3, 1, "degraded=true with no model");
    }

    // ── Seed persistence helpers ──────────────────────────────────────────────

    #[test]
    fn persist_seed_result_upserts_with_body_hash() {
        let conn = mem_db();
        let r = dummy_result("/m/a.md", 0.7, false);
        persist_seed_result(&conn, &r, INCOMPLETE).unwrap();
        let rs = rows(&conn);
        assert_eq!(rs.len(), 1);
        assert_eq!(rs[0].1, content_hash(INCOMPLETE));
    }

    #[test]
    fn seed_clear_complete_drops_stale_row() {
        let conn = mem_db();
        upsert_suggestion(&conn, &dummy_result("/m/a.md", 0.5, false), "h").unwrap();
        seed_clear_complete(&conn, "/m/a.md").unwrap();
        assert!(rows(&conn).is_empty());
    }

    // ── Read commands round-trip ──────────────────────────────────────────────

    #[test]
    fn read_suggestions_round_trips_in_stable_order() {
        let conn = mem_db();
        upsert_suggestion(&conn, &dummy_result("/m/z.md", 0.4, true), "hz").unwrap();
        upsert_suggestion(&conn, &dummy_result("/m/a.md", 0.9, false), "ha").unwrap();
        let got = read_suggestions(&conn).unwrap();
        assert_eq!(got.len(), 2);
        // Ordered by path: a before z.
        assert_eq!(got[0].path, "/m/a.md");
        assert_eq!(got[0].overall, 0.9);
        assert!(!got[0].degraded);
        assert_eq!(got[1].path, "/m/z.md");
        assert!(got[1].degraded);
    }

    #[test]
    fn status_counts_pending_rows() {
        let conn = mem_db();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM frontmatter_suggestions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        upsert_suggestion(&conn, &dummy_result("/m/a.md", 0.5, false), "h1").unwrap();
        upsert_suggestion(&conn, &dummy_result("/m/b.md", 0.5, false), "h2").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM frontmatter_suggestions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }
}
