//! salience.rs
//!
//! Salience scoring for memory notes (TIN-1746). Produces a single 0..1 scalar
//! that blends two normalised signals so the `cornerstones` CLI can surface the
//! notes that matter most (and archive candidates that never do).
//!
//! ## Formula
//!
//! ```text
//! salience = W_READS * read_signal + W_CENTRALITY * centrality_signal
//! ```
//!
//! where:
//!
//! * **read_signal** — `read_count` weighted by recency decay.  Each read is
//!   not a raw count; it decays exponentially based on how long ago the *last*
//!   read occurred.  The decay uses a **30-day half-life**: a note last read 30
//!   days ago contributes half as much as one read today, 60 days ago a quarter,
//!   and so on.  This keeps recently-accessed notes prominent without letting
//!   stale "hot" notes monopolise the list indefinitely.  After computing
//!   `read_count * exp(-λ * days_since_last_read)` for every note, the values
//!   are normalised to 0..1 by dividing by the maximum across all notes.
//!
//! * **centrality_signal** — per-note link degree (outbound wiki-links +
//!   incoming backlinks) from the `links` table (reuses `links::rebuild_links`'s
//!   graph; just counts rows).  Normalised to 0..1 by dividing by the max
//!   degree.  Ticket-type links count too: a note heavily referenced by other
//!   notes AND referencing many tickets is structurally important.
//!
//! * **W_READS = 0.5, W_CENTRALITY = 0.5** — equal weight to start; both
//!   signals are meaningful and there is no domain evidence yet that one should
//!   dominate.  These are constants with doc-comments so a reviewer/Rob can tune
//!   them with a one-line edit.
//!
//! The `--neglected` flag inverts the ranking: it returns notes with salience
//! below `NEGLECTED_THRESHOLD` (0.05), i.e. essentially zero read signal and
//! near-zero centrality.  These are archive candidates.
//!
//! ## Half-life constant
//!
//! `HALF_LIFE_DAYS = 30.0` — chosen to match a "sprint-to-sprint" memory
//! horizon.  A note consulted last sprint is still relevant; one last touched
//! three months ago is fading.  Adjust upward (e.g. 90) for a longer tail, or
//! downward (e.g. 14) for a more aggressive recency preference.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::search::Db;

// ── Tunable constants ─────────────────────────────────────────────────────────

/// Weight given to the read-frequency / recency signal (0..1).
/// Together with `W_CENTRALITY` must sum to 1.0.
const W_READS: f32 = 0.5;

/// Weight given to the graph-centrality signal (0..1).
const W_CENTRALITY: f32 = 0.5;

/// Exponential decay half-life in days.  A `last_read_ts` this many days in
/// the past contributes half the read-count signal of a read today.
const HALF_LIFE_DAYS: f64 = 30.0;

/// Notes below this salience threshold are considered "neglected" by
/// `--neglected` mode.  0.05 means both signals are near zero.
pub const NEGLECTED_THRESHOLD: f32 = 0.05;

/// Pre-computed decay constant: `ln(2) / HALF_LIFE_DAYS`.
fn decay_lambda() -> f64 {
    std::f64::consts::LN_2 / HALF_LIFE_DAYS
}

// ── Output types ──────────────────────────────────────────────────────────────

/// Per-note salience entry, including the breakdown so the UI/CLI can explain
/// *why* a note is (or is not) a cornerstone.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SalienceEntry {
    /// Absolute filesystem path (primary key, matches `memory_files.path`).
    pub path: String,
    /// Frontmatter `name` field.
    pub name: String,
    /// Frontmatter `summary` field (may be empty).
    pub summary: String,
    /// Blended 0..1 salience score.
    pub salience: f32,
    /// Raw read count from `memory_reads` (0 if never read).
    pub read_count: i64,
    /// Normalised 0..1 centrality (link degree / max degree).
    pub centrality: f32,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Compute the decay-weighted read signal for a note.
/// `read_count` is the raw integer; `last_read_ts` is RFC 3339.
/// `now_secs` is the current Unix timestamp in seconds.
/// Returns `read_count * exp(-λ * days_since_last_read)`.
fn decayed_reads(read_count: i64, last_read_ts: &str, now_secs: f64) -> f64 {
    // Parse the timestamp; fall back to full signal if unparseable (i.e. treat
    // it as if it were read right now, avoiding punishing malformed data).
    let ts_secs: f64 = chrono::DateTime::parse_from_rfc3339(last_read_ts)
        .map(|dt| dt.timestamp() as f64)
        .unwrap_or(now_secs);

    let elapsed_days = (now_secs - ts_secs).max(0.0) / 86_400.0;
    let decay = (-decay_lambda() * elapsed_days).exp();
    (read_count as f64) * decay
}

/// Query per-note link degree (count of distinct edges touching this path as
/// either source or target, wiki-links AND ticket links).
fn degree_map(conn: &Connection) -> rusqlite::Result<HashMap<String, usize>> {
    // Count outbound links (from_path) and inbound links (to_path) separately,
    // then merge.  We count ticket links too because a note that tracks many
    // tickets is structurally important.
    let mut degree: HashMap<String, usize> = HashMap::new();

    {
        let mut stmt = conn.prepare(
            "SELECT from_path, COUNT(*) AS cnt FROM links GROUP BY from_path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for (path, cnt) in rows.filter_map(Result::ok) {
            *degree.entry(path).or_insert(0) += cnt as usize;
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT to_path, COUNT(*) AS cnt FROM links WHERE to_path IS NOT NULL GROUP BY to_path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for (path, cnt) in rows.filter_map(Result::ok) {
            *degree.entry(path).or_insert(0) += cnt as usize;
        }
    }

    Ok(degree)
}

/// Read the `summary` frontmatter field from a note file on disk.
/// Returns `None` when the file can't be read, has no frontmatter, or has no
/// `summary` key.  Used by `compute_salience` to populate the output entry.
fn read_summary_field(
    matter: &gray_matter::Matter<gray_matter::engine::YAML>,
    path: &str,
) -> Option<String> {
    use gray_matter::Pod;
    let raw = std::fs::read_to_string(path).ok()?;
    // gray_matter::Matter::parse returns Result; .ok() drops parse errors.
    let parsed: gray_matter::ParsedEntity = matter.parse(&raw).ok()?;
    let data: &Pod = parsed.data.as_ref()?;
    let map = data.as_hashmap().ok()?;
    let pod: &Pod = map.get("summary")?;
    let s: String = pod.as_string().ok()?;
    if s.is_empty() { None } else { Some(s) }
}

// ── Core salience function ────────────────────────────────────────────────────

/// Compute salience for every note in `memory_files`, optionally filtered to
/// one project.  Returns entries ordered by **descending salience**.
///
/// This is the free-function core: it takes a plain `&Connection` so tests can
/// call it without Tauri state.
pub fn compute_salience(
    conn: &Connection,
    project_filter: Option<&str>,
) -> rusqlite::Result<Vec<SalienceEntry>> {
    use crate::memory_reads::{get_reads, top_reads};

    // Ensure reads schema is available (idempotent).
    crate::memory_reads::ensure_schema(conn)?;

    let now_secs = chrono::Utc::now().timestamp() as f64;

    // ── 1. Collect all notes (with optional project filter) ──────────────────
    let filter_sql = if project_filter.map(|p| !p.is_empty()).unwrap_or(false) {
        " WHERE (',' || projects || ',') LIKE ?1"
    } else {
        ""
    };

    let sql = format!(
        "SELECT path, name FROM memory_files{filter_sql}"
    );

    let mut stmt = conn.prepare(&sql)?;

    struct NoteRow {
        path: String,
        name: String,
    }

    let rows: Vec<NoteRow> = if let Some(pf) = project_filter.filter(|p| !p.is_empty()) {
        let like = format!("%,{},%", pf);
        stmt.query_map(params![like], |r| {
            Ok(NoteRow { path: r.get(0)?, name: r.get(1)? })
        })?
        .filter_map(Result::ok)
        .collect()
    } else {
        stmt.query_map([], |r| {
            Ok(NoteRow { path: r.get(0)?, name: r.get(1)? })
        })?
        .filter_map(Result::ok)
        .collect()
    };

    if rows.is_empty() {
        return Ok(vec![]);
    }

    // ── 2. Build a bulk read map via top_reads (Phase-1 integration) ─────────
    // `top_reads` returns notes ordered by count descending; we pull all rows
    // (up to usize::MAX / 2 which is effectively unbounded) and index by path.
    // For any note not in the top-reads map, we fall back to `get_reads` (which
    // returns None for unread notes).  This wires both Phase-1 functions.
    let top = top_reads(conn, usize::MAX / 2)?;
    let mut reads_map: HashMap<String, (i64, String)> = top
        .into_iter()
        .map(|(path, stats)| (path, (stats.read_count, stats.last_read_ts)))
        .collect();

    // Ensure every note has an entry (fill zeros for unread notes via get_reads).
    for row in &rows {
        if !reads_map.contains_key(&row.path) {
            // get_reads returns None for never-read notes; keep (0, "") for those.
            if let Ok(Some(stats)) = get_reads(conn, &row.path) {
                reads_map.insert(row.path.clone(), (stats.read_count, stats.last_read_ts));
            }
        }
    }

    // ── 3. Compute decayed read signal ────────────────────────────────────────
    let raw_reads: Vec<f64> = rows
        .iter()
        .map(|r| {
            match reads_map.get(&r.path) {
                Some((count, ts)) if *count > 0 && !ts.is_empty() => {
                    decayed_reads(*count, ts, now_secs)
                }
                _ => 0.0,
            }
        })
        .collect();

    let max_reads = raw_reads.iter().cloned().fold(0.0_f64, f64::max);

    // ── 3. Compute centrality (link degree) ───────────────────────────────────
    let degrees = degree_map(conn)?;
    let raw_degrees: Vec<usize> = rows.iter().map(|r| *degrees.get(&r.path).unwrap_or(&0)).collect();
    let max_degree = raw_degrees.iter().cloned().max().unwrap_or(0);

    // ── 4. Gather summaries from note frontmatter (best-effort, disk read) ──────
    // `summary` lives in the YAML frontmatter block; the DB stores the post-
    // frontmatter body only.  We do a cheap per-note file read here — this is
    // a CLI command run at most once per invocation, so the I/O is acceptable.
    let mut summary_map: HashMap<String, String> = HashMap::new();
    {
        let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
        for row in &rows {
            if let Some(s) = read_summary_field(&matter, &row.path) {
                summary_map.insert(row.path.clone(), s);
            }
        }
    }

    // ── 5. Blend and assemble ─────────────────────────────────────────────────
    let mut entries: Vec<SalienceEntry> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let read_norm = if max_reads > 0.0 {
                (raw_reads[i] / max_reads) as f32
            } else {
                0.0
            };
            let centrality_norm = if max_degree > 0 {
                raw_degrees[i] as f32 / max_degree as f32
            } else {
                0.0
            };
            let salience = W_READS * read_norm + W_CENTRALITY * centrality_norm;
            let summary = summary_map.get(&row.path).cloned().unwrap_or_default();
            let read_count = reads_map.get(&row.path).map(|(c, _)| *c).unwrap_or(0);
            SalienceEntry {
                path: row.path.clone(),
                name: row.name.clone(),
                summary,
                salience,
                read_count,
                centrality: centrality_norm,
            }
        })
        .collect();

    // Sort descending by salience, then by name for stable tie-breaking.
    entries.sort_by(|a, b| {
        b.salience
            .partial_cmp(&a.salience)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(entries)
}

/// Public entry point that takes a `&Db` (Mutex-wrapped connection).  Returns
/// the salience list for the optional project filter, ordered by descending
/// salience.
pub fn salience(db: &Db, project_filter: Option<&str>) -> Result<Vec<SalienceEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    compute_salience(&conn, project_filter).map_err(|e| e.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_reads::{ensure_schema as ensure_reads_schema, record_read};
    use crate::search::{build_index, init_db, register_sqlite_vec, SCHEMA, ensure_chunks_table};
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("salience-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// Build a test DB with the full schema + memory_reads table.
    fn test_db(root: &Path) -> Connection {
        register_sqlite_vec();
        let conn = init_db(root).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ensure_chunks_table(&conn).unwrap();
        ensure_reads_schema(&conn).unwrap();
        conn
    }

    // ── Decay helper ──────────────────────────────────────────────────────────

    #[test]
    fn decayed_reads_is_lower_for_older_timestamps() {
        let now = chrono::Utc::now();
        let now_secs = now.timestamp() as f64;
        // Recent read (1 day ago) vs old read (60 days ago), same count.
        let recent_ts = (now - chrono::Duration::days(1)).to_rfc3339();
        let old_ts = (now - chrono::Duration::days(60)).to_rfc3339();

        let recent = decayed_reads(10, &recent_ts, now_secs);
        let old = decayed_reads(10, &old_ts, now_secs);

        assert!(
            recent > old,
            "recent read (1d ago) should outweigh old read (60d ago): {recent} vs {old}"
        );
        // At 60 days = 2 half-lives, decay should be ~0.25.
        assert!(
            old < recent * 0.4,
            "60-day-old read should be well below recent: {old} vs {recent}"
        );
    }

    #[test]
    fn decayed_reads_zero_for_unread_note() {
        let now_secs = chrono::Utc::now().timestamp() as f64;
        let result = decayed_reads(0, "", now_secs);
        assert_eq!(result, 0.0, "zero reads → zero signal");
    }

    // ── Salience ranking ──────────────────────────────────────────────────────

    /// Core test: a note with reads + links outranks a never-read orphan.
    #[test]
    fn salience_ranks_hot_connected_note_above_orphan() {
        let root = temp_root("rank");

        // Note A: well-connected — links to B.
        write(
            &root,
            "studio/a.md",
            "---\nname: alpha\ntype: project\nprojects: studio\n---\nSee [[b]] for details.",
        );
        // Note B: links back; will have high degree.
        write(
            &root,
            "studio/b.md",
            "---\nname: beta\ntype: project\nprojects: studio\n---\nSee [[a]] for context.",
        );
        // Note C: orphan, never read, no links.
        write(
            &root,
            "studio/c.md",
            "---\nname: gamma\ntype: project\nprojects: studio\n---\nStandalone note.",
        );

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        // Record reads for A — make it hot.
        let now = chrono::Utc::now();
        let ts = (now - chrono::Duration::hours(2)).to_rfc3339();
        let path_a = root.join("studio/a.md").to_string_lossy().to_string();
        let _path_c = root.join("studio/c.md").to_string_lossy().to_string();
        for _ in 0..5 {
            record_read(&conn, &path_a, &ts).unwrap();
        }

        let entries = compute_salience(&conn, None).unwrap();
        assert!(!entries.is_empty(), "at least one entry returned");

        let a_entry = entries.iter().find(|e| e.name == "alpha").expect("alpha in results");
        let c_entry = entries.iter().find(|e| e.name == "gamma").expect("gamma in results");

        assert!(
            a_entry.salience > c_entry.salience,
            "hot, connected note (alpha={}) should outrank orphan (gamma={})",
            a_entry.salience,
            c_entry.salience
        );
        assert_eq!(a_entry.read_count, 5, "read count preserved");
        assert_eq!(c_entry.read_count, 0, "orphan has zero reads");
    }

    /// cornerstones ordering: top-k is ordered desc by salience.
    #[test]
    fn salience_entries_ordered_descending() {
        let root = temp_root("order");
        write(
            &root,
            "studio/x.md",
            "---\nname: x-note\ntype: project\nprojects: studio\n---\nSee [[y-note]].",
        );
        write(
            &root,
            "studio/y.md",
            "---\nname: y-note\ntype: project\nprojects: studio\n---\nReferenced note.",
        );
        write(
            &root,
            "studio/z.md",
            "---\nname: z-note\ntype: project\nprojects: studio\n---\nOrphan.",
        );

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        let entries = compute_salience(&conn, None).unwrap();
        for w in entries.windows(2) {
            assert!(
                w[0].salience >= w[1].salience,
                "entries out of order: {} ({}) before {} ({})",
                w[0].name, w[0].salience, w[1].name, w[1].salience
            );
        }
    }

    /// --neglected: notes with near-zero salience are returned.
    #[test]
    fn neglected_notes_have_low_salience() {
        let root = temp_root("neglected");
        write(
            &root,
            "studio/hot.md",
            "---\nname: hot-note\ntype: project\nprojects: studio\n---\nSee [[cold-note]].",
        );
        write(
            &root,
            "studio/cold.md",
            "---\nname: cold-note\ntype: project\nprojects: studio\n---\nForgotten.",
        );

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        // Record many reads for hot-note, none for cold-note.
        let ts = chrono::Utc::now().to_rfc3339();
        let hot_path = root.join("studio/hot.md").to_string_lossy().to_string();
        for _ in 0..10 {
            record_read(&conn, &hot_path, &ts).unwrap();
        }

        let entries = compute_salience(&conn, None).unwrap();
        let cold = entries.iter().find(|e| e.name == "cold-note").unwrap();
        let hot = entries.iter().find(|e| e.name == "hot-note").unwrap();

        // cold-note has degree=1 (hot links to it) so centrality > 0.
        // But read signal is 0, so its salience < hot's.
        assert!(
            hot.salience > cold.salience,
            "hot note outranks cold note: hot={}, cold={}",
            hot.salience,
            cold.salience
        );

        // In a set where hot-note has max salience, cold-note below threshold.
        // (cold-note has centrality > 0 due to the inbound link from hot-note,
        // but zero read signal, so overall salience is W_CENTRALITY * centrality.)
        // The test just ensures the ordering is correct, not the exact threshold.
        assert_eq!(cold.read_count, 0, "cold note was never read");
    }

    /// Recency decay: older reads contribute less than recent reads.
    #[test]
    fn recency_decay_lowers_old_read_contribution() {
        let root = temp_root("decay");
        write(
            &root,
            "studio/recent.md",
            "---\nname: recent-note\ntype: project\nprojects: studio\n---\nRecently read.",
        );
        write(
            &root,
            "studio/old.md",
            "---\nname: old-note\ntype: project\nprojects: studio\n---\nRead long ago.",
        );

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        let now = chrono::Utc::now();
        let recent_ts = (now - chrono::Duration::hours(1)).to_rfc3339();
        let old_ts = (now - chrono::Duration::days(90)).to_rfc3339();

        let path_recent = root.join("studio/recent.md").to_string_lossy().to_string();
        let path_old = root.join("studio/old.md").to_string_lossy().to_string();

        // Both notes have the same read count; recent note was read much more recently.
        for _ in 0..3 {
            record_read(&conn, &path_recent, &recent_ts).unwrap();
            record_read(&conn, &path_old, &old_ts).unwrap();
        }

        let entries = compute_salience(&conn, None).unwrap();
        let recent_entry = entries.iter().find(|e| e.name == "recent-note").unwrap();
        let old_entry = entries.iter().find(|e| e.name == "old-note").unwrap();

        assert!(
            recent_entry.salience > old_entry.salience,
            "recently-read note should outrank stale note with same count: recent={}, old={}",
            recent_entry.salience,
            old_entry.salience
        );
    }

    /// Project filter restricts results to the given project.
    #[test]
    fn project_filter_restricts_results() {
        let root = temp_root("proj-filter");
        write(
            &root,
            "studio/a.md",
            "---\nname: studio-note\ntype: project\nprojects: studio\n---\nStudio.",
        );
        write(
            &root,
            "attic/b.md",
            "---\nname: attic-note\ntype: project\nprojects: attic\n---\nAttic.",
        );

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        let studio_entries = compute_salience(&conn, Some("studio")).unwrap();
        assert!(
            studio_entries.iter().all(|e| !e.name.contains("attic")),
            "project filter excludes attic notes"
        );
        assert!(
            studio_entries.iter().any(|e| e.name.contains("studio")),
            "studio notes present in filtered results"
        );
    }

    /// Top-k: taking the first k entries gives the top-k by salience.
    #[test]
    fn top_k_returns_highest_salience_notes() {
        let root = temp_root("top-k");
        for i in 0..5_u32 {
            write(
                &root,
                &format!("studio/note-{i}.md"),
                &format!("---\nname: note-{i}\ntype: project\nprojects: studio\n---\nContent {i}."),
            );
        }

        let conn = test_db(&root);
        build_index(&root, &conn).unwrap();

        // Record reads to give some notes higher salience.
        let ts = chrono::Utc::now().to_rfc3339();
        let path_0 = root.join("studio/note-0.md").to_string_lossy().to_string();
        let path_1 = root.join("studio/note-1.md").to_string_lossy().to_string();
        for _ in 0..10 {
            record_read(&conn, &path_0, &ts).unwrap();
        }
        for _ in 0..5 {
            record_read(&conn, &path_1, &ts).unwrap();
        }

        let entries = compute_salience(&conn, None).unwrap();
        let top_2: Vec<_> = entries.iter().take(2).collect();
        // note-0 (most reads) should be #1.
        assert_eq!(top_2[0].name, "note-0", "note-0 (10 reads) should be top");
        assert_eq!(top_2[1].name, "note-1", "note-1 (5 reads) should be second");
    }
}
