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
use crate::embeddings::{chunk_text, fingerprint};
use crate::frontmatter::{apply_frontmatter, generate, slugify, summarize_note, SummarizeNoteInput, Suggestion};
use crate::memory_audit::{content_hash, ensure_schema as ensure_audit_schema, history_for, record_change, AuditEntry, RecordMemoryChangeInput};
use crate::memory_reads;
use crate::reason;
use crate::salience;
use crate::search::{build_index, embedding_to_blob, init_db, search_core, Db, SearchInput};
use crate::settings::{default_memory_root, STORE_FILE};

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

    // `--help`/`-h`/`help` always print usage and exit — this must be checked
    // before dispatch so `agent-studio-memory --help` never falls through and
    // boots the GUI.
    if cmd == "--help" || cmd == "-h" || cmd == "help" {
        print!("{}", usage());
        std::process::exit(0);
    }

    let result = match cmd.as_str() {
        "add-memory" => run_add_memory(rest),
        "supersede" => run_supersede(rest),
        "recall" => run_recall(rest),
        "check" => run_check(rest),
        "cornerstones" => run_cornerstones(rest),
        "brief" => run_brief(rest),
        "story" => run_story(rest),
        "reindex" => run_reindex(rest),
        // A first arg WAS given but it isn't a recognised subcommand — a
        // malformed CLI invocation, not the legitimate bare-invocation GUI-launch
        // case (that one never reaches this match at all: `args.first()` is
        // `None` and we `return` above). Fail fast instead of falling through
        // into the Tauri GUI.
        other => {
            eprintln!("{}", json!({ "error": format!("unknown command: {other}") }));
            eprintln!("run with --help for usage");
            std::process::exit(2);
        }
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

/// Usage text for `--help`/`-h`/`help` and for the "run with --help" hint on an
/// unknown command. Flags below are kept in sync with each `run_*` function's
/// own arg parsing — see the doc comment on each for the authoritative contract.
fn usage() -> String {
    "agent-studio-memory — headless CLI for the TFL memory store\n\
     \n\
     USAGE:\n\
     \x20 agent-studio-memory <command> [flags]\n\
     \n\
     COMMANDS:\n\
     \x20 add-memory     Write a new memory note and get a continuity signal back.\n\
     \x20                  --content <text>        Note body (or use --file)\n\
     \x20                  --file <path>           Read note body from a file\n\
     \x20                  --agent <name>          Required. Audit actor id.\n\
     \x20                  --name <slug>           Override the generated note name\n\
     \x20                  --type <type>           Override the suggested type\n\
     \x20                  --project <project>     Override the suggested project\n\
     \n\
     \x20 recall          Search memory, or resolve settled context for a note/topic.\n\
     \x20                  --query <text>          Keyword/semantic search\n\
     \x20                  --project <p>           Filter by project\n\
     \x20                  --type <t>              Filter by type\n\
     \x20                  --k <n>                 Result count (default 8)\n\
     \x20                  --about <file|name|topic>  Settled-context lookup instead of search\n\
     \n\
     \x20 check           Score content for continuity/conflicts without writing.\n\
     \x20                  --content <text>        Required.\n\
     \x20                  --project <p>           Accepted for symmetry with recall\n\
     \n\
     \x20 supersede       Mark an old note superseded by a new one (frontmatter only).\n\
     \x20                  --old <path|name>       Required. Note being replaced.\n\
     \x20                  --new <name>            Required. Replacement note.\n\
     \n\
     \x20 cornerstones    List top notes by salience (or neglected/archive candidates).\n\
     \x20                  --project <p>           Restrict to one project\n\
     \x20                  --k <n>                 Result count (default 12)\n\
     \x20                  --neglected             Return low-salience notes instead\n\
     \n\
     \x20 brief           Synthesise a situation report: settled, contested, recent.\n\
     \x20                  --project <p>           Restrict to one project\n\
     \x20                  --about <topic>         Focus the brief on a topic\n\
     \n\
     \x20 story           Narrate how a decision evolved (chain + audit trail).\n\
     \x20                  <note-name-or-path>     Positional, or use --topic\n\
     \x20                  --topic <t>             Resolve by topic instead of a name/path\n\
     \n\
     \x20 reindex         Rebuild the on-disk index + embeddings for the whole root.\n\
     \n\
     \x20 --help, -h, help   Show this message and exit.\n\
     \n\
     All commands print one JSON object (or array) to stdout on success and exit\n\
     0; on failure they print a JSON error to stderr and exit 1. An unrecognised\n\
     command exits 2.\n\
     \n\
     Memory root resolution: $MEMORY_ROOT env var, then the GUI's persisted\n\
     settings, then ~/Projects/tfl/memory.\n"
        .to_string()
}

/// Resolve the memory root for the headless path.
///
/// Precedence (first non-empty value wins):
/// 1. `MEMORY_ROOT` environment variable — explicit override.
/// 2. GUI's persisted settings store (`settings.json` under the OS app-config
///    dir), key `settings.memoryRoot`. Read directly as JSON — no Tauri
///    `AppHandle` needed — so the CLI shares the user's GUI configuration.
/// 3. `default_memory_root()` — `~/Projects/tfl/memory`.
///
/// Each tier degrades silently: if the store file is missing, unreadable, or
/// doesn't contain the key, we fall through to the next tier.
fn resolve_root() -> PathBuf {
    // Tier 1: env override.
    if let Ok(s) = std::env::var("MEMORY_ROOT") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return expand_tilde(trimmed);
        }
    }

    // Tier 2: GUI persisted settings store.
    if let Some(root) = read_root_from_store() {
        return root;
    }

    // Tier 3: compile-time default.
    default_memory_root()
}

/// Attempt to read `memoryRoot` from the GUI's tauri-plugin-store JSON file.
/// Returns `None` on any missing file, parse error, or missing/empty value.
fn read_root_from_store() -> Option<PathBuf> {
    let store_path = gui_store_path()?;
    let raw = fs::read_to_string(&store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    // Store layout: { "settings": { "memoryRoot": "...", ... } }
    let memory_root = json
        .get("settings")
        .and_then(|s| s.get("memoryRoot"))
        .and_then(|v| v.as_str())?;
    let trimmed = memory_root.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(expand_tilde(trimmed))
}

/// The OS path to the GUI's tauri-plugin-store file.
/// On macOS: `~/Library/Application Support/com.tinyforestlabs.agent-studio/<store>`
/// On Linux: `~/.config/com.tinyforestlabs.agent-studio/<store>`
fn gui_store_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let home = std::path::Path::new(&home);

    #[cfg(target_os = "macos")]
    let config_dir = home.join("Library/Application Support/com.tinyforestlabs.agent-studio");

    #[cfg(target_os = "linux")]
    let config_dir = home.join(".config/com.tinyforestlabs.agent-studio");

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let config_dir = home.join(".config/com.tinyforestlabs.agent-studio");

    Some(config_dir.join(STORE_FILE))
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if s == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(s)
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

    // 4b. Embed the new note's chunks so that headless `recall` is semantic
    // immediately (TIN-1743). Degrades gracefully: on any error we log and
    // continue — the write is already committed and the JSON contract is
    // unchanged. The JSON output is NOT modified by this step.
    let path_str = file_path.to_string_lossy().to_string();
    embed_new_note_chunks(&db, &path_str, &body);

    // 5. Record an `agent` audit row.
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

/// Embed the chunks for a newly-written note and store their vectors so that
/// headless `recall` returns semantic results immediately.
///
/// `body` is the frontmatter-FREE note content — the same text `build_index`
/// indexes (gray_matter strips the YAML), so we never embed frontmatter into the
/// semantic vector. It is chunked, embedded with the bundled local model, and
/// upserted into the `chunks` table.
///
/// **Degrade-safe**: any error (model not cached, DB lock failure, dim mismatch)
/// is logged at WARN level and the function returns normally — it NEVER fails
/// the write or alters the JSON output.
fn embed_new_note_chunks(db: &Db, file_path: &str, body: &str) {
    let chunks = chunk_text(body);
    if chunks.is_empty() {
        return;
    }

    // Compute fingerprints for cache-skip logic (matches the GUI pipeline).
    let chunk_data: Vec<(i64, String, String)> = chunks
        .iter()
        .enumerate()
        .map(|(i, text)| (i as i64, text.clone(), fingerprint(text)))
        .collect();

    let texts: Vec<String> = chunk_data.iter().map(|(_, t, _)| t.clone()).collect();

    // Embed all chunks with the bundled local model. Called directly (no
    // spawn_blocking) because run_add_memory is already on a plain OS thread —
    // the same pattern search_core uses for query embedding.
    let embeddings = match crate::local_embed::embed(texts) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[add-memory] embed: local_embed failed (model not cached?): {e}");
            return;
        }
    };

    if embeddings.len() != chunk_data.len() {
        log::warn!(
            "[add-memory] embed: got {} embeddings for {} chunks; skipping",
            embeddings.len(),
            chunk_data.len()
        );
        return;
    }

    // Upsert each chunk + embedding into the DB.
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[add-memory] embed: DB lock failed: {e}");
            return;
        }
    };

    for ((chunk_idx, content, sha256), embedding) in chunk_data.iter().zip(embeddings.iter()) {
        let blob = embedding_to_blob(embedding);
        if let Err(e) = conn.execute(
            "INSERT INTO chunks (file_path, chunk_idx, content, sha256, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(file_path, chunk_idx) DO UPDATE SET
               content   = excluded.content,
               sha256    = excluded.sha256,
               embedding = excluded.embedding",
            rusqlite::params![file_path, chunk_idx, content, sha256, blob],
        ) {
            log::warn!("[add-memory] embed: upsert chunk {chunk_idx} failed: {e}");
            // Continue with remaining chunks — partial embedding is better than none.
        }
    }
}

/// `reindex` — rebuild the on-disk index over the whole memory root and embed
/// every note's chunks. For when notes were added or edited OUT OF BAND — written
/// to disk directly, bulk-imported, or migrated by another tool — without going
/// through `add-memory`. The GUI does this on startup; this is the headless
/// equivalent so a pure-CLI workflow's `recall` reflects on-disk reality.
///
/// Embedding is degrade-safe per file (a missing model leaves keyword search
/// working); chunk vectors are upserted, so this refreshes existing notes and
/// populates new ones. Returns `{ indexed, embedded }`.
pub fn run_reindex(_rest: &[String]) -> Result<serde_json::Value, String> {
    let root = resolve_root();
    let db = open_db(&root)?;

    // 1. Rebuild memory_files + FTS + links across the whole root.
    let indexed = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_index(&root, &conn).map_err(|e| e.to_string())?
    };

    // 2. Collect the frontmatter-free body per file (build_index already stripped
    //    it into memory_files.body). Lock released before embedding.
    let files: Vec<(String, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path, body FROM memory_files")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 3. Embed each note's chunks (same degrade-safe path as add-memory).
    let mut embedded = 0usize;
    for (path, body) in &files {
        if !body.trim().is_empty() {
            embed_new_note_chunks(&db, path, body);
            embedded += 1;
        }
    }

    Ok(json!({ "indexed": indexed, "embedded": embedded }))
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
/// Usage:
///   `recall --query "<text>" [--project <p>] [--type <t>] [--k <n>]` — keyword/semantic search
///   `recall --about "<file|name|topic>"` — settled-context lookup: resolves the note, returns
///      related notes, full audit trail, and the supersede chain as a single JSON object.
///
/// Default k = 8.
pub fn run_recall(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);

    // --about takes priority: if present (and non-empty), route to the
    // settled-context path and return its JSON object (not an array).
    if let Some(about) = args.get("about").filter(|s| !s.trim().is_empty()) {
        return run_recall_about(about, &args);
    }

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


// ── recall --about (TIN-1741) ────────────────────────────────────────────────

/// Settled-context lookup for `recall --about <file|name|topic>`.
///
/// Returns a JSON object with the shape:
/// ```json
/// { "about": "<input>",
///   "resolved": "<path or null>",
///   "related": [ { "name": ..., "path": ..., "summary": ..., "status": ..., "score": 0.0 } ],
///   "audit":   [ { "actorType": ..., "actorId": ..., "changeSummary": ..., "continuityScore": ..., "ts": ... } ],
///   "chain":   [ { "name": ..., "path": ..., "status": ... } ]
/// }
/// ```
///
/// Degrade-safe: any failure reading audit rows or the supersede chain produces
/// empty arrays — the function never returns Err from those paths.
fn run_recall_about(about: &str, args: &Args) -> Result<serde_json::Value, String> {
    let k: usize = args.get("k").and_then(|s| s.parse().ok()).unwrap_or(8);

    let root = resolve_root();
    let db = open_db(&root)?;

    // Try to resolve `about` as a concrete note (by path or frontmatter name).
    let resolved: Option<PathBuf> = resolve_note(&root, about);

    // Run hybrid search using `about` as the query text (same path as --query).
    let search_input = SearchInput {
        q: about.to_string(),
        type_filter: String::new(),
        project_filter: String::new(),
        limit: Some(k as i64),
        rebuild: false,
    };
    let search_results = search_core(&db, &search_input, k).unwrap_or_default();

    // Build the `related` array — same shape as the regular recall array items,
    // minus the `snippet` field (not part of the --about contract).
    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    let related: Vec<serde_json::Value> = search_results
        .iter()
        .map(|r| {
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
                "score":   0.0,
            })
        })
        .collect();

    // Chain and audit are only populated when we resolved a concrete note.
    let (resolved_str, chain, audit): (serde_json::Value, Vec<serde_json::Value>, Vec<serde_json::Value>) =
        if let Some(ref resolved_path) = resolved {
            let resolved_str = json!(resolved_path.to_string_lossy().to_string());

            // Build the supersede chain (oldest-first).
            let chain_paths = collect_supersede_chain(&root, resolved_path);
            let chain_items: Vec<serde_json::Value> = chain_paths
                .iter()
                .map(|p| {
                    let name = note_name(p).unwrap_or_else(|| {
                        p.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string()
                    });
                    let raw = fs::read_to_string(p).unwrap_or_default();
                    let status = frontmatter_field(&raw, "status")
                        .unwrap_or_else(|| "active".to_string());
                    json!({ "name": name, "path": p.to_string_lossy(), "status": status })
                })
                .collect();

            // Collect audit rows for every note in the chain, newest-first overall.
            let audit_items: Vec<serde_json::Value> = {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                // Degrade-safe: if schema ensure fails, return empty.
                if ensure_audit_schema(&conn).is_err() {
                    Vec::new()
                } else {
                    let mut all_entries: Vec<(String, crate::memory_audit::AuditEntry)> = chain_paths
                        .iter()
                        .flat_map(|p| {
                            let path_str = p.to_string_lossy().to_string();
                            history_for(&conn, &path_str)
                                .unwrap_or_default()
                                .into_iter()
                                .map(move |e| (path_str.clone(), e))
                        })
                        .collect();
                    // Sort newest-first by audit entry id (monotonically increasing).
                    all_entries.sort_by(|a, b| b.1.id.cmp(&a.1.id));
                    all_entries
                        .into_iter()
                        .map(|(_, e)| {
                            json!({
                                "actorType":      e.actor_type,
                                "actorId":        e.actor_id,
                                "changeSummary":  e.change_summary,
                                "continuityScore": e.continuity_score,
                                "ts":             e.ts,
                            })
                        })
                        .collect()
                }
            };

            (resolved_str, chain_items, audit_items)
        } else {
            // No concrete note found — chain and audit are empty.
            (json!(null), Vec::new(), Vec::new())
        };

    Ok(json!({
        "about":    about,
        "resolved": resolved_str,
        "related":  related,
        "audit":    audit,
        "chain":    chain,
    }))
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

// ── cornerstones (TIN-1746) ──────────────────────────────────────────────────

/// The `cornerstones` pipeline.  Computes salience for all notes (or one
/// project), takes the top-k by salience, and prints a JSON array.
///
/// Usage: `cornerstones [--project <p>] [--k <n=12>] [--neglected]`
///
/// Default mode: top-k notes by salience, JSON array of:
/// `[{ name, path, summary, salience, readCount, centrality }]`
///
/// `--neglected`: instead return notes with near-zero salience (never-read,
/// low-centrality) — archive candidates.
pub fn run_cornerstones(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let project = args.get("project").filter(|p| !p.trim().is_empty());
    let k: usize = args.get("k").and_then(|s| s.parse().ok()).unwrap_or(12);
    let neglected = args.map.contains_key("neglected");

    let root = resolve_root();
    let db = open_db(&root)?;

    let mut entries = salience::salience(&db, project)?;

    let items: Vec<serde_json::Value> = if neglected {
        // --neglected: return notes with near-zero salience.
        // Use a threshold of 0.05 so notes with only marginal link degree still
        // get filtered in (they are not truly "corners" but are not orphans
        // either). We take up to k results ordered ascending by salience (least
        // salient first) so the worst candidates are surfaced first.
        entries.retain(|e| e.salience < salience::NEGLECTED_THRESHOLD);
        entries.sort_by(|a, b| {
            a.salience
                .partial_cmp(&b.salience)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        entries
            .into_iter()
            .take(k)
            .map(|e| {
                serde_json::json!({
                    "name":        e.name,
                    "path":        e.path,
                    "summary":     e.summary,
                    "salience":    e.salience,
                    "readCount":   e.read_count,
                    "centrality":  e.centrality,
                })
            })
            .collect()
    } else {
        // Default: top-k by descending salience (already sorted in salience::compute_salience).
        entries
            .into_iter()
            .take(k)
            .map(|e| {
                serde_json::json!({
                    "name":        e.name,
                    "path":        e.path,
                    "summary":     e.summary,
                    "salience":    e.salience,
                    "readCount":   e.read_count,
                    "centrality":  e.centrality,
                })
            })
            .collect()
    };

    Ok(serde_json::Value::Array(items))
}

// ── brief (TIN-1749) ─────────────────────────────────────────────────────────

/// The `brief` pipeline. Assembles top cornerstones (salience), most-recently-
/// changed notes (audit recency), and contested/superseded notes; synthesises a
/// calm situation report via `reason::complete`. Degrades calmly: with no model,
/// returns the raw assembled grounding as plain JSON without prose.
///
/// Usage: `brief [--project <p>] [--about <topic>]`
pub fn run_brief(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);
    let project = args.get("project").filter(|s| !s.trim().is_empty());
    let about = args.get("about").filter(|s| !s.trim().is_empty());

    let root = resolve_root();
    let db = open_db(&root)?;

    // ── 1. Top cornerstones (salience) ────────────────────────────────────────
    const CORNERSTONE_K: usize = 8;
    let cornerstones: Vec<serde_json::Value> = {
        let mut entries = salience::salience(&db, project)?;
        entries.truncate(CORNERSTONE_K);
        entries
            .into_iter()
            .map(|e| json!({ "name": e.name, "path": e.path, "summary": e.summary, "salience": e.salience }))
            .collect()
    };

    // ── 2. Most-recently-changed notes (audit recency) ────────────────────────
    // Pull the latest audit entry per note, take top 6 by recency.
    const RECENT_K: usize = 6;
    let recent_notes: Vec<serde_json::Value> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_audit_schema(&conn).map_err(|e| e.to_string())?;
        // Query: most recent audit row per path, most recent first.
        let mut stmt = conn
            .prepare(
                "SELECT path, MAX(ts) AS last_ts, change_summary \
                 FROM memory_audit \
                 GROUP BY path \
                 ORDER BY last_ts DESC \
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(rusqlite::params![RECENT_K as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        rows.into_iter()
            .map(|(path, ts, summary)| json!({ "path": path, "lastChanged": ts, "changeSummary": summary }))
            .collect()
    };

    // ── 3. Contested / superseded notes ──────────────────────────────────────
    // Walk the index for notes with status == "superseded" or that have a
    // `supersedes` / `superseded_by` field set.
    let contested: Vec<serde_json::Value> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT path, name, status FROM memory_files \
                 WHERE status = 'superseded' OR status = 'contested'",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<serde_json::Value> = stmt.query_map([], |r| {
            Ok(json!({
                "path": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
        rows
    };

    // Collect paths for grounding (deduplicated).
    let mut grounding: Vec<String> = cornerstones
        .iter()
        .filter_map(|v| v["path"].as_str().map(String::from))
        .collect();
    for r in &recent_notes {
        if let Some(p) = r["path"].as_str() {
            if !grounding.contains(&p.to_string()) {
                grounding.push(p.to_string());
            }
        }
    }
    for c in &contested {
        if let Some(p) = c["path"].as_str() {
            if !grounding.contains(&p.to_string()) {
                grounding.push(p.to_string());
            }
        }
    }

    // ── 4. Synthesise via reason::complete ────────────────────────────────────
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    // Build a context block for the model.
    let about_clause = about
        .map(|t| format!(" Focus especially on the topic: {t}."))
        .unwrap_or_default();

    let user_ctx = {
        let cs_text = cornerstones
            .iter()
            .enumerate()
            .map(|(i, v)| {
                format!(
                    "{}. {} — {}",
                    i + 1,
                    v["name"].as_str().unwrap_or(""),
                    v["summary"].as_str().unwrap_or("(no summary)")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let recent_text = recent_notes
            .iter()
            .map(|v| {
                format!(
                    "- {} (changed {}): {}",
                    v["path"].as_str().unwrap_or(""),
                    v["lastChanged"].as_str().unwrap_or(""),
                    v["changeSummary"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let contested_text = if contested.is_empty() {
            "(none)".to_string()
        } else {
            contested
                .iter()
                .map(|v| format!("- {} [{}]", v["name"].as_str().unwrap_or(""), v["status"].as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n")
        };
        format!(
            "TOP NOTES BY SALIENCE:\n{cs_text}\n\nRECENTLY CHANGED:\n{recent_text}\n\nCONTESTED / SUPERSEDED:\n{contested_text}"
        )
    };

    let system = "Write a short, calm situation report: what's settled, what's contested, what's recently changed. Plain prose, no preamble, no headers, no bullet lists.";

    let synthesis_result = rt.block_on(reason::complete(system, &format!("{user_ctx}{about_clause}")));

    match synthesis_result {
        Ok(prose) => Ok(json!({
            "brief": prose.trim(),
            "grounding": grounding,
            "degraded": false,
        })),
        Err(_) => {
            // Degrade: return raw grounding without prose.
            Ok(json!({
                "brief": null,
                "cornerstones": cornerstones,
                "recentlyChanged": recent_notes,
                "contested": contested,
                "grounding": grounding,
                "degraded": true,
            }))
        }
    }
}

// ── story (TIN-1749) ─────────────────────────────────────────────────────────

/// The `story` pipeline. Given a note name/path (or `--topic <t>`), assembles:
/// the note + its supersede chain (both directions via frontmatter fields), its
/// `memory_audit` trail, and related notes via recall. Hands to `reason::complete`
/// to narrate how the decision evolved. Degrades calmly: returns the ordered chain
/// without prose.
///
/// Usage: `story <note-name-or-path> [--topic <t>]`
pub fn run_story(rest: &[String]) -> Result<serde_json::Value, String> {
    let args = Args::parse(rest);

    // The note identifier is the first positional arg OR --topic.
    let positional = rest.iter().find(|a| !a.starts_with("--")).cloned();
    let topic = args.get("topic").map(str::to_string);
    let note_ref = positional
        .or(topic)
        .ok_or("a note name/path or --topic <t> is required")?;

    let root = resolve_root();
    let db = open_db(&root)?;

    // ── 1. Resolve the starting note ──────────────────────────────────────────
    let start_path = resolve_note(&root, &note_ref)
        .ok_or_else(|| format!("note not found: {note_ref}"))?;

    // ── 2. Walk the supersede chain in both directions ────────────────────────
    // Build an ordered list: oldest (head of chain) → newest. We follow
    // `supersedes` backward and `superseded_by` forward, deduplicating.
    let chain_paths = collect_supersede_chain(&root, &start_path);

    // ── 3. Collect audit history for each note in the chain ───────────────────
    let chain: Vec<serde_json::Value> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ensure_audit_schema(&conn).map_err(|e| e.to_string())?;

        chain_paths
            .iter()
            .map(|p| {
                let name = note_name(p).unwrap_or_else(|| {
                    p.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string()
                });
                let raw = fs::read_to_string(p).unwrap_or_default();
                let status = frontmatter_field(&raw, "status").unwrap_or_else(|| "active".to_string());
                let history: Vec<AuditEntry> =
                    history_for(&conn, &p.to_string_lossy()).unwrap_or_default();
                let edits: Vec<serde_json::Value> = history
                    .into_iter()
                    .map(|e| {
                        json!({
                            "ts": e.ts,
                            "actorType": e.actor_type,
                            "actorId": e.actor_id,
                            "continuityScore": e.continuity_score,
                            "changeSummary": e.change_summary,
                        })
                    })
                    .collect();
                json!({
                    "name": name,
                    "path": p.to_string_lossy(),
                    "status": status,
                    "edits": edits,
                })
            })
            .collect()
    };

    // ── 4. Recall related notes ───────────────────────────────────────────────
    let related: Vec<serde_json::Value> = {
        let input = crate::search::SearchInput {
            q: note_ref.clone(),
            type_filter: String::new(),
            project_filter: String::new(),
            limit: Some(5),
            rebuild: false,
        };
        match search_core(&db, &input, 5) {
            Ok(results) => results
                .into_iter()
                .filter(|r| {
                    // exclude notes already in the chain
                    !chain_paths
                        .iter()
                        .any(|p| p.to_string_lossy() == r.path.as_str())
                })
                .map(|r| json!({ "name": r.name, "path": r.path, "snippet": r.excerpt }))
                .collect(),
            Err(_) => Vec::new(),
        }
    };

    // ── 5. Synthesise via reason::complete ────────────────────────────────────
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;

    let user_ctx = {
        let chain_text = chain
            .iter()
            .map(|v| {
                let edits_text = v["edits"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|e| {
                                format!(
                                    "  [{}] {} ({}): {}",
                                    e["ts"].as_str().unwrap_or(""),
                                    e["actorId"].as_str().unwrap_or(""),
                                    e["actorType"].as_str().unwrap_or(""),
                                    e["changeSummary"].as_str().unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                format!(
                    "NOTE: {} [{}]\nPATH: {}\nEDITS:\n{}",
                    v["name"].as_str().unwrap_or(""),
                    v["status"].as_str().unwrap_or(""),
                    v["path"].as_str().unwrap_or(""),
                    if edits_text.is_empty() { "  (no recorded edits)".to_string() } else { edits_text }
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let related_text = if related.is_empty() {
            "(none)".to_string()
        } else {
            related
                .iter()
                .map(|v| format!("- {}: {}", v["name"].as_str().unwrap_or(""), v["snippet"].as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n")
        };
        format!("DECISION CHAIN (oldest → newest):\n{chain_text}\n\nRELATED NOTES:\n{related_text}")
    };

    let system = "Tell the story of how this decision evolved across the recorded changes and reversals. Calm, plain prose. No preamble, no headers.";

    let synthesis_result = rt.block_on(reason::complete(system, &user_ctx));

    let chain_paths_str: Vec<String> = chain_paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    match synthesis_result {
        Ok(prose) => Ok(json!({
            "story": prose.trim(),
            "chain": chain,
            "related": related,
            "degraded": false,
        })),
        Err(_) => Ok(json!({
            "story": null,
            "chain": chain,
            "chainPaths": chain_paths_str,
            "related": related,
            "degraded": true,
        })),
    }
}

/// Walk the supersede chain in both directions from `start`. Returns paths in
/// oldest-first order (head of chain → newest). Cycles are broken by a visited
/// set so malformed chains don't loop forever.
fn collect_supersede_chain(root: &Path, start: &Path) -> Vec<PathBuf> {
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut chain: std::collections::VecDeque<PathBuf> = std::collections::VecDeque::new();

    // Walk backwards via `supersedes` to the chain head.
    let mut cursor = start.to_path_buf();
    loop {
        if !visited.insert(cursor.clone()) {
            break; // cycle guard
        }
        chain.push_front(cursor.clone());
        let raw = match fs::read_to_string(&cursor) {
            Ok(r) => r,
            Err(_) => break,
        };
        let prev_name = match frontmatter_field(&raw, "supersedes") {
            Some(n) if !n.trim().is_empty() => n,
            _ => break,
        };
        match resolve_note(root, &prev_name) {
            Some(p) if !visited.contains(&p) => cursor = p,
            _ => break,
        }
    }

    // Walk forwards via `superseded_by` from start.
    let mut cursor = start.to_path_buf();
    loop {
        let raw = match fs::read_to_string(&cursor) {
            Ok(r) => r,
            Err(_) => break,
        };
        let next_name = match frontmatter_field(&raw, "superseded_by") {
            Some(n) if !n.trim().is_empty() => n,
            _ => break,
        };
        match resolve_note(root, &next_name) {
            Some(p) if !visited.contains(&p) => {
                visited.insert(p.clone());
                chain.push_back(p.clone());
                cursor = p;
            }
            _ => break,
        }
    }

    chain.into_iter().collect()
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

    // ── resolve_root (TIN-1736) ───────────────────────────────────────────────

    /// Write a minimal GUI store JSON file to `path` with the given memory root.
    fn write_store_json(path: &std::path::Path, memory_root: &str) {
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir).unwrap();
        let store = serde_json::json!({
            "settings": {
                "memoryRoot": memory_root,
                "promptsRoot": "",
                "skillsRoot": "",
                "transcriptsRoot": "",
                "agents": []
            }
        });
        fs::write(path, store.to_string()).unwrap();
    }

    #[test]
    fn resolve_root_env_wins_over_store() {
        let _guard = env_lock();

        // Set up a store file pointing at a different path.
        let store_dir = temp_root("rr-env-store");
        let fake_store_path = store_dir.join("settings.json");
        let store_root = temp_root("rr-env-store-root");
        write_store_json(&fake_store_path, &store_root.to_string_lossy());

        // Override HOME so gui_store_path() resolves to our fake store.
        // We set MEMORY_ROOT to yet another path — it must win.
        let env_root = temp_root("rr-env-root");
        std::env::set_var("MEMORY_ROOT", &env_root);

        // Point HOME at a fake dir so gui_store_path points at our temp store
        // (we bypass this because MEMORY_ROOT is set — it short-circuits).
        let result = resolve_root();
        std::env::remove_var("MEMORY_ROOT");

        assert_eq!(result, env_root, "MEMORY_ROOT env var wins over everything");
    }

    #[test]
    fn resolve_root_store_wins_when_no_env() {
        let _guard = env_lock();
        // Ensure MEMORY_ROOT is clear.
        std::env::remove_var("MEMORY_ROOT");

        // Stand up a fake store file.
        let store_root = temp_root("rr-store-root");
        let store_file = temp_root("rr-store-home")
            .join("Library/Application Support/com.tinyforestlabs.agent-studio/settings.json");
        write_store_json(&store_file, &store_root.to_string_lossy());

        // Override HOME so our fake store is found.
        let fake_home = store_file
            .parent().unwrap()   // .../com.tinyforestlabs.agent-studio
            .parent().unwrap()   // .../Application Support
            .parent().unwrap()   // .../Library
            .parent().unwrap();  // fake_home
        let real_home = std::env::var("HOME").unwrap_or_default();
        std::env::set_var("HOME", fake_home);

        let result = resolve_root();

        std::env::set_var("HOME", real_home);

        assert_eq!(result, store_root, "store value wins when env var is absent");
    }

    #[test]
    fn resolve_root_falls_back_to_default_when_store_missing() {
        let _guard = env_lock();
        std::env::remove_var("MEMORY_ROOT");

        // Point HOME at a tmp dir with no store file.
        let empty_home = temp_root("rr-no-store");
        let real_home = std::env::var("HOME").unwrap_or_default();
        std::env::set_var("HOME", &empty_home);

        let result = resolve_root();

        std::env::set_var("HOME", real_home);

        // Should equal default_memory_root() in that (restored) HOME.
        // After HOME is restored, default_memory_root() uses the real HOME.
        // So just check the result ends with the expected suffix.
        let result_str = result.to_string_lossy();
        assert!(
            result_str.ends_with("Projects/tfl/memory"),
            "falls back to default memory root: {result_str}"
        );
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

    // ── TIN-1743: embed on write ──────────────────────────────────────────────

    /// Full round-trip test: write a note via `run_add_memory` and assert the
    /// new note's chunks have non-NULL embeddings.
    ///
    /// Gated with `#[ignore]` because it requires the bundled embedding model to
    /// be already cached in `~/.agent-studio/models/`. Run with:
    ///   cargo test -- --ignored cli::tests::add_memory_embeds_chunks_with_model
    #[test]
    #[ignore = "needs the bundled embedding model cached"]
    fn add_memory_embeds_chunks_with_model() {
        let _guard = env_lock();
        let root = temp_root("embed-chunks");
        let _ = fixture_db(&root);

        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_add_memory(&[
            "--content".into(),
            "Attic Pro is a home-management app that helps homeowners record and track appliances and repairs.".into(),
            "--agent".into(),
            "tester".into(),
            "--project".into(),
            "attic".into(),
        ])
        .expect("add-memory succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let path_str = out["path"].as_str().expect("path in response");

        // Open the DB and check that at least one chunk for this file has a
        // non-NULL embedding.
        let db = fixture_db(&root);
        let conn = db.0.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE file_path = ?1 AND embedding IS NOT NULL",
                rusqlite::params![path_str],
                |r| r.get(0),
            )
            .expect("query chunks table");
        assert!(count > 0, "at least one chunk should have a non-NULL embedding after write");
    }

    /// Non-ignored degrade-safety test: `run_add_memory` must return `Ok` even
    /// when the embedding model is not available. The write succeeds; missing
    /// embeddings are a soft failure.
    #[test]
    fn add_memory_write_succeeds_even_when_embedding_fails() {
        // This test runs without the model cached. `embed_new_note_chunks` will
        // fail to load the model and log a warning, but `run_add_memory` must
        // return Ok with the standard JSON shape.
        let _guard = env_lock();
        let root = temp_root("embed-degrade");
        let _ = fixture_db(&root);

        std::env::set_var("MEMORY_ROOT", &root);
        let result = run_add_memory(&[
            "--content".into(),
            "A degrade-safety note: the write must succeed even if embedding fails.".into(),
            "--agent".into(),
            "tester".into(),
            "--project".into(),
            "studio".into(),
        ]);
        std::env::remove_var("MEMORY_ROOT");

        // The write must succeed regardless of whether embedding worked.
        let out = result.expect("add-memory returns Ok even when embedding is unavailable");
        assert_eq!(out["superseded"], json!(false));
        assert!(out["path"].as_str().is_some(), "path is present in response");
        let path = out["path"].as_str().unwrap();
        assert!(fs::read_to_string(path).is_ok(), "the note file was written to disk");
    }

    /// `reindex` picks up notes written OUT OF BAND (directly to disk, not via
    /// add-memory) and is degrade-safe without the embedding model: it indexes
    /// every on-disk note and attempts to embed each. This is the headless
    /// equivalent of the GUI's startup reindex.
    #[test]
    fn reindex_indexes_out_of_band_notes_and_is_degrade_safe() {
        let _guard = env_lock();
        let root = temp_root("reindex");
        let _ = fixture_db(&root);
        // Two notes written straight to disk — never through add-memory.
        write_note(
            &root,
            "studio/a.md",
            "---\nname: a\ntype: project\nprojects: studio\n---\nDecision A about the index.",
        );
        write_note(
            &root,
            "studio/b.md",
            "---\nname: b\ntype: project\nprojects: studio\n---\nDecision B about recall.",
        );

        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_reindex(&[]).expect("reindex succeeds even with no embedding model");
        std::env::remove_var("MEMORY_ROOT");

        assert_eq!(out["indexed"], json!(2), "both on-disk notes are indexed");
        assert!(
            out["embedded"].as_u64().unwrap() >= 2,
            "both notes were attempted for embedding: {out}"
        );
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

    // ── brief (TIN-1749) ─────────────────────────────────────────────────────

    /// Seed fixture for brief/story tests: creates 2 notes + audit rows.
    fn brief_fixture(tag: &str) -> (PathBuf, Db) {
        let root = temp_root(&format!("brief-{tag}"));
        let db = fixture_db(&root);

        let dir = root.join("studio");
        fs::create_dir_all(&dir).unwrap();

        // Note A: cornerstone candidate
        fs::write(
            dir.join("decision-a.md"),
            "---\nname: decision-a\ntype: project\nprojects: studio\nstatus: active\nsummary: We chose approach A.\n---\nWe chose approach A for the studio project.\n",
        )
        .unwrap();

        // Note B: superseded
        fs::write(
            dir.join("decision-b.md"),
            "---\nname: decision-b\ntype: project\nprojects: studio\nstatus: superseded\nsuperseded_by: decision-c\nsummary: Old approach B.\n---\nOld approach B was tried first.\n",
        )
        .unwrap();

        // Note C: supersedes B
        fs::write(
            dir.join("decision-c.md"),
            "---\nname: decision-c\ntype: project\nprojects: studio\nstatus: active\nsupersedes: decision-b\nsummary: New approach C replaces B.\n---\nNew approach C replaces B.\n",
        )
        .unwrap();

        // Rebuild index.
        {
            let conn = db.0.lock().unwrap();
            crate::search::build_index(&root, &conn).unwrap();
        }

        // Seed audit rows for B and C (simulating a supersede event).
        {
            let conn = db.0.lock().unwrap();
            let path_b = dir.join("decision-b.md").to_string_lossy().to_string();
            let path_c = dir.join("decision-c.md").to_string_lossy().to_string();
            crate::memory_audit::record_change(
                &conn,
                &crate::memory_audit::RecordMemoryChangeInput {
                    path: path_b,
                    actor_type: "agent".to_string(),
                    actor_id: "poppy".to_string(),
                    continuity_score: Some(0.9),
                    change_summary: "Created old approach B.".to_string(),
                    content_hash: "abc".to_string(),
                },
            )
            .unwrap();
            crate::memory_audit::record_change(
                &conn,
                &crate::memory_audit::RecordMemoryChangeInput {
                    path: path_c,
                    actor_type: "agent".to_string(),
                    actor_id: "poppy".to_string(),
                    continuity_score: Some(0.5),
                    change_summary: "Superseded B with new approach C.".to_string(),
                    content_hash: "def".to_string(),
                },
            )
            .unwrap();
        }

        (root, db)
    }

    #[test]
    fn brief_assembles_cornerstones_and_contested() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("assemble");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_brief(&[]).expect("brief succeeds");
        std::env::remove_var("MEMORY_ROOT");

        // Shape: grounding is an array of paths, degraded is a bool.
        assert!(out["grounding"].is_array(), "grounding is an array");
        assert!(out["degraded"].is_boolean(), "degraded is a boolean");

        // grounding must contain at least the contested note (decision-b is superseded).
        let grounding = out["grounding"].as_array().unwrap();
        let paths: Vec<&str> = grounding.iter().filter_map(|v| v.as_str()).collect();
        assert!(
            paths.iter().any(|p| p.contains("decision-b")),
            "superseded note in grounding: {paths:?}"
        );

        // On the degraded path (no model in CI), contested and cornerstones are top-level.
        if out["degraded"].as_bool() == Some(true) {
            assert!(out["contested"].is_array(), "contested array on degraded path");
            let contested = out["contested"].as_array().unwrap();
            assert!(
                contested.iter().any(|v| v["name"].as_str() == Some("decision-b")),
                "decision-b is contested: {contested:?}"
            );
        }
    }

    #[test]
    fn brief_project_filter_restricts_grounding() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("proj");
        std::env::set_var("MEMORY_ROOT", &root);
        // Non-existent project → empty salience, still returns valid JSON.
        let out = run_brief(&["--project".into(), "nonexistent-project".into()])
            .expect("brief with unknown project still succeeds");
        std::env::remove_var("MEMORY_ROOT");
        assert!(out["grounding"].is_array(), "grounding present even for empty project");
        assert!(out["degraded"].is_boolean(), "degraded present");
    }

    // ── story (TIN-1749) ──────────────────────────────────────────────────────

    #[test]
    fn story_walks_supersede_chain_in_order() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("story-chain");
        std::env::set_var("MEMORY_ROOT", &root);
        // Ask for the story of decision-c (which supersedes decision-b).
        let out = run_story(&["decision-c".into()]).expect("story succeeds");
        std::env::remove_var("MEMORY_ROOT");

        assert!(out["chain"].is_array(), "chain is an array");
        assert!(out["degraded"].is_boolean(), "degraded is a boolean");

        let chain = out["chain"].as_array().unwrap();
        assert!(
            chain.len() >= 2,
            "chain includes both decision-b and decision-c: {chain:?}"
        );

        // decision-b is older (head of chain), decision-c is newer (tail).
        // Chain is oldest-first.
        let names: Vec<&str> = chain.iter().filter_map(|v| v["name"].as_str()).collect();
        let pos_b = names.iter().position(|n| *n == "decision-b");
        let pos_c = names.iter().position(|n| *n == "decision-c");
        assert!(pos_b.is_some(), "decision-b in chain: {names:?}");
        assert!(pos_c.is_some(), "decision-c in chain: {names:?}");
        assert!(
            pos_b.unwrap() < pos_c.unwrap(),
            "decision-b (older) before decision-c (newer): {names:?}"
        );
    }

    #[test]
    fn story_includes_audit_edits_in_chain() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("story-edits");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_story(&["decision-c".into()]).expect("story succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let chain = out["chain"].as_array().unwrap();
        // decision-c has an audit row seeded in brief_fixture.
        let c_entry = chain.iter().find(|v| v["name"].as_str() == Some("decision-c"));
        assert!(c_entry.is_some(), "decision-c in chain");
        let edits = c_entry.unwrap()["edits"].as_array().unwrap();
        assert!(!edits.is_empty(), "decision-c has at least one audit edit");
        assert!(
            edits[0]["changeSummary"].as_str().unwrap_or("").contains("Superseded B"),
            "audit row changeSummary present: {:?}", edits[0]
        );
    }

    #[test]
    fn story_missing_note_errors_cleanly() {
        let _guard = env_lock();
        let root = temp_root("story-notnote");
        let _ = fixture_db(&root);
        std::env::set_var("MEMORY_ROOT", &root);
        let err = run_story(&["--topic".into(), "nonexistent-note-xyz".into()]).unwrap_err();
        std::env::remove_var("MEMORY_ROOT");
        assert!(err.contains("not found"), "error mentions not found: {err}");
    }
    // ── recall --about (TIN-1741) ────────────────────────────────────────────

    #[test]
    fn recall_about_note_with_audit_returns_audit_rows() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("about-audit");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_recall(&["--about".into(), "decision-c".into()])
            .expect("recall --about succeeds");
        std::env::remove_var("MEMORY_ROOT");

        // Must return an object, not an array.
        assert!(out.is_object(), "recall --about returns a JSON object: {out}");

        // Required top-level fields.
        assert!(out["about"].is_string(), "about field present");
        assert!(out["resolved"].is_string() || out["resolved"].is_null(), "resolved field present");
        assert!(out["related"].is_array(), "related field is an array");
        assert!(out["audit"].is_array(), "audit field is an array");
        assert!(out["chain"].is_array(), "chain field is an array");

        // decision-c was seeded with an audit row in brief_fixture.
        let audit = out["audit"].as_array().unwrap();
        assert!(!audit.is_empty(), "audit array is non-empty for decision-c");
    }

    #[test]
    fn recall_about_superseded_note_returns_chain() {
        let _guard = env_lock();
        let (root, _db) = brief_fixture("about-chain");
        std::env::set_var("MEMORY_ROOT", &root);
        let out = run_recall(&["--about".into(), "decision-c".into()])
            .expect("recall --about succeeds");
        std::env::remove_var("MEMORY_ROOT");

        let chain = out["chain"].as_array().unwrap();
        assert!(
            chain.len() >= 2,
            "chain includes decision-b and decision-c: {chain:?}"
        );

        // Each chain item must have the expected fields.
        for item in chain {
            assert!(item["name"].is_string(), "chain item has name field");
            assert!(item["path"].is_string(), "chain item has path field");
            assert!(item["status"].is_string(), "chain item has status field");
        }
    }

    #[test]
    fn recall_about_bare_topic_returns_related_with_empty_audit_and_chain() {
        let _guard = env_lock();
        let (root, _db) = recall_fixture("about-bare");
        std::env::set_var("MEMORY_ROOT", &root);
        // Use a topic that cannot possibly resolve to a note by path or name.
        let out = run_recall(&["--about".into(), "something-nonexistent-xyz".into()])
            .expect("recall --about with unknown topic returns Ok");
        std::env::remove_var("MEMORY_ROOT");

        // Must still return a well-formed object (not an error).
        assert!(out.is_object(), "result is a JSON object");
        assert_eq!(out["about"].as_str(), Some("something-nonexistent-xyz"), "about echoed back");
        assert!(out["resolved"].is_null(), "resolved is null for unresolvable topic");

        // Audit and chain are empty when no note was resolved.
        let audit = out["audit"].as_array().unwrap();
        assert!(audit.is_empty(), "audit is empty when note unresolved");
        let chain = out["chain"].as_array().unwrap();
        assert!(chain.is_empty(), "chain is empty when note unresolved");

        // related may be empty too (no semantic match), but must be an array.
        assert!(out["related"].is_array(), "related is always an array");
    }

}
