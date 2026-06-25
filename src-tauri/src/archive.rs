//! archive.rs
//!
//! Durable session archive + retention (TIN-1759). Claude Code prunes its own
//! `~/.claude/projects` transcripts over time; Studio copies each session out
//! into its own app-data store before that can happen, so the history survives.
//!
//! ── On-disk layout (mirrors Claude Code's tree) ─────────────────────────────
//!   archive/<project-slug>/<sessionId>.jsonl.zst
//!   archive/<project-slug>/<sessionId>/subagents/agent-<id>.jsonl.zst
//!   archive/<project-slug>/<sessionId>/subagents/agent-<id>.meta.json   (uncompressed)
//!   archive/archive.json                                                 (manifest)
//!
//! `<project-slug>` is the project directory name copied verbatim from the
//! transcripts root (NO re-derivation). The manifest is the source of truth for
//! size + prune, so the hot path never walks the disk.
//!
//! ── Read fallback ───────────────────────────────────────────────────────────
//! `get_session` reads the freshest copy: live path first (Claude Code may still
//! be appending), then the archived `.zst`, then a not-found error. The archive
//! is never the primary source while the live file exists.
//!
//! ── Retention ───────────────────────────────────────────────────────────────
//! `run_retention_cleanup` deletes oldest-first (by sourceMtime) until the store
//! is under the configured cap / within the kept window. It NEVER touches
//! `~/.claude`; it only ever removes files under the archive root.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::{load_settings, RetentionPolicy};

/// zstd level for write-once / read-rarely transcripts: spend CPU on ratio.
const ZSTD_LEVEL: i32 = 19;

/// Manifest schema version. Bump only on a breaking on-disk change.
const MANIFEST_VERSION: u32 = 1;

// ── zstd helpers ─────────────────────────────────────────────────────────────

/// Compress a byte slice at the archive level.
pub fn zstd_compress(bytes: &[u8]) -> io::Result<Vec<u8>> {
    zstd::stream::encode_all(bytes, ZSTD_LEVEL)
}

/// Decompress a zstd byte slice.
pub fn zstd_decompress(bytes: &[u8]) -> io::Result<Vec<u8>> {
    zstd::stream::decode_all(bytes)
}

/// Read a file that may be zstd-compressed: `.zst` → decode, else read as text.
/// Used by the `get_session` read fallback so the archived copy is transparent.
pub fn read_maybe_zst(path: &Path) -> io::Result<String> {
    if path.extension().and_then(|e| e.to_str()) == Some("zst") {
        let raw = fs::read(path)?;
        let bytes = zstd_decompress(&raw)?;
        String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    } else {
        fs::read_to_string(path)
    }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/// One archived session row. `relPath` is the session's `.jsonl.zst` path
/// relative to the archive root (e.g. `proj/sess1.jsonl.zst`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub session_id: String,
    pub project: String,
    pub rel_path: String,
    /// Live-file mtime at archive time; re-archive when it drifts.
    pub source_mtime: u64,
    /// Wall-clock seconds when this row was last written.
    pub archived_at: u64,
    /// Uncompressed size of the top-level session bytes.
    pub original_bytes: u64,
    /// Stored (compressed) size: session + subagents + meta sidecars.
    pub stored_bytes: u64,
    /// Provenance: where the bytes came from.
    pub origin: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub sessions: Vec<ManifestEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Manifest {
            version: MANIFEST_VERSION,
            sessions: Vec::new(),
        }
    }
}

impl Manifest {
    fn index_of(&self, session_id: &str) -> Option<usize> {
        self.sessions.iter().position(|e| e.session_id == session_id)
    }

    fn total_stored_bytes(&self) -> u64 {
        self.sessions.iter().map(|e| e.stored_bytes).sum()
    }
}

/// Path to the manifest file inside the archive root.
fn manifest_path(archive_root: &Path) -> PathBuf {
    archive_root.join("archive.json")
}

/// Load the manifest, returning an empty one if it is absent or unreadable.
pub fn load_manifest(archive_root: &Path) -> Manifest {
    let p = manifest_path(archive_root);
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return Manifest::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Write the manifest atomically (temp + rename) so a crash never truncates it.
pub fn write_manifest(archive_root: &Path, manifest: &Manifest) -> io::Result<()> {
    fs::create_dir_all(archive_root)?;
    let final_path = manifest_path(archive_root);
    let tmp_path = archive_root.join("archive.json.tmp");
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp_path, json.as_bytes())?;
    fs::rename(&tmp_path, &final_path)
}

// ── Path mapping ─────────────────────────────────────────────────────────────

/// The archive store root: `<app_data_dir>/archive`.
pub fn archive_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("archive");
    Ok(dir)
}

/// Map a LIVE transcript path to its archived `.zst` path: strip the
/// transcripts-root prefix, prepend the archive root, append `.zst`. Returns
/// None when `live` is not under `transcripts_root`.
pub fn live_to_archived(
    live: &Path,
    transcripts_root: &Path,
    archive_root: &Path,
) -> Option<PathBuf> {
    let rel = live.strip_prefix(transcripts_root).ok()?;
    let mut out = archive_root.join(rel);
    let mut name = out.file_name()?.to_os_string();
    name.push(".zst");
    out.set_file_name(name);
    Some(out)
}

// ── Archive pass ─────────────────────────────────────────────────────────────

/// Progress event payload (mirrors the `audit://progress` idiom).
#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

/// Archive every top-level session under `transcripts_root` that is new or whose
/// live mtime drifted from the manifest. Writes the session + its subagents
/// (compressed) and meta sidecars (uncompressed), updates the manifest in place,
/// and returns the session ids that were (re)written so the caller can stamp
/// `archived_at` in the transcript DB. Emits `archive://progress` per session.
pub fn archive_pass<R: Runtime>(
    app: Option<&AppHandle<R>>,
    transcripts_root: &Path,
    archive_root: &Path,
    manifest: &mut Manifest,
) -> io::Result<Vec<(String, PathBuf, u64)>> {
    let sessions = collect_jsonl_files(transcripts_root);
    let total = sessions.len();
    let mut written: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut dirty = false;

    for (idx, (project, session_path)) in sessions.iter().enumerate() {
        let session_id = match session_path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let current_mtime = mtime_secs(session_path);

        let up_to_date = manifest
            .index_of(&session_id)
            .map(|i| manifest.sessions[i].source_mtime == current_mtime)
            .unwrap_or(false);

        if !up_to_date {
            if let Ok(entry) = archive_one(transcripts_root, archive_root, project, session_path) {
                let archived_at = entry.archived_at;
                upsert_entry(manifest, entry);
                dirty = true;
                written.push((session_id, session_path.clone(), archived_at));
            }
        }

        if let Some(app) = app {
            let _ = app.emit(
                "archive://progress",
                Progress {
                    done: idx + 1,
                    total,
                },
            );
        }
    }

    if dirty {
        write_manifest(archive_root, manifest)?;
    }
    Ok(written)
}

fn upsert_entry(manifest: &mut Manifest, entry: ManifestEntry) {
    match manifest.index_of(&entry.session_id) {
        Some(i) => manifest.sessions[i] = entry,
        None => manifest.sessions.push(entry),
    }
}

/// Compress + write one session (top-level + subagents + meta) into the archive
/// tree and return its manifest row. Source bytes are read from `~/.claude`;
/// nothing there is modified.
fn archive_one(
    transcripts_root: &Path,
    archive_root: &Path,
    project: &str,
    session_path: &Path,
) -> io::Result<ManifestEntry> {
    let archived_top = live_to_archived(session_path, transcripts_root, archive_root)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "session outside root"))?;

    let rel_path = archived_top
        .strip_prefix(archive_root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Top-level session.
    let top_bytes = fs::read(session_path)?;
    let original_bytes = top_bytes.len() as u64;
    let compressed = zstd_compress(&top_bytes)?;
    let mut stored_bytes = write_compressed(&archived_top, &compressed)? as u64;

    // Subagent sidecars: agent-<id>.jsonl.zst + agent-<id>.meta.json (verbatim).
    for sub in collect_subagent_files(session_path) {
        if let Some(archived_sub) = live_to_archived(&sub, transcripts_root, archive_root) {
            let sub_bytes = fs::read(&sub)?;
            let sub_comp = zstd_compress(&sub_bytes)?;
            stored_bytes += write_compressed(&archived_sub, &sub_comp)? as u64;
        }
        // The meta.json sits next to the jsonl; copy it uncompressed (tiny).
        let meta_src = sub.with_extension("meta.json");
        if meta_src.exists() {
            if let Some(archived_jsonl) = live_to_archived(&sub, transcripts_root, archive_root) {
                // archived_jsonl ends in .jsonl.zst; meta sits beside the .jsonl.
                let meta_dst = archived_jsonl
                    .parent()
                    .map(|d| d.join(meta_src.file_name().unwrap_or_default()));
                if let Some(meta_dst) = meta_dst {
                    if let Some(parent) = meta_dst.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let meta_bytes = fs::read(&meta_src)?;
                    fs::write(&meta_dst, &meta_bytes)?;
                    stored_bytes += meta_bytes.len() as u64;
                }
            }
        }
    }

    Ok(ManifestEntry {
        session_id: session_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string(),
        project: project.to_string(),
        rel_path,
        source_mtime: mtime_secs(session_path),
        archived_at: now_secs(),
        original_bytes,
        stored_bytes,
        origin: "claude-code".to_string(),
    })
}

/// Write compressed bytes to `dest`, creating parent dirs. Returns bytes written.
fn write_compressed(dest: &Path, bytes: &[u8]) -> io::Result<usize> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest, bytes)?;
    Ok(bytes.len())
}

// ── Retention ────────────────────────────────────────────────────────────────

/// Preview of what a cleanup would prune, computed from the manifest only.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrunePreview {
    pub count: usize,
    pub bytes: u64,
}

/// Compute the prefix of oldest sessions that retention would remove under the
/// given policy, plus whether the store is currently over its cap. Pure manifest
/// arithmetic — no disk access.
pub fn prune_preview(manifest: &Manifest, policy: &RetentionPolicy) -> (PrunePreview, u64) {
    let over_cap_bytes = match policy {
        RetentionPolicy::SizeCap { max_bytes } => {
            manifest.total_stored_bytes().saturating_sub(*max_bytes)
        }
        _ => 0,
    };

    let victims = victims_for_policy(manifest, policy);
    let preview = PrunePreview {
        count: victims.len(),
        bytes: victims.iter().map(|e| e.stored_bytes).sum(),
    };
    (preview, over_cap_bytes)
}

/// The manifest entries that a cleanup would delete, oldest-first.
fn victims_for_policy<'a>(
    manifest: &'a Manifest,
    policy: &RetentionPolicy,
) -> Vec<&'a ManifestEntry> {
    let mut sorted: Vec<&ManifestEntry> = manifest.sessions.iter().collect();
    // Oldest-first by sourceMtime (the session's own age), then session id.
    sorted.sort_by(|a, b| {
        a.source_mtime
            .cmp(&b.source_mtime)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });

    match policy {
        RetentionPolicy::KeepAll => Vec::new(),
        RetentionPolicy::SizeCap { max_bytes } => {
            let total: u64 = sorted.iter().map(|e| e.stored_bytes).sum();
            let mut running = total;
            let mut victims = Vec::new();
            for e in sorted {
                if running <= *max_bytes {
                    break;
                }
                running = running.saturating_sub(e.stored_bytes);
                victims.push(e);
            }
            victims
        }
        RetentionPolicy::KeepMonths { months } => {
            let cutoff = now_secs().saturating_sub(months_to_secs(*months));
            sorted
                .into_iter()
                .filter(|e| e.source_mtime < cutoff)
                .collect()
        }
    }
}

/// Result of a retention cleanup.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub pruned_count: usize,
    pub freed_bytes: u64,
    pub new_stored_bytes: u64,
}

/// Delete oldest-first archived sessions until the store satisfies `policy`.
/// Removes the `.zst` files (and meta sidecars) under the archive root and the
/// matching manifest rows. NEVER touches `~/.claude`. Idempotent: a no-op when
/// nothing is prunable, returning zeros. Emits `archive://progress`.
pub fn run_cleanup<R: Runtime>(
    app: Option<&AppHandle<R>>,
    archive_root: &Path,
    manifest: &mut Manifest,
    policy: &RetentionPolicy,
) -> io::Result<CleanupResult> {
    let victim_ids: Vec<String> = victims_for_policy(manifest, policy)
        .into_iter()
        .map(|e| e.session_id.clone())
        .collect();

    let total = victim_ids.len();
    let mut freed_bytes = 0u64;
    let mut pruned_count = 0usize;

    for (idx, session_id) in victim_ids.iter().enumerate() {
        if let Some(i) = manifest.index_of(session_id) {
            let entry = manifest.sessions[i].clone();
            freed_bytes += delete_archived_session(archive_root, &entry)?;
            manifest.sessions.remove(i);
            pruned_count += 1;
        }
        if let Some(app) = app {
            let _ = app.emit(
                "archive://progress",
                Progress {
                    done: idx + 1,
                    total,
                },
            );
        }
    }

    if pruned_count > 0 {
        write_manifest(archive_root, manifest)?;
    }

    Ok(CleanupResult {
        pruned_count,
        freed_bytes,
        new_stored_bytes: manifest.total_stored_bytes(),
    })
}

/// Remove an archived session's files: the top-level `.zst` and its whole
/// `<sessionId>/` sidecar subtree (subagents + meta). Returns bytes removed.
/// Bounded to the archive root; never escapes it.
fn delete_archived_session(archive_root: &Path, entry: &ManifestEntry) -> io::Result<u64> {
    let mut removed = 0u64;

    let top = archive_root.join(&entry.rel_path);
    if is_inside(archive_root, &top) && top.exists() {
        removed += fs::metadata(&top).map(|m| m.len()).unwrap_or(0);
        let _ = fs::remove_file(&top);
    }

    // Sidecar subtree: archive/<project>/<sessionId>/ (strip the trailing
    // `.jsonl.zst` from the rel path to get the session-id directory).
    if let Some(sidecar_dir) = sidecar_dir_for_rel(archive_root, &entry.rel_path) {
        if is_inside(archive_root, &sidecar_dir) && sidecar_dir.is_dir() {
            removed += dir_size(&sidecar_dir);
            let _ = fs::remove_dir_all(&sidecar_dir);
        }
    }

    Ok(removed)
}

/// `<project>/<sessionId>.jsonl.zst` → `<archive_root>/<project>/<sessionId>`.
fn sidecar_dir_for_rel(archive_root: &Path, rel_path: &str) -> Option<PathBuf> {
    let trimmed = rel_path.strip_suffix(".jsonl.zst")?;
    Some(archive_root.join(trimmed))
}

/// True when `candidate` is the same as or under `base` (defensive: keeps all
/// deletes inside the archive root even if a manifest row is malformed).
fn is_inside(base: &Path, candidate: &Path) -> bool {
    candidate.starts_with(base)
}

/// Recursively sum file sizes under a directory.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(m) = fs::metadata(&p) {
                total += m.len();
            }
        }
    }
    total
}

// ── Reconcile (manifest vs disk drift) ───────────────────────────────────────

/// Stat the archived files referenced by the manifest and fix drift: drop rows
/// whose `.zst` is gone, and refresh `storedBytes` from the actual files. This
/// is the one disk walk we tolerate, run lazily on the first `archive_status`
/// per launch. Returns true when the manifest changed.
pub fn reconcile_manifest(archive_root: &Path, manifest: &mut Manifest) -> bool {
    let mut changed = false;
    let mut kept: Vec<ManifestEntry> = Vec::with_capacity(manifest.sessions.len());

    for entry in manifest.sessions.drain(..) {
        let top = archive_root.join(&entry.rel_path);
        if !top.exists() {
            // The stored copy vanished (manual delete / external prune): drop it.
            changed = true;
            continue;
        }
        let mut actual = fs::metadata(&top).map(|m| m.len()).unwrap_or(0);
        if let Some(sidecar) = sidecar_dir_for_rel(archive_root, &entry.rel_path) {
            if sidecar.is_dir() {
                actual += dir_size(&sidecar);
            }
        }
        let mut entry = entry;
        if entry.stored_bytes != actual {
            entry.stored_bytes = actual;
            changed = true;
        }
        kept.push(entry);
    }

    manifest.sessions = kept;
    changed
}

// ── Status ───────────────────────────────────────────────────────────────────

/// Snapshot for the Settings readout. All fields come from the manifest, so this
/// is instant after the first-launch reconcile.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub enabled: bool,
    pub session_count: usize,
    pub stored_bytes: u64,
    /// Oldest / newest session dates as YYYY-MM-DD, or empty when no sessions.
    pub oldest_date: String,
    pub newest_date: String,
    /// Bytes currently over the size cap (0 under a non-size policy / under cap).
    pub over_cap_bytes: u64,
    pub prunable_preview: PrunePreview,
}

/// Build the status snapshot from the manifest + policy.
pub fn build_status(
    manifest: &Manifest,
    policy: &RetentionPolicy,
    enabled: bool,
) -> ArchiveStatus {
    let (preview, over_cap_bytes) = prune_preview(manifest, policy);
    let dates: BTreeSet<u64> = manifest.sessions.iter().map(|e| e.source_mtime).collect();
    let oldest_date = dates
        .iter()
        .next()
        .map(|s| date_from_secs(*s))
        .unwrap_or_default();
    let newest_date = dates
        .iter()
        .next_back()
        .map(|s| date_from_secs(*s))
        .unwrap_or_default();

    ArchiveStatus {
        enabled,
        session_count: manifest.sessions.len(),
        stored_bytes: manifest.total_stored_bytes(),
        oldest_date,
        newest_date,
        over_cap_bytes,
        prunable_preview: preview,
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Re-export the policy resolution so commands and the indexer agree.
fn resolved_policy<R: Runtime>(app: &AppHandle<R>) -> (bool, RetentionPolicy) {
    let s = load_settings(app);
    (s.archive_enabled, s.retention_policy)
}

#[tauri::command]
pub fn archive_status<R: Runtime>(app: AppHandle<R>) -> Result<ArchiveStatus, String> {
    let root = archive_root(&app)?;
    let (enabled, policy) = resolved_policy(&app);
    let mut manifest = load_manifest(&root);

    // Lazy reconcile on the first call per launch (manifest-vs-disk drift).
    if first_reconcile_this_launch() {
        let changed = reconcile_manifest(&root, &mut manifest);
        if changed {
            let _ = write_manifest(&root, &manifest);
        }
    }

    Ok(build_status(&manifest, &policy, enabled))
}

#[tauri::command]
pub fn run_retention_cleanup<R: Runtime>(app: AppHandle<R>) -> Result<CleanupResult, String> {
    let root = archive_root(&app)?;
    let (_enabled, policy) = resolved_policy(&app);
    let mut manifest = load_manifest(&root);
    run_cleanup(Some(&app), &root, &mut manifest, &policy).map_err(|e| e.to_string())
}

// ── First-reconcile-per-launch latch ─────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};
static RECONCILED: AtomicBool = AtomicBool::new(false);

/// Returns true exactly once per process launch (the first call).
fn first_reconcile_this_launch() -> bool {
    RECONCILED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

// ── Small shared utilities ───────────────────────────────────────────────────

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// ~30.44-day months, good enough for a retention window.
fn months_to_secs(months: u32) -> u64 {
    months as u64 * 2_629_746
}

/// Epoch seconds → YYYY-MM-DD via the transcript module's date math.
fn date_from_secs(secs: u64) -> String {
    let days = (secs / 86400) as u32;
    let (y, m, d) = crate::transcript::days_to_ymd(days);
    format!("{y:04}-{m:02}-{d:02}")
}

// ── Borrowed transcript helpers (kept private there; thin re-use here) ────────

use crate::transcript::{collect_jsonl_files, collect_subagent_files, mtime_secs};

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("archive-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, content: &str) -> PathBuf {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        p
    }

    // ── zstd round-trip ──────────────────────────────────────────────────────

    #[test]
    fn zstd_round_trips_identically() {
        let original = b"the quick brown fox jumps over the lazy dog\n{\"k\":1}".repeat(50);
        let compressed = zstd_compress(&original).unwrap();
        let back = zstd_decompress(&compressed).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn read_maybe_zst_handles_both() {
        let dir = temp_dir("read-maybe");
        let plain = write(&dir, "plain.jsonl", "hello plain");
        assert_eq!(read_maybe_zst(&plain).unwrap(), "hello plain");

        let zst_path = dir.join("c.jsonl.zst");
        fs::write(&zst_path, zstd_compress(b"hello zst").unwrap()).unwrap();
        assert_eq!(read_maybe_zst(&zst_path).unwrap(), "hello zst");
    }

    // ── archive_pass writes + idempotency ────────────────────────────────────

    /// A live transcript root with one session + one subagent + meta.
    fn seed_live(root: &Path) -> PathBuf {
        let session = write(
            root,
            "proj/sess1.jsonl",
            "{\"role\":\"human\",\"content\":\"hello\"}\n{\"role\":\"assistant\",\"content\":\"hi\"}",
        );
        write(
            root,
            "proj/sess1/subagents/agent-aaa.jsonl",
            "{\"role\":\"assistant\",\"content\":\"subagent body\"}",
        );
        write(
            root,
            "proj/sess1/subagents/agent-aaa.meta.json",
            "{\"toolUseId\":\"toolu_1\",\"agentType\":\"Explore\"}",
        );
        session
    }

    #[test]
    fn archive_pass_writes_zst_and_manifest_row() {
        let live = temp_dir("pass-live");
        let arch = temp_dir("pass-arch");
        seed_live(&live);

        let mut manifest = Manifest::default();
        let written =
            archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();
        assert_eq!(written.len(), 1, "one session archived");

        // The top-level .zst exists and decompresses to the original.
        let zst = arch.join("proj/sess1.jsonl.zst");
        assert!(zst.exists(), "compressed session written");
        let body = read_maybe_zst(&zst).unwrap();
        assert!(body.contains("hello"));

        // Subagent .zst + uncompressed meta.json both present.
        assert!(arch.join("proj/sess1/subagents/agent-aaa.jsonl.zst").exists());
        let meta = arch.join("proj/sess1/subagents/agent-aaa.meta.json");
        assert!(meta.exists(), "meta copied uncompressed");
        assert!(fs::read_to_string(&meta).unwrap().contains("toolu_1"));

        // Manifest row + persisted manifest file.
        assert_eq!(manifest.sessions.len(), 1);
        let row = &manifest.sessions[0];
        assert_eq!(row.session_id, "sess1");
        assert_eq!(row.project, "proj");
        assert_eq!(row.rel_path, "proj/sess1.jsonl.zst");
        assert_eq!(row.origin, "claude-code");
        assert!(row.stored_bytes > 0);
        assert!(manifest_path(&arch).exists(), "manifest persisted");
    }

    #[test]
    fn archive_pass_is_idempotent_when_mtime_unchanged() {
        let live = temp_dir("idem-live");
        let arch = temp_dir("idem-arch");
        seed_live(&live);

        let mut manifest = Manifest::default();
        let first = archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();
        assert_eq!(first.len(), 1);
        let archived_at_first = manifest.sessions[0].archived_at;

        // Second pass with no file change: nothing re-archived.
        let second = archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();
        assert_eq!(second.len(), 0, "no rewrite when mtime unchanged");
        assert_eq!(manifest.sessions.len(), 1);
        assert_eq!(
            manifest.sessions[0].archived_at, archived_at_first,
            "row untouched"
        );
    }

    #[test]
    fn archive_pass_rearchives_on_mtime_drift() {
        let live = temp_dir("drift-live");
        let arch = temp_dir("drift-arch");
        let session = seed_live(&live);

        let mut manifest = Manifest::default();
        archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();

        // Simulate Claude Code extending the session: change content AND force the
        // manifest's stored mtime to differ (fs mtime resolution can be coarse).
        fs::write(&session, "{\"role\":\"human\",\"content\":\"hello again and more\"}").unwrap();
        manifest.sessions[0].source_mtime = 0;

        let written = archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();
        assert_eq!(written.len(), 1, "re-archived after drift");
        let body = read_maybe_zst(&arch.join("proj/sess1.jsonl.zst")).unwrap();
        assert!(body.contains("hello again"), "fresh bytes stored");
    }

    // ── read fallback (live missing → archive) ───────────────────────────────

    #[test]
    fn live_to_archived_maps_paths() {
        let live = Path::new("/root/proj/sess1.jsonl");
        let mapped = live_to_archived(live, Path::new("/root"), Path::new("/arch")).unwrap();
        assert_eq!(mapped, Path::new("/arch/proj/sess1.jsonl.zst"));
    }

    #[test]
    fn read_falls_back_to_archive_when_live_deleted() {
        // Prove the get_session read path: archive a session, delete the live
        // file, and confirm the archived copy still yields the body.
        let live = temp_dir("fallback-live");
        let arch = temp_dir("fallback-arch");
        let session = seed_live(&live);

        let mut manifest = Manifest::default();
        archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();

        // Delete the live top-level file (Claude Code pruned it).
        fs::remove_file(&session).unwrap();
        assert!(!session.exists());

        // The resolver (mirrors get_session): live gone → archived path.
        let archived = live_to_archived(&session, &live, &arch).unwrap();
        assert!(archived.exists(), "archived copy survives");
        let body = read_maybe_zst(&archived).unwrap();
        assert!(body.contains("hello"), "turns readable from archive");
    }

    // ── retention preview + cleanup ──────────────────────────────────────────

    fn manifest_with(sizes_and_mtimes: &[(u64, u64)]) -> Manifest {
        let mut m = Manifest::default();
        for (i, (bytes, mtime)) in sizes_and_mtimes.iter().enumerate() {
            m.sessions.push(ManifestEntry {
                session_id: format!("s{i}"),
                project: "proj".into(),
                rel_path: format!("proj/s{i}.jsonl.zst"),
                source_mtime: *mtime,
                archived_at: 0,
                original_bytes: *bytes * 4,
                stored_bytes: *bytes,
                origin: "claude-code".into(),
            });
        }
        m
    }

    #[test]
    fn preview_walks_oldest_first_until_under_cap() {
        // Four sessions of 100 bytes each (total 400), mtimes ascending so s0 is
        // oldest. Cap at 250 → must prune the two oldest (s0, s1) to reach 200.
        let m = manifest_with(&[(100, 10), (100, 20), (100, 30), (100, 40)]);
        let policy = RetentionPolicy::SizeCap { max_bytes: 250 };
        let (preview, over) = prune_preview(&m, &policy);
        assert_eq!(over, 150, "400 - 250 over cap");
        assert_eq!(preview.count, 2);
        assert_eq!(preview.bytes, 200);
    }

    #[test]
    fn preview_zero_when_under_cap() {
        let m = manifest_with(&[(100, 10), (100, 20)]);
        let policy = RetentionPolicy::SizeCap { max_bytes: 1000 };
        let (preview, over) = prune_preview(&m, &policy);
        assert_eq!(over, 0);
        assert_eq!(preview.count, 0);
        assert_eq!(preview.bytes, 0);
    }

    #[test]
    fn keep_all_never_prunes() {
        let m = manifest_with(&[(100, 10), (100, 20), (100, 30)]);
        let (preview, over) = prune_preview(&m, &RetentionPolicy::KeepAll);
        assert_eq!(over, 0);
        assert_eq!(preview.count, 0);
    }

    #[test]
    fn cleanup_deletes_oldest_first_until_under_cap() {
        let live = temp_dir("clean-live");
        let arch = temp_dir("clean-arch");

        // Three sessions on disk so cleanup has real files to remove.
        for (i, mtime) in [(0u32, 10u64), (1, 20), (2, 30)] {
            let _ = i;
            write(
                &live,
                &format!("proj/s{mtime}.jsonl"),
                "{\"role\":\"human\",\"content\":\"some repeated body some repeated body\"}",
            );
        }
        let mut manifest = Manifest::default();
        archive_pass::<tauri::Wry>(None, &live, &arch, &mut manifest).unwrap();
        assert_eq!(manifest.sessions.len(), 3);

        // Force ascending mtimes so the oldest is deterministic.
        manifest.sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        for (i, e) in manifest.sessions.iter_mut().enumerate() {
            e.source_mtime = (i as u64 + 1) * 10;
        }
        let total = manifest.total_stored_bytes();
        let one = manifest.sessions[0].stored_bytes;

        // Cap just below total → prune exactly the oldest one.
        let policy = RetentionPolicy::SizeCap {
            max_bytes: total - 1,
        };
        let result =
            run_cleanup::<tauri::Wry>(None, &arch, &mut manifest, &policy).unwrap();
        assert_eq!(result.pruned_count, 1);
        assert_eq!(result.freed_bytes, one);
        assert_eq!(manifest.sessions.len(), 2);
        assert_eq!(result.new_stored_bytes, total - one);

        // Idempotent: under cap now → zeros, no further removal.
        let again =
            run_cleanup::<tauri::Wry>(None, &arch, &mut manifest, &policy).unwrap();
        assert_eq!(again.pruned_count, 0);
        assert_eq!(again.freed_bytes, 0);
    }

    #[test]
    fn cleanup_zeros_when_nothing_prunable() {
        let arch = temp_dir("clean-noop");
        let mut manifest = manifest_with(&[(100, 10)]);
        let policy = RetentionPolicy::SizeCap { max_bytes: 10_000 };
        let result =
            run_cleanup::<tauri::Wry>(None, &arch, &mut manifest, &policy).unwrap();
        assert_eq!(result.pruned_count, 0);
        assert_eq!(result.freed_bytes, 0);
        assert_eq!(manifest.sessions.len(), 1);
    }

    #[test]
    fn reconcile_drops_rows_for_missing_files() {
        let arch = temp_dir("reconcile");
        // A manifest row whose .zst was never written → reconcile drops it.
        let mut manifest = manifest_with(&[(100, 10)]);
        let changed = reconcile_manifest(&arch, &mut manifest);
        assert!(changed);
        assert_eq!(manifest.sessions.len(), 0, "phantom row removed");
    }
}
