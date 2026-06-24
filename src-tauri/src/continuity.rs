//! continuity.rs
//!
//! Continuity scorer (TIN-1730) — read-only. Given a piece of candidate note
//! `content` (e.g. something the agent is about to write to memory), answer one
//! question: does it *contradict a decision already recorded* in the memory
//! base? It does NOT write, supersede, or mutate anything — that is other
//! tickets. It only scores and reports.
//!
//! Pipeline (mirrors the Consistency Audit, TIN-1695, but one-vs-many instead of
//! all-pairs):
//!   1. Embed `content` with the bundled local model (`local_embed`).
//!   2. Pull the nearest existing notes from the vector store (`search`), keep
//!      the most-similar few above the audit's similarity floor, excluding the
//!      note's own `path`.
//!   3. Judge each candidate against `content` with the local reasoning model,
//!      reusing the audit's `judge_pair` / `AUDIT_SYSTEM` / `parse_conflicts`, so
//!      only a *real* contradiction with a prior decision surfaces — topical
//!      overlap alone never lowers the score.
//!   4. Map conflicts → a 0..1 continuity score: 1.0 = consistent or genuinely
//!      novel; lower as real contradictions are found. A near-duplicate that
//!      AGREES is high-continuity; similarity never drives the score down.
//!
//! Everything runs locally (candle + Ollama). With no reasoning model reachable
//! the command never errors: it returns a similarity-only score with
//! `degraded: true` and no conflicts, exactly as `audit.rs` detects a missing
//! model before doing any LLM work.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audit::{judge_pair, SIM_FLOOR};
use crate::search::{nearest_chunks, Db};

/// Keep at most this many nearest notes to judge — bounds the LLM work per call
/// while still covering the genuinely-similar neighbourhood.
const TOP_K: usize = 8;
/// How many chunk hits to pull from the vector store before aggregating to
/// files. Larger than `TOP_K` because several chunks can map to one file.
const NEIGHBOUR_POOL: i64 = 50;
/// Each judged conflict subtracts this much from a perfect 1.0 continuity score.
/// Two solid contradictions already pull the score well below half — enough to
/// flag the note loudly — while a single conflict still reads as "mostly fine,
/// but check this".
const CONFLICT_PENALTY: f32 = 0.35;

// ── Types ────────────────────────────────────────────────────────────────────

/// Input for the `score_memory` command. Per the project IPC convention, a
/// command with structured input takes a single `payload` struct.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMemoryInput {
    /// The candidate note body to score against the existing memory base.
    pub content: String,
    /// The note's own path, if it already exists — excluded from its own
    /// neighbours so a note never "contradicts itself".
    #[serde(default)]
    pub path: Option<String>,
}

/// One contradiction the candidate `content` has with an existing note.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// Path of the existing note that holds the contradicted decision.
    pub path: String,
    /// Display name of that note.
    pub name: String,
    /// The prior decision/value the candidate contradicts (the model's summary).
    pub contradicted_decision: String,
    /// One-sentence explanation naming both conflicting values.
    pub why: String,
}

/// Result of scoring a candidate note for continuity with the memory base.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityScore {
    /// 0.0..=1.0. 1.0 = consistent or genuinely novel; lower as real
    /// contradictions with recorded decisions are found.
    pub continuity_score: f32,
    /// The contradictions found (empty when consistent or degraded).
    pub conflicts: Vec<Conflict>,
    /// True when no reasoning model was reachable, so this is a similarity-only
    /// estimate with no conflict judging.
    pub degraded: bool,
}

// ── Candidate selection ──────────────────────────────────────────────────────

/// A nearest existing note: its path, its best cosine similarity to the query
/// (1 - distance), most-similar first.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Neighbour {
    pub path: String,
    pub similarity: f32,
}

/// Aggregate the vector-store hits for `query` into the top existing notes by
/// similarity, dropping anything below `SIM_FLOOR` and the note's own `path`.
///
/// Pure of the LLM and of Tauri state so the selection logic can be tested
/// deterministically against a seeded in-memory index.
pub(crate) fn select_candidates(
    conn: &rusqlite::Connection,
    query: &[f32],
    exclude: Option<&str>,
) -> rusqlite::Result<Vec<Neighbour>> {
    let hits = nearest_chunks(conn, query, NEIGHBOUR_POOL)?;

    // Best (smallest) distance per file → highest similarity per file.
    let mut best: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    for h in hits {
        if exclude == Some(h.file_path.as_str()) {
            continue;
        }
        // sqlite-vec cosine distance is 1 - cosine_similarity for L2-normalised
        // vectors, so similarity = 1 - distance.
        let sim = 1.0 - h.distance as f32;
        let e = best.entry(h.file_path).or_insert(sim);
        if sim > *e {
            *e = sim;
        }
    }

    let mut out: Vec<Neighbour> = best
        .into_iter()
        .filter(|(_, sim)| *sim >= SIM_FLOOR)
        .map(|(path, similarity)| Neighbour { path, similarity })
        .collect();
    out.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(TOP_K);
    Ok(out)
}

/// Look up a note's display name + body by path. Falls back to the path's last
/// segment for the name and an empty body if the row is missing.
fn load_note(conn: &rusqlite::Connection, path: &str) -> (String, String) {
    conn.query_row(
        "SELECT name, body FROM memory_files WHERE path = ?1",
        rusqlite::params![path],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .unwrap_or_else(|_| {
        (
            path.rsplit('/').next().unwrap_or(path).to_string(),
            String::new(),
        )
    })
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/// Map a set of judged conflicts to a 0..1 continuity score. Each conflict pulls
/// the score down by [`CONFLICT_PENALTY`]; with none, the note is fully
/// consistent (or novel) and scores 1.0. Similarity is deliberately NOT a term:
/// a near-duplicate that agrees keeps a perfect score.
fn score_from_conflicts(n_conflicts: usize) -> f32 {
    (1.0 - CONFLICT_PENALTY * n_conflicts as f32).clamp(0.0, 1.0)
}

/// Similarity-only score for the degraded path (no reasoning model). Without a
/// judge we cannot prove a contradiction, so we never invent conflicts; but a
/// very-high-similarity neighbour means the note is "not novel" and could be a
/// re-decision, so we shade the score down gently with the closest match. Bounded
/// so the degraded score never drops below 0.5 (we have no evidence of conflict).
fn degraded_score(top_similarity: Option<f32>) -> f32 {
    match top_similarity {
        // No near neighbour at all → genuinely novel → fully continuous.
        None => 1.0,
        Some(sim) => {
            // Map similarity in [SIM_FLOOR, 1.0] to a mild [1.0, 0.5] shade.
            let span = (1.0 - SIM_FLOOR).max(f32::EPSILON);
            let t = ((sim - SIM_FLOOR) / span).clamp(0.0, 1.0);
            (1.0 - 0.5 * t).clamp(0.5, 1.0)
        }
    }
}

// ── Command ──────────────────────────────────────────────────────────────────

/// Score a candidate memory note for continuity with the existing base
/// (TIN-1730). Read-only: embeds the content, finds nearest notes, judges them
/// for contradiction-with-a-prior-decision with the local reasoning model, and
/// returns a 0..1 score plus the concrete conflicts. Never writes, never errors
/// on a missing model — it degrades to a similarity-only estimate instead.
#[tauri::command]
pub async fn score_memory(
    payload: ScoreMemoryInput,
    db: State<'_, Db>,
) -> Result<ContinuityScore, String> {
    let content = payload.content.trim().to_string();
    if content.is_empty() {
        // Nothing to score → trivially continuous.
        return Ok(ContinuityScore {
            continuity_score: 1.0,
            conflicts: Vec::new(),
            degraded: false,
        });
    }

    // ── Phase A: embed the candidate content (no lock held) ──────────────────
    // CPU-bound candle inference on a blocking thread, matching search.rs. If the
    // model isn't ready, we cannot find neighbours — treat as novel, not an error.
    let query_vec: Option<Vec<f32>> = {
        let c = content.clone();
        match tokio::task::spawn_blocking(move || crate::local_embed::embed(vec![c])).await {
            Ok(Ok(mut v)) => v.pop(),
            Ok(Err(e)) => {
                log::warn!("[continuity] embed failed, treating as novel: {e}");
                None
            }
            Err(e) => {
                log::warn!("[continuity] embed task failed: {e}");
                None
            }
        }
    };

    // ── Phase B: select nearest existing notes + gather their bodies (locked) ─
    let candidates: Vec<(String, String, String, f32)> = if let Some(qv) = &query_vec {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let neighbours = select_candidates(&conn, qv, payload.path.as_deref())
            .map_err(|e| e.to_string())?;
        neighbours
            .into_iter()
            .map(|n| {
                let (name, body) = load_note(&conn, &n.path);
                (n.path, name, body, n.similarity)
            })
            .collect()
    } else {
        Vec::new()
    };

    let top_similarity = candidates.first().map(|(_, _, _, sim)| *sim);

    // ── Phase C: degrade calmly if there is no reasoning model ────────────────
    // Mirrors audit.rs: detect the missing model BEFORE any LLM work. Here it is
    // not an error — return a similarity-only score with no conflicts.
    if !crate::reason::reachable().await {
        return Ok(ContinuityScore {
            continuity_score: degraded_score(top_similarity),
            conflicts: Vec::new(),
            degraded: true,
        });
    }

    // ── Phase D: judge each candidate against the content (async, no lock) ────
    let mut conflicts = Vec::new();
    for (path, name, body, _sim) in candidates {
        if body.trim().is_empty() {
            continue;
        }
        match judge_pair("candidate note", &content, &name, &body).await {
            Ok(found) => {
                for why in found {
                    conflicts.push(Conflict {
                        path: path.clone(),
                        name: name.clone(),
                        contradicted_decision: why.clone(),
                        why,
                    });
                }
            }
            Err(e) => log::warn!("[continuity] judge against {path} failed: {e}"),
        }
    }

    Ok(ContinuityScore {
        continuity_score: score_from_conflicts(conflicts.len()),
        conflicts,
        degraded: false,
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{
        build_index, ensure_chunks_table, insert_chunk, register_sqlite_vec, EMBEDDING_DIM, SCHEMA,
    };
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};

    // ── Fixtures (audit/search test style: temp index, seeded notes) ──────────

    fn mem_db() -> Connection {
        register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ensure_chunks_table(&conn).unwrap();
        conn
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("continuity-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// An [`EMBEDDING_DIM`]-wide vector pointing mostly along `axis`. Cosine
    /// ordering is predictable, so candidate selection is deterministic without a
    /// real embedder. Matches search.rs's `axis_vec`.
    fn axis_vec(axis: usize) -> Vec<f32> {
        let mut v = vec![0.0_f32; EMBEDDING_DIM];
        v[axis] = 1.0;
        v[axis + 1] = 0.1;
        v
    }

    // ── Pure scoring math ─────────────────────────────────────────────────────

    #[test]
    fn score_is_perfect_with_no_conflicts() {
        // A note that restates/agrees, or a novel note, yields zero conflicts →
        // full continuity. This is the "RESTATES an existing note" assertion at
        // the scoring layer.
        assert_eq!(score_from_conflicts(0), 1.0);
    }

    #[test]
    fn score_drops_with_each_conflict() {
        // A reversed decision surfaces a conflict and drives the score down; more
        // conflicts → lower. This is the "REVERSES a decision → lower score" math.
        let one = score_from_conflicts(1);
        let two = score_from_conflicts(2);
        assert!(one < 1.0, "one conflict lowers the score: {one}");
        assert!(two < one, "more conflicts → lower score: {two} < {one}");
        assert!((0.0..=1.0).contains(&one) && (0.0..=1.0).contains(&two));
    }

    #[test]
    fn degraded_score_is_high_for_novel_and_shaded_for_near_dup() {
        // No neighbour → novel → fully continuous, no conflicts ever invented.
        assert_eq!(degraded_score(None), 1.0);
        // A near-duplicate is shaded down but never below 0.5 (no proof of
        // conflict without a judge) and never above the novel case.
        let near = degraded_score(Some(0.99));
        assert!((0.5..1.0).contains(&near), "near-dup shaded into [0.5,1): {near}");
        // Higher similarity → lower (or equal) degraded score.
        assert!(degraded_score(Some(0.99)) <= degraded_score(Some(SIM_FLOOR + 0.01)));
    }

    // ── Candidate selection (deterministic, no LLM) ──────────────────────────

    #[test]
    fn select_candidates_surfaces_near_neighbour_above_floor() {
        // RESTATES/REVERSES both first need the prior note to SURFACE as a
        // candidate. Seed a note on axis 0; a query on axis 0 must find it.
        let root = temp_root("select-near");
        write(
            &root,
            "studio/pricing.md",
            "---\nname: pricing\ntype: project\nprojects: studio\n---\nAttic Pro costs $9 per month.",
        );
        let conn = mem_db();
        build_index(&root, &conn).unwrap();
        let p = root.join("studio/pricing.md").to_string_lossy().to_string();
        insert_chunk(&conn, &p, 0, "Attic Pro costs $9 per month.", "sha", &axis_vec(0)).unwrap();

        let got = select_candidates(&conn, &axis_vec(0), None).unwrap();
        assert_eq!(got.len(), 1, "the near note surfaces as a candidate");
        assert_eq!(got[0].path, p);
        assert!(got[0].similarity >= SIM_FLOOR, "above the floor: {}", got[0].similarity);
    }

    #[test]
    fn select_candidates_excludes_self_and_distant_notes() {
        // A NOVEL note (query orthogonal to everything) yields no candidates, and
        // a note never contradicts itself (its own path is excluded).
        let root = temp_root("select-novel");
        write(
            &root,
            "studio/a.md",
            "---\nname: a\ntype: project\nprojects: studio\n---\nOn axis zero.",
        );
        let conn = mem_db();
        build_index(&root, &conn).unwrap();
        let pa = root.join("studio/a.md").to_string_lossy().to_string();
        insert_chunk(&conn, &pa, 0, "On axis zero.", "sha", &axis_vec(0)).unwrap();

        // Query orthogonal to the only note → genuinely novel → no candidates.
        let novel = select_candidates(&conn, &axis_vec(200), None).unwrap();
        assert!(novel.is_empty(), "orthogonal query has no near neighbours: {novel:?}");

        // Query ON axis 0 but excluding A's own path → A is filtered out.
        let excluded = select_candidates(&conn, &axis_vec(0), Some(&pa)).unwrap();
        assert!(excluded.is_empty(), "a note is excluded from its own neighbours: {excluded:?}");
    }

    #[test]
    fn select_candidates_orders_by_similarity_and_caps_at_top_k() {
        // Most-similar first, and never more than TOP_K candidates.
        let root = temp_root("select-order");
        let conn = mem_db();
        // Seed TOP_K + 3 notes at increasing distance from axis 0.
        for i in 0..(TOP_K + 3) {
            let rel = format!("studio/n{i}.md");
            write(
                &root,
                &rel,
                &format!("---\nname: n{i}\ntype: project\nprojects: studio\n---\nnote {i}"),
            );
        }
        build_index(&root, &conn).unwrap();
        for i in 0..(TOP_K + 3) {
            let p = root
                .join(format!("studio/n{i}.md"))
                .to_string_lossy()
                .to_string();
            // axis 0..N: smaller index ≈ closer to the axis-0 query.
            insert_chunk(&conn, &p, 0, &format!("note {i}"), "sha", &axis_vec(i)).unwrap();
        }

        let got = select_candidates(&conn, &axis_vec(0), None).unwrap();
        assert!(got.len() <= TOP_K, "capped at TOP_K: got {}", got.len());
        // Descending similarity order.
        for w in got.windows(2) {
            assert!(w[0].similarity >= w[1].similarity, "descending similarity: {got:?}");
        }
    }

    // ── Degraded path through the real command (no Ollama in CI) ──────────────
    // The test env has no reasoning model, so `score_memory` takes the degraded
    // branch. We assert it returns a similarity-only score with `degraded: true`
    // and never errors — exercising embed → select → degrade end-to-end when a
    // local embedder is available. Gated like the audit's live-model tests: it
    // needs the bundled candle model cached (first run downloads ~90MB), so it is
    // ignored by default. The deterministic selection/scoring logic above is the
    // always-on coverage.
    #[tokio::test]
    #[ignore = "needs the bundled embedding model cached; run manually"]
    async fn score_memory_degraded_path_does_not_error() {
        let root = temp_root("cmd-degraded");
        write(
            &root,
            "studio/pricing.md",
            "---\nname: pricing\ntype: project\nprojects: studio\n---\nAttic Pro costs $9 per month.",
        );
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        // We can't build full Tauri State in a unit test, so exercise the inner
        // pieces the command composes: embed → select → degraded score.
        let qv = crate::local_embed::embed(vec!["Attic Pro is $9 a month.".to_string()])
            .expect("embed")
            .pop()
            .unwrap();
        let cands = select_candidates(&conn, &qv, None).unwrap();
        let top = cands.first().map(|n| n.similarity);
        let score = degraded_score(top);
        assert!((0.0..=1.0).contains(&score), "degraded score in range: {score}");
    }
}
