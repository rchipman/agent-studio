//! hybrid.rs
//!
//! Pure ranking pipeline for hybrid search (TIN-1632). Takes already-fetched
//! candidates (FTS5 BM25 ranks + sqlite-vec cosine distances + file metadata)
//! and produces a single, diversity-aware ranked result list. No I/O, no DB, no
//! network — so every stage is unit-testable in isolation.
//!
//! Pipeline (per the ticket):
//!   1. Normalise BM25 rank and vector similarity each to [0, 1].
//!   2. Merge: `0.7 * bm25 + 0.3 * vec` (pure BM25 when no embeddings).
//!   3. Temporal decay: exponential half-life on the file's `created` date,
//!      floored so old facts are never fully buried.
//!   4. MMR re-rank for diversity (λ = 0.7), so near-duplicate files don't
//!      dominate the top of the list.
//!   5. Return the top N.

use std::collections::HashSet;

use chrono::NaiveDate;

use crate::search::SearchResult;

// ── Tunables ─────────────────────────────────────────────────────────────────

/// Weight on the (normalised) BM25 score in the merge step.
const BM25_WEIGHT: f64 = 0.7;
/// Weight on the (normalised) vector similarity in the merge step.
const VEC_WEIGHT: f64 = 0.3;
/// Temporal-decay half-life in days (~6 months).
const HALF_LIFE_DAYS: f64 = 180.0;
/// Decay floor: a maximally-stale file keeps this fraction of its score, so old
/// facts are de-emphasised but never buried.
const DECAY_FLOOR: f64 = 0.4;
/// MMR trade-off between relevance and diversity. Higher = more relevance-driven.
const MMR_LAMBDA: f64 = 0.7;

// ── Candidate ────────────────────────────────────────────────────────────────

/// One candidate file with its raw component scores, ready to be ranked. The
/// display payload (`result`) rides along so ranking and rendering stay in sync.
pub struct RankInput {
    /// Display metadata + excerpt, returned verbatim once ranked.
    pub result: SearchResult,
    /// FTS5 `rank` for this file (negative; lower = better). `None` for a
    /// vector-only (semantic) hit that BM25 didn't surface.
    pub bm25_rank: Option<f64>,
    /// Best (smallest) cosine distance over the file's chunks. `None` when the
    /// file has no embedded chunk or embeddings are disabled.
    pub vec_dist: Option<f64>,
    /// A representative file embedding (mean/first chunk) for MMR cosine
    /// similarity. `None` falls back to Jaccard over `terms`.
    pub embedding: Option<Vec<f32>>,
    /// Lowercased content tokens, for the Jaccard MMR fallback.
    pub terms: Vec<String>,
}

// ── Normalisation ────────────────────────────────────────────────────────────

/// Min-max normalise a sparse score column to [0, 1]. `None` entries (the file
/// was absent from that retriever) map to 0.0. When every present value is
/// equal, they all map to 1.0 (a single hit is maximally relevant within its
/// own set). An all-`None` column returns all zeros.
fn minmax_normalize(values: &[Option<f64>]) -> Vec<f64> {
    let present: Vec<f64> = values.iter().filter_map(|v| *v).collect();
    if present.is_empty() {
        return vec![0.0; values.len()];
    }
    let min = present.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = present.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    values
        .iter()
        .map(|v| match v {
            Some(x) => {
                if max > min {
                    (x - min) / (max - min)
                } else {
                    1.0
                }
            }
            None => 0.0,
        })
        .collect()
}

// ── Temporal decay ───────────────────────────────────────────────────────────

/// Exponential decay factor in (0, 1] for a file given its `created` date.
///
/// Evergreen files — no `created` date, an unparseable date, or a status that
/// explicitly marks the file as durable — return `1.0` (no decay). Note we do
/// *not* treat the default `status: active` as evergreen: every file in the
/// store defaults to `active`, so doing so would make decay a no-op. Durability
/// is opt-in via `evergreen` / `pinned` / `reference`.
fn decay_factor(created: &str, status: &str, today: NaiveDate) -> f64 {
    let durable = matches!(
        status.trim().to_lowercase().as_str(),
        "evergreen" | "pinned" | "reference"
    );
    if durable {
        return 1.0;
    }
    let created = created.trim();
    if created.is_empty() {
        return 1.0;
    }
    let created_date = match NaiveDate::parse_from_str(created, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return 1.0, // unknown age → don't penalise
    };
    let age_days = (today - created_date).num_days().max(0) as f64;
    0.5_f64.powf(age_days / HALF_LIFE_DAYS)
}

// ── Similarity (for MMR) ─────────────────────────────────────────────────────

/// Cosine similarity of two equal-length vectors. Returns 0.0 for a zero vector.
fn cosine_sim(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let (x, y) = (*x as f64, *y as f64);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Jaccard similarity of two token lists: |∩| / |∪|. Empty-on-both → 0.0.
fn jaccard(a: &[String], b: &[String]) -> f64 {
    let sa: HashSet<&String> = a.iter().collect();
    let sb: HashSet<&String> = b.iter().collect();
    let inter = sa.intersection(&sb).count();
    let union = sa.union(&sb).count();
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Similarity between two candidates: cosine of representative embeddings when
/// both have one, else Jaccard over content tokens.
fn candidate_sim(a: &RankInput, b: &RankInput) -> f64 {
    match (&a.embedding, &b.embedding) {
        (Some(ea), Some(eb)) => cosine_sim(ea, eb),
        _ => jaccard(&a.terms, &b.terms),
    }
}

// ── MMR ──────────────────────────────────────────────────────────────────────

/// Maximal Marginal Relevance ordering. Greedily selects indices that maximise
/// `λ * relevance − (1 − λ) * max similarity to already-selected`, so each pick
/// trades off relevance against redundancy with the running selection.
///
/// `sim(i, j)` is the pairwise similarity. Returns selected indices, best first,
/// up to `n`.
fn mmr_order<F: Fn(usize, usize) -> f64>(
    relevance: &[f64],
    sim: F,
    lambda: f64,
    n: usize,
) -> Vec<usize> {
    let count = relevance.len();
    let target = n.min(count);
    let mut selected: Vec<usize> = Vec::with_capacity(target);
    let mut remaining: Vec<usize> = (0..count).collect();

    while selected.len() < target && !remaining.is_empty() {
        let mut best_pos = 0usize;
        let mut best_score = f64::NEG_INFINITY;
        for (pos, &cand) in remaining.iter().enumerate() {
            // Redundancy penalty: similarity to the nearest already-selected.
            let max_sim = selected
                .iter()
                .map(|&s| sim(cand, s))
                .fold(0.0_f64, f64::max);
            let score = lambda * relevance[cand] - (1.0 - lambda) * max_sim;
            if score > best_score {
                best_score = score;
                best_pos = pos;
            }
        }
        selected.push(remaining.remove(best_pos));
    }
    selected
}

// ── Top-level ranker ─────────────────────────────────────────────────────────

/// Rank candidates and return the top `top_n` display results.
///
/// `has_embeddings` reflects whether the query was embedded (an API key is set).
/// When false, the vector channel is ignored and ranking is pure BM25 — the
/// documented fallback.
pub fn rank(
    items: Vec<RankInput>,
    has_embeddings: bool,
    today: NaiveDate,
    top_n: usize,
) -> Vec<SearchResult> {
    if items.is_empty() {
        return Vec::new();
    }

    // 1. Normalise each channel. BM25 rank is "lower = better" and negative, so
    //    flip the sign before normalising (higher = better).
    let bm25_vals: Vec<Option<f64>> = items.iter().map(|i| i.bm25_rank.map(|r| -r)).collect();
    let bm25_norm = minmax_normalize(&bm25_vals);

    // Vector channel: cosine *distance* → similarity (1 − dist), then normalise.
    let vec_vals: Vec<Option<f64>> = items.iter().map(|i| i.vec_dist.map(|d| 1.0 - d)).collect();
    let vec_norm = minmax_normalize(&vec_vals);

    // 2 + 3. Merge then apply temporal decay (floored).
    let relevance: Vec<f64> = items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let merged = if has_embeddings {
                BM25_WEIGHT * bm25_norm[idx] + VEC_WEIGHT * vec_norm[idx]
            } else {
                bm25_norm[idx]
            };
            let decay = decay_factor(&item.result.created, &item.result.status, today);
            merged * (DECAY_FLOOR + (1.0 - DECAY_FLOOR) * decay)
        })
        .collect();

    // 4. MMR re-rank for diversity.
    let order = mmr_order(
        &relevance,
        |i, j| candidate_sim(&items[i], &items[j]),
        MMR_LAMBDA,
        top_n,
    );

    // 5. Project to display results in MMR order.
    let mut items = items;
    order
        .into_iter()
        .map(|idx| std::mem::take(&mut items[idx].result))
        .collect()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn result(name: &str, created: &str, status: &str) -> SearchResult {
        SearchResult {
            path: format!("/m/{name}.md"),
            name: name.to_string(),
            type_: "feedback".to_string(),
            projects: vec![],
            created: created.to_string(),
            updated: created.to_string(),
            tags: vec![],
            status: status.to_string(),
            excerpt: String::new(),
        }
    }

    fn item(
        name: &str,
        bm25: Option<f64>,
        dist: Option<f64>,
        emb: Option<Vec<f32>>,
        terms: &[&str],
    ) -> RankInput {
        RankInput {
            result: result(name, "2026-06-20", "active"),
            bm25_rank: bm25,
            vec_dist: dist,
            embedding: emb,
            terms: terms.iter().map(|s| s.to_string()).collect(),
        }
    }

    // ── minmax_normalize (combiner) ──────────────────────────────────────────

    #[test]
    fn normalize_maps_present_to_unit_range_and_absent_to_zero() {
        let out = minmax_normalize(&[Some(-1.0), Some(-3.0), None]);
        // After mapping: -1 is best (→1.0), -3 worst (→0.0), None →0.0.
        assert_eq!(out, vec![1.0, 0.0, 0.0]);
    }

    #[test]
    fn normalize_all_equal_present_maps_to_one() {
        let out = minmax_normalize(&[Some(2.0), Some(2.0)]);
        assert_eq!(out, vec![1.0, 1.0], "a single distinct value is maximally relevant");
    }

    #[test]
    fn normalize_all_absent_is_zeros() {
        assert_eq!(minmax_normalize(&[None, None]), vec![0.0, 0.0]);
    }

    // ── decay_factor (evaluator) ─────────────────────────────────────────────

    #[test]
    fn decay_fresh_file_is_one() {
        assert!((decay_factor("2026-06-20", "active", date("2026-06-20")) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn decay_at_half_life_is_one_half() {
        // 180 days after creation → exactly one half-life.
        let d = decay_factor("2026-01-01", "active", date("2026-06-30"));
        assert!((d - 0.5).abs() < 0.02, "got {d}");
    }

    #[test]
    fn decay_evergreen_status_does_not_decay() {
        // An old file marked evergreen keeps full weight...
        assert_eq!(decay_factor("2020-01-01", "evergreen", date("2026-06-20")), 1.0);
        assert_eq!(decay_factor("2020-01-01", "pinned", date("2026-06-20")), 1.0);
        // ...but the default `active` status is NOT evergreen — it decays.
        assert!(decay_factor("2020-01-01", "active", date("2026-06-20")) < 0.01);
    }

    #[test]
    fn decay_missing_or_bad_date_does_not_penalise() {
        assert_eq!(decay_factor("", "active", date("2026-06-20")), 1.0);
        assert_eq!(decay_factor("not-a-date", "active", date("2026-06-20")), 1.0);
    }

    #[test]
    fn decay_future_date_clamped_to_one() {
        assert!((decay_factor("2027-01-01", "active", date("2026-06-20")) - 1.0).abs() < 1e-9);
    }

    // ── similarity ───────────────────────────────────────────────────────────

    #[test]
    fn cosine_identical_is_one_orthogonal_is_zero() {
        assert!((cosine_sim(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert!(cosine_sim(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-9);
    }

    #[test]
    fn cosine_zero_vector_is_zero() {
        assert_eq!(cosine_sim(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }

    #[test]
    fn jaccard_overlap() {
        let a = vec!["x".to_string(), "y".to_string()];
        let b = vec!["y".to_string(), "z".to_string()];
        assert!((jaccard(&a, &b) - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(jaccard(&a, &a), 1.0);
        assert_eq!(jaccard(&a, &["q".to_string()]), 0.0);
    }

    // ── rank: merge weighting (combiner, fires/doesn't-fire) ──────────────────

    #[test]
    fn rank_pure_bm25_when_no_embeddings_ignores_vectors() {
        // FTS5 rank is more-negative = better. File A is the stronger BM25 hit
        // (-5.0) but has a poor vector; File B is a weak BM25 hit (-1.0) with a
        // great vector. With embeddings OFF, the vector is ignored and A wins.
        let items = vec![
            item("a", Some(-5.0), Some(0.9), None, &["a"]),
            item("b", Some(-1.0), Some(0.01), None, &["b"]),
        ];
        let out = rank(items, false, date("2026-06-20"), 10);
        assert_eq!(out[0].name, "a", "BM25-only mode ranks the strong BM25 hit first");
    }

    #[test]
    fn rank_vector_channel_decides_when_no_bm25_hits() {
        // The "no exact words" case (e.g. a paraphrased query): neither file is
        // a BM25 hit, so ranking is driven entirely by vector similarity. B's
        // chunk is the closer semantic match (smaller distance), so it surfaces
        // first — this is what makes semantic recall work.
        let items = vec![
            item("a", None, Some(0.5), Some(vec![1.0, 0.0]), &["a"]),
            item("b", None, Some(0.0), Some(vec![0.0, 1.0]), &["b"]),
        ];
        let out = rank(items, true, date("2026-06-20"), 10);
        assert_eq!(out[0].name, "b", "the closer semantic match surfaces first");
    }

    #[test]
    fn rank_temporal_decay_demotes_older_when_relevance_equal() {
        // Two equally-relevant BM25 hits; the older one should rank lower.
        let mut fresh = item("fresh", Some(-2.0), None, None, &["fresh"]);
        fresh.result = result("fresh", "2026-06-20", "active");
        let mut old = item("old", Some(-2.0), None, None, &["old"]);
        old.result = result("old", "2024-06-20", "active");
        let out = rank(vec![old, fresh], false, date("2026-06-20"), 10);
        assert_eq!(out[0].name, "fresh", "recency breaks the tie");
    }

    #[test]
    fn rank_mmr_diversifies_near_duplicates() {
        // Three equally-relevant files; two are embedding-identical (a near-
        // duplicate pair), one is orthogonal. After the top pick, MMR's
        // diversity term should prefer the orthogonal file over the redundant
        // near-duplicate, even though all three tie on relevance.
        let dup_a = item("dup_a", Some(-1.0), Some(0.0), Some(vec![1.0, 0.0]), &["dup"]);
        let dup_b = item("dup_b", Some(-1.0), Some(0.0), Some(vec![1.0, 0.0]), &["dup"]);
        let distinct = item("distinct", Some(-1.0), Some(0.0), Some(vec![0.0, 1.0]), &["other"]);
        let out = rank(vec![dup_a, dup_b, distinct], true, date("2026-06-20"), 3);
        assert_eq!(out[0].name, "dup_a", "first pick is the top of the tied set");
        assert_eq!(
            out[1].name, "distinct",
            "MMR prefers the diverse file over the near-duplicate"
        );
    }

    #[test]
    fn rank_returns_at_most_top_n() {
        let items: Vec<RankInput> = (0..5)
            .map(|i| item(&format!("f{i}"), Some(-(i as f64) - 1.0), None, None, &["t"]))
            .collect();
        let out = rank(items, false, date("2026-06-20"), 3);
        assert_eq!(out.len(), 3, "top_n caps the result count");
    }

    #[test]
    fn rank_empty_input_is_empty() {
        assert!(rank(Vec::new(), true, date("2026-06-20"), 10).is_empty());
    }
}
