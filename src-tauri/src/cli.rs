//! cli.rs
//!
//! Headless write path for agents (TIN-1731). An agent running in a terminal —
//! with the Studio GUI closed — can write a memory note and get a continuity
//! signal back, sharing Studio's Rust core and the same index DB.
//!
//! Two subcommands are dispatched from `lib::run()` BEFORE the Tauri webview is
//! ever created (see [`maybe_run`]); on a match we run the pipeline, print one
//! JSON object to stdout, and exit — the GUI never starts.
//!
//!   * `add-memory` — the agent write path. Rule-based `suggest_frontmatter`
//!     fills any missing fields, `summarize_note` adds a degrade-safe TLDR,
//!     `score_memory` returns a continuity signal (and any conflicts) against the
//!     existing base, then we write the `.md` into `{root}/{project}` and record
//!     an `agent` audit row. The JSON it prints is what the agent reads to decide
//!     whether to surface anything to the human.
//!
//!   * `supersede` — the invalidate-don't-delete write, applied EXPLICITLY (never
//!     automatically on a score). Frontmatter-only and non-destructive: the old
//!     note's body is left byte-for-byte unchanged; only its frontmatter gains
//!     `status: superseded` + `superseded_by`, and the new note gains
//!     `supersedes`.
//!
//! Everything degrades calmly: with no reasoning model reachable the summary is
//! empty and the continuity score is the similarity-only estimate, but the write
//! still succeeds.
//!
//! Deferred: an MCP wrapper (a thin server exposing `add-memory`/`supersede` as
//! MCP tools) is a follow-up — it should shell out to this same binary so the
//! core and the index DB stay shared. The studio skills should call this binary
//! directly (`app add-memory --content ... --agent poppy`) and parse the JSON.

use std::fs;
use std::path::{Path, PathBuf};

use gray_matter::engine::YAML;
use gray_matter::{Matter, ParsedEntity, Pod};
use serde_json::json;

use crate::continuity::{score_content, ScoreMemoryInput};
use crate::frontmatter::{apply_frontmatter, generate, slugify, summarize_note, SummarizeNoteInput, Suggestion};
use crate::memory_audit::{content_hash, record_change, RecordMemoryChangeInput};
use crate::memory_reads;
use crate::search::{build_index, init_db, search_core, Db, SearchInput};
use crate::settings::default_memory_root;

// ── Argument parsing ─────────────────────────────────────────────────────────

/// A flat `--flag value` parser — enough for the headless endpoint without
/// pulling in a CLI framework. Repeated flags keep the last value; unknown flags
/// are ignored so the surface can grow without breaking callers.
struct Args {
    map: std::collections::HashMap<String, String>,
}

impl Args {
    fn parse(raw: &[String]) -> Self {
        let mut map = std::collections::HashMap::new();
        let mut i = 0;
        while i < raw.len() {
            let tok = &raw[i];
            if let Some(flag) = tok.strip_prefix("--") {
                let val = raw.get(i + 1).cloned().unwrap_or_default();
                map.insert(flag.to_string(), val);
                i += 2;
            } else {
                i += 1;
            }
        }
        Args { map }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/// Inspect process args; if the first is a headless subcommand, run it, print
/// JSON, and exit the process. Returns to the caller (so the GUI launches) only
/// when there is no headless subcommand. Called at the very top of `lib::run()`.
pub fn maybe_run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else { return };
    let rest = &args[1..];

    let result = match cmd.as_str() {
        "add-memory" => run_add_memory(rest),
        "supersede" => run_supersede(rest),
        "recall" => run_recall(rest),
        "check" => run_check(rest),
        _ => return, // not a headless command → fall through to the GUI
    };

    match result {
        Ok(value) => {
            println!("{value}");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("{}", json!({ "error": e }));
            std::process::exit(1);
        }
    }
}

/// Resolve the memory root for the headless path. We do NOT load the Tauri store
/// here (no `AppHandle` without an app), so we honour an explicit override via
/// `MEMORY_ROOT` and otherwise fall back to the default `~/Projects/tfl/memory`,
/// which is the same default the GUI resolves to out of the box.
fn resolve_root() -> PathBuf {
    match std::env::var("MEMORY_ROOT") {
        Ok(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
        _ => default_memory_root(),
    }
}

/// Open the shared index DB under `root` and wrap it as a `Db` (the same managed
/// type the Tauri commands use), so the extracted core logic runs unchanged.
fn open_db(root: &Path) -> Result<Db, String> {
    let conn = init_db(root).map_err(|e| e.to_string())?;
    Ok(Db(std::sync::Mutex::new(conn)))
}

// ── add-memory ───────────────────────────────────────────────────────────────

/// Read the note body from `--content <text>` or `--file <path>`.
fn read_body(args: &Args) -> Result<String, String> {
    if let Some(text) = args.get("content") {
        return Ok(text.to_string());
    }
    if let Some(path) = args.get("file") {
        return fs::read_to_string(path).map_err(|e| format!("reading --file {path}: {e}"));
    }
    Err("one of --content or --file is required".to_string())
}

/// The `add-memory` pipeline. Synchronous shell that drives the async core
/// (summarize + score) on a current-thread runtime — matching the dedicated-
/// thread pattern the GUI uses for the embedding pass.
pub fn run_add_memory(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let body = read_body(&args)?;
    if body.trim().is_empty() {
        return Err("note content is empty".to_string());
    }
    let agent = args
        .get("agent")
        .filter(|s| !s.trim().is_empty())
        .ok_or("--agent <name> is required (it is the audit actor_id)")?
        .to_string();

    let root = resolve_root();
    let db = open_db(&root)?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // 1. Rule-based suggestion, then apply CLI overrides for any provided field.
    let known = known_projects(&db);
    let mut sug = generate(&body, &today, &known);
    apply_overrides(&mut sug, &args);
    if sug.name.trim().is_empty() {
        sug.name = slugify(&sug.title);
    }
    if sug.name.trim().is_empty() {
        sug.name = format!("note-{today}");
    }
    if sug.projects.is_empty() {
        // Cross-product notes live under `shared/`; mirror the MEMORY.md routing
        // default so an unprojected note still lands somewhere sensible.
        sug.projects = vec!["shared".to_string()];
    }

    // 2 + 3. summarize (degrade-safe) and score against the existing base. Both
    // are async; run them on a current-thread runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    let summary = rt.block_on(summarize_note(SummarizeNoteInput { content: body.clone() }));
    if !summary.degraded && !summary.summary.trim().is_empty() {
        sug.summary = Some(summary.summary.clone());
    }

    let score = rt.block_on(score_content(
        &db,
        ScoreMemoryInput { content: body.clone(), path: None },
    ))?;

    // 4. Write the file under {root}/{project}.
    let dir = root.join(&sug.projects[0]);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file_path = dir.join(format!("{}.md", sug.name));
    // Don't clobber an existing note — disambiguate with a numeric suffix.
    let mut n = 2;
    while file_path.exists() {
        file_path = dir.join(format!("{}-{n}.md", sug.name));
        n += 1;
    }
    let rendered = apply_frontmatter(&body, &sug);
    fs::write(&file_path, &rendered).map_err(|e| e.to_string())?;

    // Rebuild the index so the new note is searchable immediately (matches the
    // GUI create path).
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_index(&root, &conn).map_err(|e| e.to_string())?;
    }

    // 5. Record an `agent` audit row.
    let path_str = file_path.to_string_lossy().to_string();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        record_change(
            &conn,
            &RecordMemoryChangeInput {
                path: path_str.clone(),
                actor_type: "agent".to_string(),
                actor_id: agent.clone(),
                continuity_score: Some(score.continuity_score),
                change_summary: "Created via endpoint.".to_string(),
                content_hash: content_hash(&rendered),
            },
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(json!({
        "path": path_str,
        "continuityScore": score.continuity_score,
        "conflicts": score.conflicts,
        "superseded": false,
    }))
}

/// Override suggestion fields from explicit CLI flags. A provided flag always
/// wins over the rule-based guess; absent flags leave the guess intact.
fn apply_overrides(sug: &mut Suggestion, args: &Args) {
    if let Some(name) = args.get("name").filter(|s| !s.trim().is_empty()) {
        sug.name = slugify(name);
    }
    if let Some(type_) = args.get("type").filter(|s| !s.trim().is_empty()) {
        sug.type_ = type_.to_string();
    }
    if let Some(project) = args.get("project").filter(|s| !s.trim().is_empty()) {
        sug.projects = vec![project.to_string()];
    }
}

/// Known project names from the index (for project inference), falling back to
/// the default domains. Mirrors `frontmatter::known_projects` but takes a plain
/// `&Db` rather than Tauri state.
fn known_projects(db: &Db) -> Vec<String> {
    const DEFAULTS: &[&str] = &["attic", "understory", "rearview", "website", "studio", "shared"];
    let mut set: Vec<String> = DEFAULTS.iter().map(|s| s.to_string()).collect();
    if let Ok(conn) = db.0.lock() {
        if let Ok(mut stmt) =
            conn.prepare("SELECT DISTINCT projects FROM memory_files WHERE projects != ''")
        {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for joined in rows.filter_map(Result::ok) {
                    for p in joined.split(',').filter(|s| !s.is_empty()) {
                        if !set.iter().any(|x| x == p) {
                            set.push(p.to_string());
                        }
                    }
                }
            }
        }
    }
    set
}

// ── supersede ────────────────────────────────────────────────────────────────

/// The `supersede` pipeline: frontmatter-only, non-destructive. Resolves the old
/// and new notes (by path or `name`), marks the old `status: superseded` +
/// `superseded_by: <new>` and the new `supersedes: <old>`. Bodies are untouched.
pub fn run_supersede(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let old = args.get("old").ok_or("--old <path|name> is required")?;
    let new = args.get("new").ok_or("--new <name> is required")?;

    let root = resolve_root();
    let old_path = resolve_note(&root, old).ok_or_else(|| format!("old note not found: {old}"))?;
    let new_path = resolve_note(&root, new).ok_or_else(|| format!("new note not found: {new}"))?;

    let new_name = note_name(&new_path).unwrap_or_else(|| new.to_string());
    let old_name = note_name(&old_path).unwrap_or_else(|| old.to_string());

    supersede_note(&old_path, &new_path, &old_name, &new_name)?;

    // Reindex so the superseded status is reflected in search immediately.
    let db = open_db(&root)?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_index(&root, &conn).map_err(|e| e.to_string())?;
    }

    Ok(json!({
        "old": old_path.to_string_lossy(),
        "new": new_path.to_string_lossy(),
        "superseded": true,
    }))
}

/// Resolve a `--old`/`--new` argument that is either an absolute/relative path to
/// an existing `.md` file, or a frontmatter `name` to search the tree for.
fn resolve_note(root: &Path, arg: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(arg);
    if direct.is_file() {
        return Some(direct);
    }
    // Otherwise treat `arg` as a note name and search the root for a match.
    find_by_name(root, arg)
}

/// The frontmatter `name` of a note, falling back to its file stem.
fn note_name(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    if let Some(name) = frontmatter_field(&raw, "name") {
        if !name.trim().is_empty() {
            return Some(name);
        }
    }
    path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
}

/// Walk the tree (skipping hidden dirs + `MEMORY.md`) for a note whose
/// frontmatter `name` or file stem equals `name`.
fn find_by_name(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let fname = entry.file_name();
        let fname = fname.to_string_lossy();
        if fname.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if full.is_dir() {
            if let Some(hit) = find_by_name(&full, name) {
                return Some(hit);
            }
        } else if fname.ends_with(".md") && fname != "MEMORY.md" {
            let stem = full.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem == name {
                return Some(full);
            }
            if let Ok(raw) = fs::read_to_string(&full) {
                if frontmatter_field(&raw, "name").as_deref() == Some(name) {
                    return Some(full);
                }
            }
        }
    }
    None
}

/// Read a scalar frontmatter field from raw note content.
fn frontmatter_field(raw: &str, key: &str) -> Option<String> {
    let matter = Matter::<YAML>::new();
    let parsed: ParsedEntity = matter.parse(raw).ok()?;
    let map = parsed.data.as_ref()?.as_hashmap().ok()?;
    map.get(key).and_then(|p: &Pod| p.as_string().ok())
}

/// Apply the supersede relationship to both notes, frontmatter-only. The body of
/// each file (everything after the closing `---`) is left byte-for-byte
/// unchanged: we edit only the YAML block in place.
///
/// On the OLD note: set `status: superseded` and `superseded_by: <new_name>`.
/// On the NEW note: set `supersedes: <old_name>`.
pub fn supersede_note(
    old_path: &Path,
    new_path: &Path,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let old_raw = fs::read_to_string(old_path).map_err(|e| e.to_string())?;
    let old_updated = set_frontmatter_fields(
        &old_raw,
        &[("status", "superseded"), ("superseded_by", new_name)],
    )?;
    fs::write(old_path, old_updated).map_err(|e| e.to_string())?;

    let new_raw = fs::read_to_string(new_path).map_err(|e| e.to_string())?;
    let new_updated = set_frontmatter_fields(&new_raw, &[("supersedes", old_name)])?;
    fs::write(new_path, new_updated).map_err(|e| e.to_string())?;

    Ok(())
}

/// Set/replace scalar fields inside the leading YAML frontmatter block, leaving
/// the body after the closing fence untouched. If a field already exists its
/// value is replaced in place; otherwise it is appended just before the closing
/// `---`. A note with no frontmatter block gets one prepended.
///
/// This is deliberately a line-level rewrite (not a parse-and-reserialise) so
/// the rest of the frontmatter — key order, comments, list styling — and the
/// entire body survive byte-for-byte except for the touched keys.
fn set_frontmatter_fields(raw: &str, fields: &[(&str, &str)]) -> Result<String, String> {
    // Locate the frontmatter block: a leading `---` line and its closing `---`.
    let mut lines: Vec<String> = raw.lines().map(|l| l.to_string()).collect();
    let has_trailing_newline = raw.ends_with('\n');

    let opens = lines.first().map(|l| l.trim_end() == "---").unwrap_or(false);
    if !opens {
        // No frontmatter — synthesise a minimal block, preserve the body.
        let mut block = String::from("---\n");
        for (k, v) in fields {
            block.push_str(&format!("{k}: {v}\n"));
        }
        block.push_str("---\n\n");
        return Ok(format!("{block}{raw}"));
    }

    // Closing fence index (recomputed each field, since inserts shift it).
    let find_close = |lines: &[String]| -> Result<usize, String> {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.trim_end() == "---")
            .map(|(i, _)| i)
            .ok_or_else(|| "frontmatter block is not closed".to_string())
    };

    for (key, value) in fields {
        let close = find_close(&lines)?;
        let prefix = format!("{key}:");
        if let Some(idx) = lines[1..close]
            .iter()
            .position(|l| l.trim_start().starts_with(&prefix))
        {
            lines[1 + idx] = format!("{key}: {value}");
        } else {
            // Insert just before the closing fence.
            lines.insert(close, format!("{key}: {value}"));
        }
    }

    let mut out = lines.join("\n");
    if has_trailing_newline {
        out.push('\n');
    }
    Ok(out)
}

// ── recall (TIN-1739) ────────────────────────────────────────────────────────

/// The `recall` pipeline. Runs the same hybrid BM25+vector search the Tauri
/// `search` command uses (via `search_core`), applies `derank_superseded`, and
/// returns a JSON array of the top-k hits with the shape the agent API defines.
///
/// Usage: `recall --query "<text>" [--project <p>] [--type <t>] [--k <n>]`
/// Default k = 8.
pub fn run_recall(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let query = args.get("query").ok_or("--query <text> is required")?;
    if query.trim().is_empty() {
        return Err("--query must not be empty".to_string());
    }

    let project = args.get("project").unwrap_or("").to_string();
    let type_ = args.get("type").unwrap_or("").to_string();
    let k: usize = args
        .get("k")
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);

    let root = resolve_root();
    let db = open_db(&root)?;

    let input = SearchInput {
        q: query.to_string(),
        type_filter: type_,
        project_filter: project,
        limit: Some(k as i64),
        rebuild: false,
    };

    let results = search_core(&db, &input, k)?;

    // Bump read counts for every surfaced note (one UPSERT per hit). The DB
    // connection is shared with the rest of the pipeline via the same `Db`.
    // Failures are logged but do NOT abort the recall response — tracking is
    // best-effort and must never break the agent's retrieval path.
    {
        let ts = chrono::Utc::now().to_rfc3339();
        match db.0.lock() {
            Ok(conn) => {
                for r in &results {
                    if let Err(e) = memory_reads::record_read(&conn, &r.path, &ts) {
                        log::warn!("[recall] record_read failed for {}: {e}", r.path);
                    }
                }
            }
            Err(e) => log::warn!("[recall] could not acquire DB lock for read tracking: {e}"),
        }
    }

    // Build the recall JSON array. `summary` is read from the file's frontmatter
    // (cheap single-field read per hit); `snippet` is the existing excerpt.
    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let items: Vec<serde_json::Value> = results
        .iter()
        .map(|r| {
            // Read the `summary` frontmatter field cheaply.
            let summary: String = fs::read_to_string(&r.path)
                .ok()
                .and_then(|raw| {
                    let parsed: gray_matter::ParsedEntity = matter.parse(&raw).ok()?;
                    let map = parsed.data.as_ref()?.as_hashmap().ok()?;
                    map.get("summary").and_then(|p| p.as_string().ok())
                })
                .unwrap_or_default();

            json!({
                "name":    r.name,
                "path":    r.path,
                "summary": summary,
                "status":  r.status,
                "score":   0.0,   // placeholder — hybrid rank is ordinal, not a normalised score
                "snippet": r.excerpt,
            })
        })
        .collect();

    Ok(serde_json::Value::Array(items))
}

// ── check (TIN-1740) ─────────────────────────────────────────────────────────

/// The `check` pipeline. Calls `continuity::score_content` — the same read-only
/// scorer `add-memory` uses — and returns the continuity signal as JSON. No
/// write, no side effects.
///
/// Usage: `check --content "<text>" [--project <p>]`
/// (The `--project` flag is accepted for symmetry with `recall` but the scorer
/// itself is project-agnostic; project filtering in continuity scoring is a
/// future concern.)
pub fn run_check(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let content = args
        .get("content")
        .ok_or("--content <text> is required")?
        .to_string();
    if content.trim().is_empty() {
        return Err("--content must not be empty".to_string());
    }

    let root = resolve_root();
    let db = open_db(&root)?;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    let score = rt.block_on(score_content(
        &db,
        ScoreMemoryInput { content, path: None },
    ))?;

    Ok(json!({
        "continuityScore": score.continuity_score,
        "conflicts": score.conflicts,
        "degraded": score.degraded,
    }))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{ensure_chunks_table, register_sqlite_vec, SCHEMA};
    use std::sync::{Mutex, OnceLock};

    /// Serialises the tests that mutate the process-global `MEMORY_ROOT` env var,
    /// since cargo runs tests in parallel within one process.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cli-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `Db` backed by an on-disk index under `root` (so the CLI code paths that
    /// reopen/rebuild the same DB see a consistent file).
    fn fixture_db(root: &Path) -> Db {
        register_sqlite_vec();
        let conn = init_db(root).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ensure_chunks_table(&conn).unwrap();
        Db(Mutex::new(conn))
    }

    fn audit_count(db: &Db, actor_type: &str) -> i64 {
        crate::memory_audit::ensure_schema(&db.0.lock().unwrap()).unwrap();
        db.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM memory_audit WHERE actor_type = ?1",
                rusqlite::params![actor_type],
                |r| r.get(0),
            )
            .unwrap()
    }

    // ── add-memory core ───────────────────────────────────────────────────────

    #[test]
    fn add_memory_writes_schema_valid_note_and_records_agent_row() {
        let _guard = env_lock();
        let root = temp_root("add");
        // Pre-create the DB file the CLI will reopen.
        let _ = fixture_db(&root);

        let body = "# Pricing decision\n\nAttic Pro is priced at $9 per month for the studio.";
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_add_memory(&[
            "--content".into(),
            body.into(),
            "--agent".into(),
            "poppy".into(),
            "--project".into(),
            "studio".into(),
            "--type".into(),
            "project".into(),
        ])
        .expect("add-memory succeeds");
        std::env::remove_var("MEMORY_ROOT");

        // JSON shape.
        assert_eq!(out["superseded"], json!(false));
        assert!(out["continuityScore"].is_number());
        assert!(out["conflicts"].is_array());

        // The file exists under {root}/studio with valid frontmatter + body.
        let path = out["path"].as_str().unwrap();
        assert!(path.contains("/studio/"), "lands in the project folder: {path}");
        let written = fs::read_to_string(path).unwrap();
        assert!(written.starts_with("---\n"), "has a frontmatter block");
        assert!(written.contains("type: project"));
        assert!(written.contains("projects: studio"));
        assert!(written.contains("status: active"));
        assert!(written.contains("Attic Pro is priced at $9 per month"), "body preserved");

        // The audit trail recorded exactly one agent row (degrade-safe path).
        let db = fixture_db(&root);
        assert_eq!(audit_count(&db, "agent"), 1, "one agent audit row recorded");
    }

    #[test]
    fn add_memory_succeeds_and_is_degrade_safe() {
        // The write must succeed whether or not a reasoning model is reachable.
        // CI has no model, so this exercises the degraded path (empty summary +
        // similarity-only score); a dev box with Ollama exercises the full path.
        // Either way the note is written with valid frontmatter and a body, and a
        // summary line is present iff the model produced one — never an error.
        let _guard = env_lock();
        let root = temp_root("degraded");
        let _ = fixture_db(&root);

        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_add_memory(&[
            "--content".into(),
            "A short novel note with no near neighbours.".into(),
            "--agent".into(),
            "tester".into(),
            "--project".into(),
            "studio".into(),
        ])
        .expect("add-memory still succeeds with no reasoning model");
        std::env::remove_var("MEMORY_ROOT");

        // Score is always a valid 0..=1 number even on the degraded path.
        let score = out["continuityScore"].as_f64().expect("score is a number");
        assert!((0.0..=1.0).contains(&score), "continuity score in range: {score}");

        let path = out["path"].as_str().unwrap();
        let written = fs::read_to_string(path).unwrap();
        assert!(written.starts_with("---\n"), "valid frontmatter block");
        assert!(written.contains("status: active"));
        assert!(
            written.trim_end().ends_with("A short novel note with no near neighbours."),
            "body preserved: {written}"
        );
        // No `summary:` field is ever written when summarisation degraded (empty),
        // and apply_frontmatter only emits one when the suggestion carries a
        // non-empty summary — so an empty summary never leaves a dangling field.
        if !written.contains("summary:") {
            // degraded branch: nothing more to assert.
        } else {
            assert!(
                written.contains("summary: "),
                "a present summary field carries a value: {written}"
            );
        }
    }

    #[test]
    fn degraded_summary_writes_note_without_summary_field() {
        // Deterministic proof of the degraded write (no model needed): when
        // summarisation degrades, the suggestion's summary stays None, and the
        // rendered note carries NO `summary:` line while the body is preserved.
        // This is the seam the pipeline composes (summarize → apply_frontmatter).
        let mut sug = generate(
            "Attic Pro is priced at $9 per month.",
            "2026-06-24",
            &["studio".to_string()],
        );
        sug.projects = vec!["studio".to_string()];
        // Degraded: SummarizeNoteOutput { summary: "", degraded: true } → the
        // pipeline leaves sug.summary as None.
        assert_eq!(sug.summary, None, "rule-based + degraded leaves summary unset");

        let body = "Attic Pro is priced at $9 per month.";
        let rendered = apply_frontmatter(body, &sug);
        assert!(!rendered.contains("summary:"), "no summary line on the degraded path: {rendered}");
        assert!(rendered.trim_end().ends_with(body), "body preserved");
    }

    #[test]
    fn add_memory_requires_agent_and_content() {
        let _guard = env_lock();
        let root = temp_root("validate");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        assert!(run_add_memory(&["--content".into(), "x".into()]).is_err(), "agent required");
        assert!(
            run_add_memory(&["--agent".into(), "poppy".into()]).is_err(),
            "content/file required"
        );
        std::env::remove_var("MEMORY_ROOT");
    }

    // ── supersede ─────────────────────────────────────────────────────────────

    fn write_note(root: &Path, rel: &str, content: &str) -> PathBuf {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn supersede_sets_three_fields_and_leaves_body_byte_identical() {
        let root = temp_root("supersede");
        let old_body = "# Old pricing\n\nAttic Pro is $7 per month.\n\nThis body must not change.\n";
        let new_body = "# New pricing\n\nAttic Pro is $9 per month.\n";
        let old = write_note(
            &root,
            "studio/old.md",
            &format!("---\nname: old-pricing\ntype: project\nprojects: studio\nstatus: active\n---\n{old_body}"),
        );
        let new = write_note(
            &root,
            "studio/new.md",
            &format!("---\nname: new-pricing\ntype: project\nprojects: studio\nstatus: active\n---\n{new_body}"),
        );

        supersede_note(&old, &new, "old-pricing", "new-pricing").unwrap();

        let old_after = fs::read_to_string(&old).unwrap();
        let new_after = fs::read_to_string(&new).unwrap();

        // Old note: status flipped + superseded_by set.
        assert!(old_after.contains("status: superseded"), "status updated in place: {old_after}");
        assert!(old_after.contains("superseded_by: new-pricing"), "superseded_by set: {old_after}");
        // New note: supersedes set.
        assert!(new_after.contains("supersedes: old-pricing"), "supersedes set: {new_after}");

        // Bodies are byte-for-byte unchanged.
        let old_body_after = old_after.split("---\n").nth(2).unwrap();
        assert_eq!(old_body_after, old_body, "old body byte-identical");
        let new_body_after = new_after.split("---\n").nth(2).unwrap();
        assert_eq!(new_body_after, new_body, "new body byte-identical");
    }

    #[test]
    fn supersede_replaces_existing_status_without_duplicating() {
        let root = temp_root("supersede-dup");
        let old = write_note(
            &root,
            "studio/a.md",
            "---\nname: a\ntype: project\nprojects: studio\nstatus: active\n---\nbody here\n",
        );
        let new = write_note(
            &root,
            "studio/b.md",
            "---\nname: b\ntype: project\nprojects: studio\nstatus: active\n---\nother body\n",
        );
        supersede_note(&old, &new, "a", "b").unwrap();
        let after = fs::read_to_string(&old).unwrap();
        assert_eq!(after.matches("status:").count(), 1, "status replaced, not duplicated: {after}");
        assert!(!after.contains("status: active"), "old status value gone");
    }

    // ── recall (TIN-1739) ─────────────────────────────────────────────────────

    /// Seed two notes into a temp root+DB and return the root + a Db handle that
    /// backs the on-disk index (so `run_recall` — which reopens the same DB —
    /// sees them).
    fn recall_fixture(tag: &str) -> (PathBuf, Db) {
        let root = temp_root(&format!("recall-{tag}"));
        let db = fixture_db(&root);

        // Active note — matches "pricing"
        let active = root.join("studio");
        fs::create_dir_all(&active).unwrap();
        fs::write(
            active.join("current-pricing.md"),
            "---\nname: current-pricing\ntype: project\nprojects: studio\nstatus: active\nsummary: Attic Pro is priced at $9 per month.\n---\nAttic Pro is priced at $9 per month.\n",
        )
        .unwrap();

        // Superseded note — also matches "pricing" but should rank lower
        fs::write(
            active.join("old-pricing.md"),
            "---\nname: old-pricing\ntype: project\nprojects: studio\nstatus: superseded\n---\nAttic Pro was priced at $7 per month.\n",
        )
        .unwrap();

        // Rebuild the on-disk index so `run_recall` (which reopens it) can find the notes.
        {
            let conn = db.0.lock().unwrap();
            crate::search::build_index(&root, &conn).unwrap();
        }
        (root, db)
    }

    #[test]
    fn recall_returns_json_array_with_expected_fields() {
        let _guard = env_lock();
        let (root, _db) = recall_fixture("fields");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_recall(&["--query".into(), "pricing".into(), "--k".into(), "8".into()])
            .expect("recall succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let arr = out.as_array().expect("recall returns a JSON array");
        assert!(!arr.is_empty(), "at least one hit for 'pricing'");

        // Every element carries the required shape.
        for item in arr {
            assert!(item["name"].is_string(), "name field present");
            assert!(item["path"].is_string(), "path field present");
            assert!(item["summary"].is_string(), "summary field present");
            assert!(item["status"].is_string(), "status field present");
            assert!(item["score"].is_number(), "score field present");
            assert!(item["snippet"].is_string(), "snippet field present");
        }
    }

    #[test]
    fn recall_active_note_ranks_before_superseded() {
        let _guard = env_lock();
        let (root, _db) = recall_fixture("derank");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_recall(&["--query".into(), "pricing".into(), "--k".into(), "8".into()])
            .expect("recall succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let arr = out.as_array().expect("JSON array");
        assert!(arr.len() >= 2, "both active and superseded notes are returned");

        // The active note must appear before the superseded one.
        let pos_active = arr.iter().position(|i| i["status"].as_str() == Some("active"));
        let pos_superseded = arr.iter().position(|i| i["status"].as_str() == Some("superseded"));
        assert!(pos_active.is_some(), "active note present in results");
        assert!(pos_superseded.is_some(), "superseded note present in results (findable)");
        assert!(
            pos_active.unwrap() < pos_superseded.unwrap(),
            "active note must rank before the superseded one"
        );
    }

    #[test]
    fn recall_summary_read_from_frontmatter() {
        let _guard = env_lock();
        let (root, _db) = recall_fixture("summary");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_recall(&["--query".into(), "pricing".into()])
            .expect("recall succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let arr = out.as_array().expect("JSON array");
        // The active note has `summary:` in its frontmatter.
        let active_hit = arr.iter().find(|i| i["name"].as_str() == Some("current-pricing"));
        assert!(active_hit.is_some(), "current-pricing in results");
        let s = active_hit.unwrap()["summary"].as_str().unwrap_or("");
        assert_eq!(s, "Attic Pro is priced at $9 per month.", "summary from frontmatter");
    }

    #[test]
    fn recall_missing_query_errors_cleanly() {
        let _guard = env_lock();
        let root = temp_root("recall-noquery");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        let err = run_recall(&[]).unwrap_err();
        std::env::remove_var("MEMORY_ROOT");
        assert!(err.contains("--query"), "error mentions --query: {err}");
    }

    // ── check (TIN-1740) ──────────────────────────────────────────────────────

    #[test]
    fn check_returns_expected_json_shape() {
        let _guard = env_lock();
        let root = temp_root("check-shape");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_check(&["--content".into(), "Attic Pro is priced at $9 per month.".into()])
            .expect("check succeeds");
        std::env::remove_var("MEMORY_ROOT");

        // Shape: { continuityScore, conflicts, degraded }
        assert!(out["continuityScore"].is_number(), "continuityScore is a number");
        assert!(out["conflicts"].is_array(), "conflicts is an array");
        assert!(out["degraded"].is_boolean(), "degraded is a boolean");

        let score = out["continuityScore"].as_f64().unwrap();
        assert!((0.0..=1.0).contains(&score), "continuityScore in [0, 1]: {score}");
    }

    #[test]
    fn check_degraded_path_returns_valid_score() {
        // With no live model (CI), check must degrade gracefully: score in range,
        // conflicts empty, degraded true (or false if the model happened to load).
        let _guard = env_lock();
        let root = temp_root("check-degrade");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_check(&["--content".into(), "A genuinely novel idea with no prior art.".into()])
            .expect("check still succeeds with no model");
        std::env::remove_var("MEMORY_ROOT");

        let score = out["continuityScore"].as_f64().unwrap();
        assert!((0.0..=1.0).contains(&score), "score in [0,1]: {score}");
        assert!(out["conflicts"].as_array().unwrap().is_empty(), "no conflicts on degraded path");
    }

    #[test]
    fn check_missing_content_errors_cleanly() {
        let _guard = env_lock();
        let root = temp_root("check-nocontent");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        let err = run_check(&[]).unwrap_err();
        std::env::remove_var("MEMORY_ROOT");
        assert!(err.contains("--content"), "error mentions --content: {err}");
    }
}
