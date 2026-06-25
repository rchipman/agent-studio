//! maintenance.rs
//!
//! Change-triggered background maintenance dispatch (TIN-1763).
//!
//! The MEMORY note index (`search::build_index`) is a FULL rebuild on every
//! call: it `DELETE`s `memory_files`/`memory_fts` and re-inserts every `.md`
//! file from disk. That is correct for search, but it throws away the one thing
//! ambient maintenance needs — *what actually changed since the last pass*.
//!
//! This module adds a thin change-detection layer that rides the existing index
//! pass and dispatches each per-note delta to a registry of maintenance
//! handlers. It is the shared hook the two ambient epics hang off:
//!
//!   - TIN-1761 (consistency): re-check a changed note for contradictions.
//!   - TIN-1762 (suggestions): re-suggest a changed note's frontmatter.
//!
//! Those real handlers are NOT built here. This ticket builds the hook, the
//! change-detection, the registry, the persistent-store pattern, and ONE
//! trivial proof handler (`NoteChangeLog`).
//!
//! ── Change detection ──────────────────────────────────────────────────────────
//! Modelled on the transcript index's mtime-keyed incremental pattern
//! (`transcript_sessions.mtime`). We keep a sidecar table `note_index_state`
//! keyed by note `path`, storing each note's last-seen `mtime` and body
//! `content_hash` (sha256, via `memory_audit::content_hash`). On an index pass:
//!
//!   - **Added** — path not in `note_index_state`.
//!   - **Edited** — path present, but hash OR mtime changed.
//!   - **Deleted** — path in `note_index_state` but no longer on disk.
//!
//! Detection is mtime/hash diff only — O(changed notes) dispatch, no content
//! parsing beyond the hash the indexer already computes from the parsed body.
//! After dispatch the table is reconciled (upsert seen notes, delete vanished
//! ones) so the next pass diffs correctly.
//!
//! ── Handler registry ──────────────────────────────────────────────────────────
//! A [`MaintenanceHandler`] sees one [`NoteChange`] at a time and runs
//! synchronously within the index pass (already off the UI thread — the index
//! runs under the `search::Db` mutex on whatever thread called `build_index`).
//! Handlers are registered in [`default_handlers`]. A handler that panics or
//! errors is logged and skipped — it never fails the index (degrade-safe).
//!
//! ── Persistent-store pattern (for real handlers) ──────────────────────────────
//! A handler that needs to remember per-note state owns its OWN table keyed by
//! `path`: upsert the row on `Added`/`Edited`, delete it on `Deleted`. The demo
//! [`NoteChangeLog`] handler shows the shape (it appends rather than upserts,
//! since it is an audit log, but the keying + delete-on-delete pattern is the
//! template). TIN-1761/1762 will each add their own such table.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};

use crate::memory_audit::content_hash;

// ── Change model ──────────────────────────────────────────────────────────────

/// The kind of change detected for a note between two index passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Edited,
    Deleted,
}

impl ChangeKind {
    /// Stable lowercase token for persistence / logging.
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Added => "added",
            ChangeKind::Edited => "edited",
            ChangeKind::Deleted => "deleted",
        }
    }
}

/// One detected per-note change, handed to every registered handler.
/// `content` is the parsed note body for `Added`/`Edited`, and `None` for
/// `Deleted` (the file is gone — there is nothing to read).
#[derive(Debug, Clone, PartialEq)]
pub struct NoteChange {
    pub path: String,
    pub kind: ChangeKind,
    pub content: Option<String>,
}

// ── Handler trait + registry ──────────────────────────────────────────────────

/// A maintenance task that reacts to a single note change. Implementors run
/// synchronously inside the index pass, on the same connection, so they MUST be
/// cheap and bounded. A handler may use `conn` to read/write its own
/// persistent-store table; it must not assume any other handler has run.
///
/// Errors are the handler's own concern up to a point: the dispatcher catches a
/// returned `Err` (and a panic) and logs it, so a misbehaving handler degrades
/// to a no-op instead of failing the index.
pub trait MaintenanceHandler: Send + Sync {
    /// Short identifier, used only in log lines.
    fn name(&self) -> &'static str;

    /// React to one note change. Return `Err` to signal failure; it is logged
    /// and swallowed, never propagated into the index.
    fn on_change(&self, conn: &Connection, change: &NoteChange) -> rusqlite::Result<()>;
}

/// The built-in handler registry. This is the registration point new ambient
/// maintenance tickets plug into: TIN-1761 and TIN-1762 each append their
/// handler here (and ensure their store exists via [`ensure_schema`] below).
///
/// Returned as owned boxes so the dispatcher can hold them for the pass without
/// borrowing global state. Cheap to build — one allocation per handler.
pub fn default_handlers() -> Vec<Box<dyn MaintenanceHandler>> {
    vec![
        Box::new(NoteChangeLog),
        Box::new(crate::consistency::ConsistencyMonitor),
    ]
}

// ── State table + schema ──────────────────────────────────────────────────────

const STATE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS note_index_state (
        path         TEXT PRIMARY KEY,
        mtime        INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT ''
    );
";

/// Ensure the change-detection state table AND every handler's own store exists.
/// Follows the lazy-ensure pattern from `transcript::ensure_schema` and
/// `memory_audit::ensure_schema`. Idempotent; safe to call on every pass.
///
/// New ambient handlers add their `CREATE TABLE IF NOT EXISTS` here (or call
/// their module's own `ensure_schema`) so the store exists before the first
/// dispatch.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(STATE_SCHEMA)?;
    NoteChangeLog::ensure_schema(conn)?;
    crate::consistency::ensure_schema(conn)?;
    Ok(())
}

/// A note's last-seen fingerprint as stored in `note_index_state`.
struct StoredState {
    mtime: i64,
    content_hash: String,
}

/// File-system mtime in whole seconds, mirroring `transcript::mtime_secs`.
fn mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64
        })
        .unwrap_or(0)
}

// ── Detection + dispatch ──────────────────────────────────────────────────────

/// The current on-disk view of one indexed note, supplied by `build_index`
/// (which already parsed the file). The body drives the content hash; the mtime
/// is read here to keep the indexer's call site small.
pub struct IndexedNote<'a> {
    pub path: &'a str,
    pub body: &'a str,
}

/// Detect the per-note delta against the stored state, dispatch each change to
/// every registered handler, then reconcile the state table.
///
/// `present` is the set of notes the current index pass just (re)indexed — for a
/// full rebuild that is every `.md` file on disk. Anything in `note_index_state`
/// that is NOT in `present` is treated as Deleted.
///
/// Returns the list of dispatched changes (handy for callers/tests). Never
/// errors on a handler failure — those are logged and skipped. A failure to
/// read/write the state table itself IS propagated (it would corrupt future
/// diffs), matching how the indexer surfaces SQLite errors elsewhere.
pub fn detect_and_dispatch(
    conn: &Connection,
    present: &[IndexedNote<'_>],
    handlers: &[Box<dyn MaintenanceHandler>],
) -> rusqlite::Result<Vec<NoteChange>> {
    ensure_schema(conn)?;

    // Load prior state once: path -> (mtime, hash).
    let mut prior: HashMap<String, StoredState> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT path, mtime, content_hash FROM note_index_state")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                StoredState {
                    mtime: r.get::<_, i64>(1)?,
                    content_hash: r.get::<_, String>(2)?,
                },
            ))
        })?;
        for row in rows {
            let (path, st) = row?;
            prior.insert(path, st);
        }
    }

    let mut changes: Vec<NoteChange> = Vec::new();
    // Track which prior paths we have seen so the leftovers are the deletions.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();

    // Added / Edited.
    for note in present {
        seen.insert(note.path);
        let hash = content_hash(note.body);
        let mtime = mtime_secs(Path::new(note.path));

        let kind = match prior.get(note.path) {
            None => Some(ChangeKind::Added),
            Some(st) if st.content_hash != hash || st.mtime != mtime => Some(ChangeKind::Edited),
            Some(_) => None, // unchanged — no dispatch
        };

        if let Some(kind) = kind {
            changes.push(NoteChange {
                path: note.path.to_string(),
                kind,
                content: Some(note.body.to_string()),
            });
        }

        // Reconcile state (upsert) regardless of whether it changed.
        conn.execute(
            "INSERT INTO note_index_state (path, mtime, content_hash)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET
               mtime = excluded.mtime,
               content_hash = excluded.content_hash",
            params![note.path, mtime, hash],
        )?;
    }

    // Deleted: prior paths not present this pass.
    let deleted: Vec<String> = prior
        .keys()
        .filter(|p| !seen.contains(p.as_str()))
        .cloned()
        .collect();
    for path in deleted {
        changes.push(NoteChange {
            path: path.clone(),
            kind: ChangeKind::Deleted,
            content: None,
        });
        conn.execute("DELETE FROM note_index_state WHERE path = ?1", params![path])?;
    }

    // Dispatch every change to every handler, degrade-safe.
    for change in &changes {
        for handler in handlers {
            dispatch_one(conn, handler.as_ref(), change);
        }
    }

    Ok(changes)
}

/// Run one handler for one change, catching panics and errors so a single bad
/// handler can never fail the index. Logs and continues.
fn dispatch_one(conn: &Connection, handler: &dyn MaintenanceHandler, change: &NoteChange) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handler.on_change(conn, change)
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::warn!(
            "[maintenance] handler '{}' failed on {} ({}): {e}",
            handler.name(),
            change.path,
            change.kind.as_str()
        ),
        Err(_) => log::warn!(
            "[maintenance] handler '{}' panicked on {} ({}) — skipped",
            handler.name(),
            change.path,
            change.kind.as_str()
        ),
    }
}

// ── Demo handler: NoteChangeLog (the persistent-store template) ────────────────

/// Trivial built-in handler proving the wiring fires. Appends one
/// `(path, kind, ts)` row to `note_change_log` per change. It is cheap (a single
/// INSERT), always-on, and the template real handlers copy: own table keyed by
/// `path`, written on every change.
///
/// (It APPENDS rather than upserts because it is an audit log — it wants the
/// full history. A handler caching a single derived value per note would instead
/// `ON CONFLICT(path) DO UPDATE` on Added/Edited and `DELETE ... WHERE path` on
/// Deleted; see the module doc.)
pub struct NoteChangeLog;

const CHANGE_LOG_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS note_change_log (
        id    INTEGER PRIMARY KEY,
        path  TEXT NOT NULL,
        kind  TEXT NOT NULL,
        ts    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS note_change_log_path ON note_change_log(path);
";

impl NoteChangeLog {
    fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(CHANGE_LOG_SCHEMA)
    }
}

impl MaintenanceHandler for NoteChangeLog {
    fn name(&self) -> &'static str {
        "NoteChangeLog"
    }

    fn on_change(&self, conn: &Connection, change: &NoteChange) -> rusqlite::Result<()> {
        let ts = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO note_change_log (path, kind, ts) VALUES (?1, ?2, ?3)",
            params![change.path, change.kind.as_str(), ts],
        )?;
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    /// A recording handler that captures the (path, kind, has_content) sequence
    /// it sees, so a test can assert exactly what was dispatched.
    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<(String, ChangeKind, bool)>>,
    }

    impl MaintenanceHandler for Recorder {
        fn name(&self) -> &'static str {
            "Recorder"
        }
        fn on_change(&self, _conn: &Connection, change: &NoteChange) -> rusqlite::Result<()> {
            self.seen.lock().unwrap().push((
                change.path.clone(),
                change.kind,
                change.content.is_some(),
            ));
            Ok(())
        }
    }

    /// Adapter so a test can share one `Recorder` between the registry (which
    /// takes ownership of its handlers) and the assertion side.
    struct ArcHandler(Arc<Recorder>);
    impl MaintenanceHandler for ArcHandler {
        fn name(&self) -> &'static str {
            "ArcHandler"
        }
        fn on_change(&self, conn: &Connection, change: &NoteChange) -> rusqlite::Result<()> {
            self.0.on_change(conn, change)
        }
    }

    fn note<'a>(path: &'a str, body: &'a str) -> IndexedNote<'a> {
        IndexedNote { path, body }
    }

    /// Run detection with a fresh Recorder and return (changes, recorded).
    fn run(
        conn: &Connection,
        present: &[IndexedNote<'_>],
    ) -> (Vec<NoteChange>, Vec<(String, ChangeKind, bool)>) {
        let recorder = Arc::new(Recorder::default());
        let handlers: Vec<Box<dyn MaintenanceHandler>> =
            vec![Box::new(ArcHandler(recorder.clone()))];
        let changes = detect_and_dispatch(conn, present, &handlers).unwrap();
        let recorded = recorder.seen.lock().unwrap().clone();
        (changes, recorded)
    }

    #[test]
    fn add_edit_delete_unchanged_lifecycle() {
        let conn = mem_db();

        // Pass 1: add a.md → Added once, content present.
        let (changes, rec) = run(&conn, &[note("a.md", "v1")]);
        assert_eq!(changes.len(), 1);
        assert_eq!(rec, vec![("a.md".to_string(), ChangeKind::Added, true)]);

        // Pass 2: same content → no dispatch.
        let (changes, rec) = run(&conn, &[note("a.md", "v1")]);
        assert!(changes.is_empty(), "unchanged note does not dispatch");
        assert!(rec.is_empty());

        // Pass 3: edited content (hash changes) → Edited once, content present.
        let (changes, rec) = run(&conn, &[note("a.md", "v2-different")]);
        assert_eq!(changes.len(), 1);
        assert_eq!(rec, vec![("a.md".to_string(), ChangeKind::Edited, true)]);

        // Pass 4: note gone from disk → Deleted once, content None.
        let (changes, rec) = run(&conn, &[]);
        assert_eq!(changes.len(), 1);
        assert_eq!(rec, vec![("a.md".to_string(), ChangeKind::Deleted, false)]);

        // Pass 5: still gone → nothing (state already removed it).
        let (changes, rec) = run(&conn, &[]);
        assert!(changes.is_empty());
        assert!(rec.is_empty());
    }

    #[test]
    fn multiple_notes_dispatch_independently() {
        let conn = mem_db();
        let (changes, _) = run(&conn, &[note("a.md", "1"), note("b.md", "2")]);
        assert_eq!(changes.len(), 2, "both new notes are Added");

        // Edit a, leave b, add c → exactly Edited(a) + Added(c).
        let (_, rec) = run(
            &conn,
            &[note("a.md", "1-edited"), note("b.md", "2"), note("c.md", "3")],
        );
        let mut kinds: Vec<(String, ChangeKind)> =
            rec.into_iter().map(|(p, k, _)| (p, k)).collect();
        kinds.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            kinds,
            vec![
                ("a.md".to_string(), ChangeKind::Edited),
                ("c.md".to_string(), ChangeKind::Added),
            ]
        );
    }

    #[test]
    fn note_change_log_records_each_change() {
        // The built-in demo handler proves the persistent store fires on the real
        // registry (default_handlers), not just a test recorder.
        let conn = mem_db();
        let handlers = default_handlers();
        detect_and_dispatch(&conn, &[note("a.md", "v1")], &handlers).unwrap();
        detect_and_dispatch(&conn, &[note("a.md", "v2")], &handlers).unwrap();
        detect_and_dispatch(&conn, &[], &handlers).unwrap();

        let rows: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare("SELECT path, kind FROM note_change_log ORDER BY id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(
            rows,
            vec![
                ("a.md".to_string(), "added".to_string()),
                ("a.md".to_string(), "edited".to_string()),
                ("a.md".to_string(), "deleted".to_string()),
            ]
        );
    }

    #[test]
    fn failing_handler_does_not_break_dispatch() {
        // A handler that always errors must not stop other handlers or the index.
        struct Boom;
        impl MaintenanceHandler for Boom {
            fn name(&self) -> &'static str {
                "Boom"
            }
            fn on_change(&self, _c: &Connection, _ch: &NoteChange) -> rusqlite::Result<()> {
                Err(rusqlite::Error::ExecuteReturnedResults)
            }
        }
        let conn = mem_db();
        let recorder = Arc::new(Recorder::default());
        let handlers: Vec<Box<dyn MaintenanceHandler>> =
            vec![Box::new(Boom), Box::new(ArcHandler(recorder.clone()))];

        // Must not error despite Boom failing.
        let changes = detect_and_dispatch(&conn, &[note("a.md", "x")], &handlers).unwrap();
        assert_eq!(changes.len(), 1);
        // The good handler still ran.
        assert_eq!(recorder.seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn panicking_handler_is_caught() {
        struct Panic;
        impl MaintenanceHandler for Panic {
            fn name(&self) -> &'static str {
                "Panic"
            }
            fn on_change(&self, _c: &Connection, _ch: &NoteChange) -> rusqlite::Result<()> {
                panic!("handler blew up");
            }
        }
        let conn = mem_db();
        let recorder = Arc::new(Recorder::default());
        let handlers: Vec<Box<dyn MaintenanceHandler>> =
            vec![Box::new(Panic), Box::new(ArcHandler(recorder.clone()))];
        let changes = detect_and_dispatch(&conn, &[note("a.md", "x")], &handlers).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(
            recorder.seen.lock().unwrap().len(),
            1,
            "good handler still ran after panic"
        );
    }
}
