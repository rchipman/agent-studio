//! consistency.rs
//!
//! Ambient consistency — the persistent contradiction store + the incremental
//! monitor that keeps it current (TIN-1761).
//!
//! The Consistency Audit (`audit.rs`) is an all-pairs sweep the user kicks off
//! by hand; it streams findings and returns them, but it forgets everything the
//! moment it finishes. Ambient consistency makes that durable and incremental:
//!
//!   - A persistent table, `consistency_findings`, holds ONE row per current
//!     contradiction, keyed by the *unordered* note pair (so (a,b) == (b,a)).
//!   - A [`ConsistencyMonitor`] handler rides TIN-1763's maintenance dispatch:
//!     on every note add/edit/delete it refreshes just that note's findings,
//!     using the per-note continuity scorer (`continuity::score_content_conn`).
//!   - A tiny meta kv, `consistency_meta`, tracks whether the initial full sweep
//!     has run (`seeded`), so the UI knows "unseeded" vs "live".
//!   - The seed itself IS the existing streaming audit — `seed_consistency`
//!     runs `consistency_audit`, then persists every finding and flips `seeded`.
//!
//! Everything is degrade-safe: with no reasoning model the scorer returns no
//! conflicts (`degraded: true`), so the monitor simply writes nothing and never
//! errors. It must never block or fail the index pass.

use rusqlite::{params, Connection};
use tauri::State;

use crate::audit::Finding;
use crate::continuity::{score_content_conn, ScoreMemoryInput};
use crate::maintenance::{ChangeKind, MaintenanceHandler, NoteChange};
use crate::search::Db;

// ── Schema ──────────────────────────────────────────────────────────────────

const FINDINGS_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS consistency_findings (
        path_lo    TEXT NOT NULL,
        path_hi    TEXT NOT NULL,
        name_lo    TEXT NOT NULL DEFAULT '',
        name_hi    TEXT NOT NULL DEFAULT '',
        summary    TEXT NOT NULL DEFAULT '',
        created_ts TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (path_lo, path_hi)
    );
    CREATE TABLE IF NOT EXISTS consistency_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
    );
";

/// Ensure the persistent findings table and the meta kv exist. Idempotent;
/// called from the maintenance `ensure_schema` path so the store is present
/// before the monitor's first dispatch and before any read command.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(FINDINGS_SCHEMA)
}

// ── Sorted-pair keying ────────────────────────────────────────────────────────

/// Order the two note paths so an unordered pair maps to one stable key:
/// `(a,b)` and `(b,a)` both yield `(path_lo, path_hi)` with `path_lo <= path_hi`.
fn sorted_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Pair the display names in the SAME order the paths were sorted into, so
/// `name_lo` always belongs to `path_lo`.
fn sorted_names<'a>(
    path_a: &str,
    name_a: &'a str,
    path_b: &str,
    name_b: &'a str,
) -> (&'a str, &'a str) {
    if path_a <= path_b {
        (name_a, name_b)
    } else {
        (name_b, name_a)
    }
}

// ── Store helpers ─────────────────────────────────────────────────────────────

/// Delete every findings row that involves `path` on either side. Used to clear
/// a note's prior findings before recomputing them, and on delete.
fn clear_path(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM consistency_findings WHERE path_lo = ?1 OR path_hi = ?1",
        params![path],
    )?;
    Ok(())
}

/// Upsert one contradiction row, keyed by the sorted pair. A pair is stored once
/// regardless of which side was checked; re-checking overwrites the summary.
fn upsert_finding(
    conn: &Connection,
    path_a: &str,
    name_a: &str,
    path_b: &str,
    name_b: &str,
    summary: &str,
) -> rusqlite::Result<()> {
    let (path_lo, path_hi) = sorted_pair(path_a, path_b);
    let (name_lo, name_hi) = sorted_names(path_a, name_a, path_b, name_b);
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO consistency_findings
            (path_lo, path_hi, name_lo, name_hi, summary, created_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(path_lo, path_hi) DO UPDATE SET
            name_lo    = excluded.name_lo,
            name_hi    = excluded.name_hi,
            summary    = excluded.summary,
            created_ts = excluded.created_ts",
        params![path_lo, path_hi, name_lo, name_hi, summary, ts],
    )?;
    Ok(())
}

// ── Durable "seeded" flag ─────────────────────────────────────────────────────

/// Whether the initial full sweep has populated the table. Lives in the index DB
/// (persists across launches; resets to unseeded only if the DB is rebuilt from
/// scratch, which is acceptable — the UI offers a re-seed).
pub fn is_seeded(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM consistency_meta WHERE key = 'seeded'",
        [],
        |r| r.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}

/// Set (or clear) the durable `seeded` flag.
pub fn set_seeded(conn: &Connection, seeded: bool) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO consistency_meta (key, value) VALUES ('seeded', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![if seeded { "true" } else { "false" }],
    )?;
    Ok(())
}

// ── The monitor handler ───────────────────────────────────────────────────────

/// Incremental contradiction monitor. Registered in
/// `maintenance::default_handlers`, it refreshes one note's findings on every
/// change so `consistency_findings` always reflects the *current* state of the
/// base without a full re-sweep.
///
///   - **Added | Edited:** clear this note's prior findings, then re-score it
///     against its neighbours and upsert a row for each surviving conflict. A
///     conflict that no longer holds is therefore dropped; a pair is stored once.
///   - **Deleted:** drop every row involving the path.
///
/// `score_content_conn` is async; we drive it on a current-thread runtime the
/// same way the CLI's `run_add_memory` does. With no reasoning model it returns
/// no conflicts (`degraded`), so the handler adds nothing and never errors.
pub struct ConsistencyMonitor;

impl ConsistencyMonitor {
    /// Re-score `path`/`content` and persist its findings. Factored out so the
    /// runtime-driving + DB work is testable without the maintenance dispatch.
    fn refresh(conn: &Connection, path: &str, content: &str) -> rusqlite::Result<()> {
        // A changed note's findings are fully refreshed: clear, then re-add.
        clear_path(conn, path)?;

        // Drive the async scorer synchronously on a current-thread runtime
        // (the index pass that called us is itself synchronous). A runtime
        // build failure is non-fatal — log and add no findings.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::warn!("[consistency] runtime build failed for {path}: {e}");
                return Ok(());
            }
        };

        let score = rt.block_on(score_content_conn(
            conn,
            ScoreMemoryInput {
                content: content.to_string(),
                path: Some(path.to_string()),
            },
        ));

        let score = match score {
            Ok(s) => s,
            Err(e) => {
                // The scorer degrades on a missing model rather than erroring,
                // so a real Err here is unusual; log and leave findings cleared.
                log::warn!("[consistency] score failed for {path}: {e}");
                return Ok(());
            }
        };

        // The changed note's display name, for the row's name_lo/name_hi.
        let this_name: String = conn
            .query_row(
                "SELECT name FROM memory_files WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| path.rsplit('/').next().unwrap_or(path).to_string());

        for c in score.conflicts {
            upsert_finding(conn, path, &this_name, &c.path, &c.name, &c.why)?;
        }
        Ok(())
    }
}

impl MaintenanceHandler for ConsistencyMonitor {
    fn name(&self) -> &'static str {
        "ConsistencyMonitor"
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

// ── Seed = the all-pairs sweep, now persisting ────────────────────────────────

/// Seed the persistent store from a full all-pairs sweep.
///
/// This IS the existing streaming audit (`consistency_audit`) — it still emits
/// `audit://progress` / `audit://finding` and honours Stop/cancel — but it now
/// also writes every finding into `consistency_findings` (clearing the table
/// first) and flips `seeded = true` on completion. If the user Stops mid-seed,
/// the partial findings are persisted and `seeded` is STILL set, so the ambient
/// monitor takes over from that point rather than the view staying "unseeded".
#[tauri::command]
pub async fn seed_consistency(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    control: State<'_, crate::TaskControl>,
) -> Result<Vec<Finding>, String> {
    // Run the existing streaming sweep (returns partial findings on cancel).
    let findings = crate::audit::consistency_audit(app, db.clone(), control).await?;

    // Persist: clear the table, insert each finding keyed by sorted pair, then
    // mark seeded — even on a partial (Stopped) sweep, so the monitor takes over.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_schema(&conn).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM consistency_findings", [])
            .map_err(|e| e.to_string())?;
        for f in &findings {
            // A Finding carries files[2]/names[2]; persist keyed by sorted pair.
            let (pa, pb) = (
                f.files.first().cloned().unwrap_or_default(),
                f.files.get(1).cloned().unwrap_or_default(),
            );
            let (na, nb) = (
                f.names.first().cloned().unwrap_or_default(),
                f.names.get(1).cloned().unwrap_or_default(),
            );
            upsert_finding(&conn, &pa, &na, &pb, &nb, &f.summary).map_err(|e| e.to_string())?;
        }
        set_seeded(&conn, true).map_err(|e| e.to_string())?;
    }

    Ok(findings)
}

// ── Read commands (for the UI) ────────────────────────────────────────────────

/// Read the persistent findings table back into the existing [`Finding`] shape
/// so the frontend renders identically to a live audit. Order is stable
/// (`path_lo, path_hi`).
#[tauri::command]
pub fn consistency_findings(db: State<'_, Db>) -> Result<Vec<Finding>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_findings(&conn).map_err(|e| e.to_string())
}

/// Core of [`consistency_findings`], taking a borrowed connection so it is unit
/// testable without Tauri state.
fn read_findings(conn: &Connection) -> rusqlite::Result<Vec<Finding>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT path_lo, path_hi, name_lo, name_hi, summary
         FROM consistency_findings
         ORDER BY path_lo, path_hi",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Finding {
            files: vec![r.get::<_, String>(0)?, r.get::<_, String>(1)?],
            names: vec![r.get::<_, String>(2)?, r.get::<_, String>(3)?],
            summary: r.get::<_, String>(4)?,
        })
    })?;
    rows.collect()
}

/// Status for the rail badge + the view's state machine.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsistencyStatus {
    /// Whether the initial full sweep has run.
    pub seeded: bool,
    /// Number of current contradiction rows in the persistent table.
    pub count: usize,
}

/// Report whether the store has been seeded and how many findings it holds.
#[tauri::command]
pub fn consistency_status(db: State<'_, Db>) -> Result<ConsistencyStatus, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_schema(&conn).map_err(|e| e.to_string())?;
    let count: usize = conn
        .query_row("SELECT COUNT(*) FROM consistency_findings", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())? as usize;
    Ok(ConsistencyStatus {
        seeded: is_seeded(&conn),
        count,
    })
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

    /// Helper: every (path_lo, path_hi, name_lo, name_hi, summary) row, ordered.
    fn rows(conn: &Connection) -> Vec<(String, String, String, String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT path_lo, path_hi, name_lo, name_hi, summary
                 FROM consistency_findings ORDER BY path_lo, path_hi",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    // ── Sorted-pair keying ────────────────────────────────────────────────────

    #[test]
    fn sorted_pair_is_order_independent() {
        let (lo1, hi1) = sorted_pair("b.md", "a.md");
        let (lo2, hi2) = sorted_pair("a.md", "b.md");
        assert_eq!((lo1.clone(), hi1.clone()), (lo2, hi2));
        assert_eq!(lo1, "a.md");
        assert_eq!(hi1, "b.md");
    }

    #[test]
    fn sorted_names_follow_the_path_ordering() {
        // Names must travel with their paths so name_lo belongs to path_lo.
        let (n_lo, n_hi) = sorted_names("b.md", "Beta", "a.md", "Alpha");
        assert_eq!(n_lo, "Alpha"); // a.md sorts low → its name is name_lo
        assert_eq!(n_hi, "Beta");
    }

    #[test]
    fn upsert_stores_one_row_per_pair_regardless_of_order() {
        let conn = mem_db();
        // Insert (b,a) then re-check from the other side (a,b): one row, updated.
        upsert_finding(&conn, "b.md", "Beta", "a.md", "Alpha", "first").unwrap();
        upsert_finding(&conn, "a.md", "Alpha", "b.md", "Beta", "second").unwrap();
        let r = rows(&conn);
        assert_eq!(r.len(), 1, "a pair is stored once regardless of side");
        assert_eq!(r[0].0, "a.md");
        assert_eq!(r[0].1, "b.md");
        assert_eq!(r[0].2, "Alpha");
        assert_eq!(r[0].3, "Beta");
        assert_eq!(r[0].4, "second", "re-check overwrites the summary");
    }

    // ── clear_path ────────────────────────────────────────────────────────────

    #[test]
    fn clear_path_removes_all_rows_involving_the_path_either_side() {
        let conn = mem_db();
        upsert_finding(&conn, "a.md", "A", "b.md", "B", "ab").unwrap();
        upsert_finding(&conn, "c.md", "C", "a.md", "A", "ca").unwrap();
        upsert_finding(&conn, "b.md", "B", "c.md", "C", "bc").unwrap();
        // a.md appears as path_lo in (a,b) and as path_hi in (a,c) → both go.
        clear_path(&conn, "a.md").unwrap();
        let r = rows(&conn);
        assert_eq!(r.len(), 1, "only the b–c pair survives");
        assert_eq!((r[0].0.as_str(), r[0].1.as_str()), ("b.md", "c.md"));
    }

    // ── Monitor on Deleted ────────────────────────────────────────────────────

    #[test]
    fn monitor_deleted_removes_all_rows_involving_path() {
        let conn = mem_db();
        upsert_finding(&conn, "a.md", "A", "b.md", "B", "ab").unwrap();
        upsert_finding(&conn, "a.md", "A", "c.md", "C", "ac").unwrap();
        upsert_finding(&conn, "b.md", "B", "c.md", "C", "bc").unwrap();

        let monitor = ConsistencyMonitor;
        monitor
            .on_change(
                &conn,
                &NoteChange {
                    path: "a.md".to_string(),
                    kind: ChangeKind::Deleted,
                    content: None,
                },
            )
            .unwrap();

        let r = rows(&conn);
        assert_eq!(r.len(), 1, "every pair touching a.md is dropped");
        assert_eq!((r[0].0.as_str(), r[0].1.as_str()), ("b.md", "c.md"));
    }

    // ── Monitor refresh: replace prior findings, key by sorted pair ───────────
    //
    // `refresh` (and thus on_change for Added/Edited) drives the real scorer,
    // which with no reasoning model degrades to ZERO conflicts. So in the test
    // env the refresh path: (1) clears the note's prior findings, (2) adds none.
    // We assert exactly that — the degrade-safe behaviour the ticket calls out.

    #[test]
    fn monitor_edited_clears_prior_findings_and_degrades_to_none() {
        let conn = mem_db();
        // Seed two prior findings for a.md (as if from an earlier sweep).
        upsert_finding(&conn, "a.md", "A", "b.md", "B", "stale-ab").unwrap();
        upsert_finding(&conn, "a.md", "A", "c.md", "C", "stale-ac").unwrap();
        // An unrelated pair must survive (it does not involve a.md).
        upsert_finding(&conn, "b.md", "B", "c.md", "C", "bc").unwrap();

        let monitor = ConsistencyMonitor;
        monitor
            .on_change(
                &conn,
                &NoteChange {
                    path: "a.md".to_string(),
                    kind: ChangeKind::Edited,
                    content: Some("some new body".to_string()),
                },
            )
            .unwrap();

        let r = rows(&conn);
        // No model in test env → scorer degrades → a.md's prior findings are
        // cleared and none are re-added; the unrelated b–c pair is untouched.
        assert_eq!(r.len(), 1, "a.md's stale findings cleared, none re-added");
        assert_eq!((r[0].0.as_str(), r[0].1.as_str()), ("b.md", "c.md"));
    }

    #[test]
    fn monitor_added_degrades_without_error_and_adds_no_findings() {
        // The degrade path (no model) must add no findings and not error.
        let conn = mem_db();
        let monitor = ConsistencyMonitor;
        let res = monitor.on_change(
            &conn,
            &NoteChange {
                path: "new.md".to_string(),
                kind: ChangeKind::Added,
                content: Some("a brand new note".to_string()),
            },
        );
        assert!(res.is_ok(), "degrade path must not error: {res:?}");
        assert!(rows(&conn).is_empty(), "no model → no findings added");
    }

    // ── Seeded flag round-trip ─────────────────────────────────────────────────

    #[test]
    fn is_seeded_set_seeded_round_trip() {
        let conn = mem_db();
        assert!(!is_seeded(&conn), "fresh store is unseeded");
        set_seeded(&conn, true).unwrap();
        assert!(is_seeded(&conn), "set true → seeded");
        set_seeded(&conn, false).unwrap();
        assert!(!is_seeded(&conn), "set false → unseeded again");
    }

    // ── Read command core ──────────────────────────────────────────────────────

    #[test]
    fn read_findings_returns_finding_shape_in_stable_order() {
        let conn = mem_db();
        upsert_finding(&conn, "z.md", "Z", "a.md", "A", "za").unwrap();
        upsert_finding(&conn, "a.md", "A", "m.md", "M", "am").unwrap();
        let f = read_findings(&conn).unwrap();
        assert_eq!(f.len(), 2);
        // Ordered by (path_lo, path_hi): (a.md,m.md) before (a.md,z.md).
        assert_eq!(f[0].files, vec!["a.md".to_string(), "m.md".to_string()]);
        assert_eq!(f[0].names, vec!["A".to_string(), "M".to_string()]);
        assert_eq!(f[0].summary, "am");
        assert_eq!(f[1].files, vec!["a.md".to_string(), "z.md".to_string()]);
    }
}
