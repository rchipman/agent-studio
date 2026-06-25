//! audit.rs
//!
//! Consistency Audit (TIN-1695) — surface contradictions across the memory base.
//!
//! Two stages:
//!   1. **Cluster** (local, instant): group files whose embeddings are close, so
//!      we only reason over plausibly-conflicting pairs, not all N² of them.
//!   2. **Judge** (local LLM via `reason`): ask the reasoning model whether each
//!      related pair actually contradicts, and collect concrete findings.
//!
//! Embeddings find *related* notes; the LLM judges *truth*. Both run locally
//! (candle + Ollama), so the whole audit is free and private. The pass is bounded
//! to the most-similar pairs so a full-library audit stays in the minutes range.
//!
//! Per-pair LLM verdicts are cached in `audit_verdict_cache` (TIN-audit-cache).
//! Cache key: (hash_lo, hash_hi, model) where hash_lo/hash_hi are the sorted
//! SHA-256 hex digests of the two note bodies (order-independent). On a re-run
//! where no note body changed, every pair hits the cache and zero LLM calls are
//! made.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::search::{blob_to_embedding, Db};

/// Only consider pairs at least this similar (cosine) as "about the same thing".
/// Reused by the continuity scorer (TIN-1730) as its candidate similarity floor.
pub(crate) const SIM_FLOOR: f32 = 0.45;
/// Bound the LLM work: judge at most this many of the most-similar pairs.
const MAX_PAIRS: usize = 40;
/// Per-note text handed to the model (chars). Keeps prompts fast and in-context.
const BODY_CHARS: usize = 1500;

// ── Types ────────────────────────────────────────────────────────────────────

/// One flagged contradiction between two notes.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Finding {
    /// The two file paths involved.
    pub files: Vec<String>,
    /// Display names for those files.
    pub names: Vec<String>,
    /// One-sentence description of the conflict (from the model).
    pub summary: String,
}

// ── Cache schema ─────────────────────────────────────────────────────────────

/// SQL to create the verdict cache table. Safe to call repeatedly (idempotent).
const CACHE_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS audit_verdict_cache (
        hash_lo       TEXT NOT NULL,
        hash_hi       TEXT NOT NULL,
        model         TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        created_ts    TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (hash_lo, hash_hi, model)
    );
";

/// Ensure the `audit_verdict_cache` table exists on `conn`. Idempotent.
pub(crate) fn ensure_cache_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(CACHE_SCHEMA)
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/// SHA-256 hex digest of `body`. Used to build the cache key.
fn body_hash(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    format!("{:x}", h.finalize())
}

/// Sort two body hashes so the pair key is order-independent.
/// Returns `(hash_lo, hash_hi)` where `hash_lo <= hash_hi` lexicographically.
fn sorted_hashes(ha: &str, hb: &str) -> (String, String) {
    if ha <= hb {
        (ha.to_string(), hb.to_string())
    } else {
        (hb.to_string(), ha.to_string())
    }
}

/// Look up a cached verdict. Returns `Some(conflicts)` on a hit, `None` on miss.
fn cache_get(
    conn: &Connection,
    hash_lo: &str,
    hash_hi: &str,
    model: &str,
) -> Option<Vec<String>> {
    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT conflicts_json FROM audit_verdict_cache \
         WHERE hash_lo = ?1 AND hash_hi = ?2 AND model = ?3",
        params![hash_lo, hash_hi, model],
        |row| row.get(0),
    );
    result.ok().and_then(|json| serde_json::from_str(&json).ok())
}

/// Store a verdict in the cache. Replaces any existing row for the same key.
fn cache_put(
    conn: &Connection,
    hash_lo: &str,
    hash_hi: &str,
    model: &str,
    conflicts: &[String],
) -> rusqlite::Result<()> {
    let json = serde_json::to_string(conflicts).unwrap_or_else(|_| "[]".to_string());
    let ts = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO audit_verdict_cache \
         (hash_lo, hash_hi, model, conflicts_json, created_ts) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![hash_lo, hash_hi, model, json, ts],
    )?;
    Ok(())
}

// ── Clustering ───────────────────────────────────────────────────────────────

/// Cosine similarity of two equal-length vectors (0 for a zero vector).
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// Mean, renormalized embedding per file from the `chunks` table. Files with no
/// embedded chunk are absent (the audit needs the embedding pass to have run).
fn file_vectors(conn: &Connection) -> rusqlite::Result<Vec<(String, Vec<f32>)>> {
    let mut stmt = conn.prepare(
        "SELECT file_path, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY file_path",
    )?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let blob: Vec<u8> = row.get(1)?;
        Ok((path, blob_to_embedding(&blob)))
    })?;

    let mut sums: HashMap<String, (Vec<f32>, usize)> = HashMap::new();
    for r in rows {
        let (path, vec) = r?;
        let entry = sums.entry(path).or_insert_with(|| (vec![0.0; vec.len()], 0));
        if entry.0.len() == vec.len() {
            for (acc, v) in entry.0.iter_mut().zip(&vec) {
                *acc += v;
            }
            entry.1 += 1;
        }
    }

    let mut out = Vec::new();
    for (path, (mut sum, n)) in sums {
        if n == 0 {
            continue;
        }
        for v in sum.iter_mut() {
            *v /= n as f32;
        }
        let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in sum.iter_mut() {
                *v /= norm;
            }
        }
        out.push((path, sum));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Candidate pairs (indices into `vectors`) with cosine ≥ `floor`, most-similar
/// first. Deduped — each unordered pair appears once.
pub fn candidate_pairs(vectors: &[(String, Vec<f32>)], floor: f32) -> Vec<(usize, usize, f32)> {
    let mut pairs = Vec::new();
    for i in 0..vectors.len() {
        for j in (i + 1)..vectors.len() {
            let sim = cosine(&vectors[i].1, &vectors[j].1);
            if sim >= floor {
                pairs.push((i, j, sim));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    pairs
}

// ── Judging ──────────────────────────────────────────────────────────────────

// Judge prompt (TIN-1753). Deliberately TERSE with explicit not-a-conflict rules
// and NO chain-of-thought: on the local models this judge runs against (incl.
// code-tuned 7B models), "think step by step" framing measurably *lowers*
// discrimination — the model reasons itself into false conflicts. A tight,
// rule-first instruction reaches ~94% (0 false negatives) on the golden set in
// `judge_golden_set_accuracy`, where the prior prompt false-positived on agreeing
// notes and false-negatived on blatant contradictions. Keep the CONFLICT:/NONE
// output contract — `parse_conflicts` depends on it.
pub(crate) const AUDIT_SYSTEM: &str = "\
You audit a personal knowledge base for CONTRADICTIONS between two notes. A \
contradiction is a concrete factual conflict: two DIFFERENT and MUTUALLY \
EXCLUSIVE values for the SAME attribute of the SAME thing (a price, date, name, \
status, or an either/or decision).

Output exactly one line. If they genuinely contradict:
CONFLICT: <one sentence naming both conflicting values>
Otherwise:
NONE

Output NONE (NOT a conflict) when:
- The values agree or are the same, even if worded differently or rounded \
(\"about $5\" and \"$4.99\" agree; \"March\" and \"March 3\" agree).
- Both statements can be true at the same time (a tour AND an address prompt; a \
price AND a color).
- The two notes are about DIFFERENT things (Attic's price vs Understory's price).
- One note simply adds detail to, or restates, the other.

Be conservative: only output CONFLICT when one note's value makes the other's \
value impossible.";

/// Extract `CONFLICT:` lines from a model response (case-insensitive, lenient).
pub(crate) fn parse_conflicts(resp: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in resp.lines() {
        let t = line.trim();
        let lower = t.to_lowercase();
        if let Some(pos) = lower.find("conflict:") {
            let desc = t[pos + "conflict:".len()..].trim();
            if !desc.is_empty() {
                out.push(desc.to_string());
            }
        }
    }
    out
}

fn truncate(s: &str) -> String {
    s.chars().take(BODY_CHARS).collect()
}

/// Ask the reasoning model whether two notes contradict; return the conflict
/// summaries (empty when consistent).
pub(crate) async fn judge_pair(
    name_a: &str,
    body_a: &str,
    name_b: &str,
    body_b: &str,
) -> Result<Vec<String>> {
    let user = format!(
        "Note A — {name_a}:\n{}\n\n---\n\nNote B — {name_b}:\n{}",
        truncate(body_a),
        truncate(body_b),
    );
    let resp = crate::reason::complete(AUDIT_SYSTEM, &user).await?;
    Ok(parse_conflicts(&resp))
}

// ── Command ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

/// Run the consistency audit: cluster related files, judge the most-similar
/// pairs with the local reasoning model, and return concrete findings. Emits
/// `audit://progress` as it goes. Requires the embedding pass to have run and a
/// reasoning model (Ollama) to be reachable.
///
/// Per-pair results are cached in `audit_verdict_cache` keyed by (body_hash_lo,
/// body_hash_hi, model). On a re-run where nothing changed, every pair hits the
/// cache and the LLM is not called at all.
#[tauri::command]
pub async fn consistency_audit(
    app: AppHandle,
    db: State<'_, Db>,
    control: tauri::State<'_, crate::TaskControl>,
) -> Result<Vec<Finding>, String> {
    // Fail early with a calm message if there's no reasoning model.
    if !crate::reason::reachable().await {
        return Err(
            "No local reasoning model found. Start Ollama and pull one (e.g. `ollama pull llama3.1:8b`)."
                .to_string(),
        );
    }
    control.audit_cancel.store(false, std::sync::atomic::Ordering::Relaxed);

    // Detect model once — used as part of the cache key so a model switch
    // automatically invalidates prior verdicts.
    let model = crate::reason::detect_model()
        .await
        .map_err(|e| e.to_string())?;

    // ── Phase A: cluster + gather bodies (locked, no await) ───────────────────
    // Also ensure the cache table exists while we hold the lock.
    let work: Vec<(String, String, String, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        // Ensure the verdict cache table exists (idempotent).
        ensure_cache_table(&conn).map_err(|e| e.to_string())?;

        let vectors = file_vectors(&conn).map_err(|e| e.to_string())?;
        let pairs = candidate_pairs(&vectors, SIM_FLOOR);
        let pairs: Vec<_> = pairs.into_iter().take(MAX_PAIRS).collect();

        // Resolve name + body for each file once.
        let mut meta: HashMap<String, (String, String)> = HashMap::new();
        let mut load = |path: &str, conn: &Connection| -> (String, String) {
            if let Some(m) = meta.get(path) {
                return m.clone();
            }
            let got = conn
                .query_row(
                    "SELECT name, body FROM memory_files WHERE path = ?1",
                    rusqlite::params![path],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .unwrap_or_else(|_| (path.rsplit('/').next().unwrap_or(path).to_string(), String::new()));
            meta.insert(path.to_string(), got.clone());
            got
        };

        let mut work = Vec::new();
        for (i, j, _sim) in pairs {
            let pa = vectors[i].0.clone();
            let pb = vectors[j].0.clone();
            let (na, ba) = load(&pa, &conn);
            let (nb, bb) = load(&pb, &conn);
            work.push((pa, format!("{na}\u{0}{}", ba), pb, format!("{nb}\u{0}{}", bb)));
        }
        work
    };

    let total = work.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    // ── Phase B: judge each pair with the LLM (async, no lock) ────────────────
    // Cache lookups and writes each re-acquire the lock briefly.
    let mut findings = Vec::new();
    for (idx, (path_a, packed_a, path_b, packed_b)) in work.into_iter().enumerate() {
        // Honour a cancellation request — return partial findings gathered so far.
        if control.audit_cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let (name_a, body_a) = split_packed(&packed_a);
        let (name_b, body_b) = split_packed(&packed_b);

        // Build the order-independent cache key from the two note bodies.
        let ha = body_hash(body_a);
        let hb = body_hash(body_b);
        let (hash_lo, hash_hi) = sorted_hashes(&ha, &hb);

        // Cache lookup (lock, read, release).
        let cached = {
            if let Ok(conn) = db.0.lock() {
                cache_get(&conn, &hash_lo, &hash_hi, &model)
            } else {
                None
            }
        };

        let conflicts = if let Some(cached_conflicts) = cached {
            // Cache hit — no LLM call needed.
            log::debug!("[audit] cache hit pair {idx} ({hash_lo:.8}…/{hash_hi:.8}…)");
            cached_conflicts
        } else {
            // Cache miss — call the LLM and store the result.
            match judge_pair(name_a, body_a, name_b, body_b).await {
                Ok(result) => {
                    // Store result (including empty vec for consistent pairs).
                    if let Ok(conn) = db.0.lock() {
                        if let Err(e) = cache_put(&conn, &hash_lo, &hash_hi, &model, &result) {
                            log::warn!("[audit] cache write failed for pair {idx}: {e}");
                        }
                    }
                    result
                }
                Err(e) => {
                    log::warn!("[audit] pair {idx} judge failed: {e}");
                    let _ = app.emit("audit://progress", Progress { done: idx + 1, total });
                    continue;
                }
            }
        };

        for summary in conflicts {
            let finding = Finding {
                files: vec![path_a.clone(), path_b.clone()],
                names: vec![name_a.to_string(), name_b.to_string()],
                summary,
            };
            let _ = app.emit("audit://finding", &finding);
            findings.push(finding);
        }
        let _ = app.emit("audit://progress", Progress { done: idx + 1, total });
    }

    Ok(findings)
}

/// Cancel an in-progress consistency audit. Safe to call at any time.
#[tauri::command]
pub fn cancel_audit(control: tauri::State<'_, crate::TaskControl>) {
    control.audit_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Unpack the `name\0body` packing used to carry both through Phase A.
fn split_packed(s: &str) -> (&str, &str) {
    match s.split_once('\u{0}') {
        Some((n, b)) => (n, b),
        None => (s, ""),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// cancel_audit sets the flag which the loop checks.
    #[test]
    fn cancel_flag_can_be_set_and_cleared() {
        let ctrl = crate::TaskControl::default();
        assert!(!ctrl.audit_cancel.load(std::sync::atomic::Ordering::Relaxed));
        ctrl.audit_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(ctrl.audit_cancel.load(std::sync::atomic::Ordering::Relaxed));
        ctrl.audit_cancel.store(false, std::sync::atomic::Ordering::Relaxed);
        assert!(!ctrl.audit_cancel.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn parse_conflicts_extracts_and_ignores_none() {
        let resp = "CONFLICT: A says $9/mo but B says $12/mo.\nsome reasoning\nNONE";
        assert_eq!(parse_conflicts(resp), vec!["A says $9/mo but B says $12/mo."]);
        assert!(parse_conflicts("NONE").is_empty());
        assert!(parse_conflicts("These notes agree on everything.").is_empty());
    }

    #[test]
    fn candidate_pairs_links_similar_not_orthogonal() {
        let v = |a: usize| {
            let mut x = vec![0.0f32; 8];
            x[a] = 1.0;
            x
        };
        // 0 and 1 share most of their direction; 2 is orthogonal.
        let mut near = v(0);
        near[1] = 0.9;
        let vectors = vec![
            ("a.md".to_string(), v(0)),
            ("b.md".to_string(), near),
            ("c.md".to_string(), v(5)),
        ];
        let pairs = candidate_pairs(&vectors, SIM_FLOOR);
        // a–b is similar and present; nothing pairs with the orthogonal c.
        assert!(pairs.iter().any(|(i, j, _)| (*i, *j) == (0, 1)));
        assert!(!pairs.iter().any(|(i, j, _)| *i == 2 || *j == 2));
    }

    // ── Cache unit tests (no live model) ─────────────────────────────────────

    fn make_cache_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_cache_table(&conn).unwrap();
        conn
    }

    /// (a) Hash-pair ordering is symmetric: (a,b) and (b,a) produce the same key.
    #[test]
    fn cache_key_is_order_independent() {
        let ha = body_hash("note body alpha");
        let hb = body_hash("note body beta");

        let (lo1, hi1) = sorted_hashes(&ha, &hb);
        let (lo2, hi2) = sorted_hashes(&hb, &ha);

        assert_eq!(lo1, lo2, "hash_lo must be identical regardless of argument order");
        assert_eq!(hi1, hi2, "hash_hi must be identical regardless of argument order");
        assert!(lo1 <= hi1, "hash_lo must be <= hash_hi lexicographically");
    }

    /// (b) Cache store→get round-trips a Vec<String>, including the empty
    ///     (consistent) case — consistent pairs MUST be cached.
    #[test]
    fn cache_roundtrip_conflicts_and_empty() {
        let conn = make_cache_conn();
        let (lo, hi) = sorted_hashes("aaa", "bbb");
        let model = "llama3.1:8b";

        // Store a non-empty conflict list.
        let conflicts = vec!["Note A says $9 but Note B says $12.".to_string()];
        cache_put(&conn, &lo, &hi, model, &conflicts).unwrap();
        let got = cache_get(&conn, &lo, &hi, model);
        assert_eq!(got, Some(conflicts.clone()), "conflict list should round-trip");

        // Overwrite with an empty list (consistent pair) — must also round-trip.
        cache_put(&conn, &lo, &hi, model, &[]).unwrap();
        let got_empty = cache_get(&conn, &lo, &hi, model);
        assert_eq!(
            got_empty,
            Some(vec![]),
            "empty conflicts (consistent pair) must be cached and returned as Some([])"
        );
    }

    /// (c) A changed body hash causes a cache miss.
    #[test]
    fn cache_miss_on_changed_body() {
        let conn = make_cache_conn();
        let body_a = "original note body";
        let body_b = "other note body";
        let ha = body_hash(body_a);
        let hb = body_hash(body_b);
        let (lo, hi) = sorted_hashes(&ha, &hb);
        let model = "llama3.1:8b";

        // Store with original bodies.
        cache_put(&conn, &lo, &hi, model, &["conflict".to_string()]).unwrap();
        assert!(cache_get(&conn, &lo, &hi, model).is_some(), "should be a hit");

        // Compute key for a changed body — must be a miss.
        let ha2 = body_hash("CHANGED note body");
        let (lo2, hi2) = sorted_hashes(&ha2, &hb);
        assert!(
            (lo2 != lo || hi2 != hi),
            "changed body must produce a different cache key"
        );
        assert!(
            cache_get(&conn, &lo2, &hi2, model).is_none(),
            "changed body hash must cause a cache miss"
        );
    }

    /// Labeled judge golden set (TIN-1753). Each case: (id, note A, note B,
    /// expect_conflict). Covers the taxonomy that broke the old prompt — exact
    /// agreement, approximate/rounded agreement, blatant contradiction, near
    /// contradiction, complementary-both-true, different-entity, restatement, and
    /// realistic frontmattered multi-claim notes (the shape that false-positived
    /// in the wild). This is the REAL measurement the synthetic-vector eval in
    /// continuity.rs could never provide — it exercises the actual model.
    pub(crate) const JUDGE_GOLDEN: &[(&str, &str, &str, bool)] = &[
        ("agree-price-exact", "Attic is priced at $4.99 per month.", "Attic costs $4.99/mo for the subscription.", false),
        ("contradict-price-blatant", "Attic is priced at $100 per month.", "Attic costs $4.99 per month.", true),
        ("contradict-price-near", "Attic Pro will cost $12 per month.", "Attic Pro is priced at $9 per month.", true),
        ("overlap-both-true", "Attic uses a forest-green and cream color palette.", "Attic is priced at $4.99 per month.", false),
        ("overlap-complementary", "Attic's onboarding shows a guided tour on first launch.", "Attic's onboarding asks for the user's home address.", false),
        ("unrelated", "The welcome screen greets new users with a tour.", "The brand palette is forest green on cream.", false),
        ("contradict-status", "The launch date for Understory is March 2026.", "Understory will launch in September 2026.", true),
        ("agree-status", "Understory launches in March 2026.", "The Understory launch is set for March 2026.", false),
        ("contradict-decision", "We decided to use SQLite for the index.", "The index will be stored in Postgres, not SQLite.", true),
        ("agree-restate", "The memory root defaults to ~/Projects/tfl/memory.", "By default, memory files live in ~/Projects/tfl/memory.", false),
        ("different-entity-same-price", "Attic is priced at $4.99 per month.", "Understory is priced at $9.99 per month.", false),
        ("real-price-agree",
            "---\nname: attic-pricing\ntype: project\n---\nAttic ships a single subscription tier. After testing $3.99 and $5.99 in the prototype, we settled on **$4.99/month** as the launch price. Annual is $49.99. The free trial is 14 days.",
            "---\nname: attic-launch-checklist\ntype: reference\n---\nPre-app-store checklist: screenshots done, privacy policy linked, subscription configured at $4.99/mo (annual $49.99), trial 14 days. TestFlight build uploaded.",
            false),
        ("real-price-contradict",
            "---\nname: attic-pricing\ntype: project\n---\nAttic ships a single subscription tier at **$4.99/month** (annual $49.99) after prototype price testing.",
            "---\nname: attic-pricing-update\ntype: project\n---\nWe are raising Attic to **$100/month** effective next release. The annual plan is discontinued.",
            true),
        ("real-decision-reversal",
            "---\nname: index-storage\ntype: project\n---\nThe search index lives in a single SQLite database (.studio-index.db) in the memory root, using FTS5 + sqlite-vec. One file, local, zero-config.",
            "---\nname: index-storage-v2\ntype: project\n---\nWe migrated the index off SQLite to a hosted Postgres instance with pgvector; the index is no longer a local file.",
            true),
    ];

    /// Live-model judge accuracy over [`JUDGE_GOLDEN`] (TIN-1753). Prints a
    /// confusion matrix and asserts the judge is genuinely discriminating:
    /// overall accuracy ≥ 80% AND zero false negatives (it must never miss a
    /// blatant contradiction — the worst failure for continuity scoring). This is
    /// the gate that would have caught the old prompt (which false-positived on
    /// agreement and false-negatived on contradiction) and the chain-of-thought
    /// regression. Needs a running Ollama.
    /// Run: cargo test --lib audit::tests::judge_golden -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs a running Ollama with an instruct model"]
    async fn judge_golden_set_accuracy() {
        assert!(
            crate::reason::reachable().await,
            "no reasoning model reachable — start Ollama (e.g. `ollama pull llama3.1:8b`)"
        );
        let (mut tp, mut tn, mut fp, mut fn_) = (0u32, 0u32, 0u32, 0u32);
        println!("\nJudge golden set ({} cases):", JUDGE_GOLDEN.len());
        for (id, a, b, expect) in JUDGE_GOLDEN {
            let conflicts = judge_pair("note-a", a, "note-b", b)
                .await
                .expect("judge should respond");
            let pred = !conflicts.is_empty();
            let ok = pred == *expect;
            match (*expect, pred) {
                (true, true) => tp += 1,
                (false, false) => tn += 1,
                (false, true) => fp += 1,
                (true, false) => fn_ += 1,
            }
            println!(
                "  {}  {:28}  gold={:8} pred={:8}",
                if ok { "✓" } else { "✗" },
                id,
                if *expect { "CONFLICT" } else { "NONE" },
                if pred { "CONFLICT" } else { "NONE" },
            );
        }
        let total = JUDGE_GOLDEN.len() as u32;
        let acc = (tp + tn) as f32 / total as f32;
        println!(
            "  ── acc={:.0}%  TP={tp} TN={tn} FP={fp} FN={fn_}  (FP=false alarm, FN=missed contradiction)",
            acc * 100.0
        );
        assert_eq!(fn_, 0, "judge MISSED a contradiction (false negative) — unacceptable for continuity scoring");
        assert!(acc >= 0.80, "judge accuracy {:.0}% below the 80% floor (FP={fp} FN={fn_})", acc * 100.0);
    }

    // Needs a running Ollama. Proves a planted contradiction is caught and a
    // consistent pair is not. Run: cargo test --lib audit -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs a running Ollama with an instruct model"]
    async fn judge_pair_catches_planted_conflict() {
        let conflicts = judge_pair(
            "pricing",
            "Attic Pro is priced at $9 per month.",
            "pricing-decision",
            "We decided Attic Pro will cost $12 per month.",
        )
        .await
        .expect("judge should respond");
        assert!(!conflicts.is_empty(), "should flag the $9 vs $12 conflict: {conflicts:?}");

        let none = judge_pair(
            "onboarding",
            "The welcome screen greets new users with a tour.",
            "colors",
            "The brand palette is forest green on cream.",
        )
        .await
        .expect("judge should respond");
        assert!(none.is_empty(), "unrelated notes should not conflict: {none:?}");
    }
}
