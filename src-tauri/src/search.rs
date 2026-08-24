//! search.rs
//!
//! Builds and queries a SQLite FTS5 index of all `.md` files under the memory
//! root, exposed to the frontend as Tauri commands. This is the Rust port of
//! the former `lib/memoryIndex.ts` + `pages/api/{search,files}.ts` so that
//! search works in a production `tauri build` (where Next.js API routes do not
//! exist).
//!
//! Database lives at: ~/Projects/tfl/memory/.studio-index.db
//! Root scanned:      ~/Projects/tfl/memory
//!
//! The `Connection` is held in Tauri managed state behind a `Mutex` (rusqlite's
//! `Connection` is `Send` but not `Sync`).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

use chrono::Local;
use gray_matter::engine::YAML;
use gray_matter::{Matter, ParsedEntity, Pod};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::hybrid;

// ── Types ───────────────────────────────────────────────────────────────────

/// A single search result. Field names match `MemorySearchResult` in
/// `lib/types.ts` (note `type` is a reserved word in Rust, hence the rename).
/// `Default` lets the hybrid ranker move results out of candidates cheaply.
#[derive(Serialize, Clone, Default)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub projects: Vec<String>,
    pub created: String,
    pub updated: String,
    pub tags: Vec<String>,
    pub status: String,
    pub excerpt: String,
}

/// Combined payload returned to the frontend — mirrors the old
/// `GET /api/search` response so `fetchSearch` keeps the same shape.
#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub types: Vec<String>,
    pub projects: Vec<String>,
}

/// Input for the `search` command. Per the project IPC convention, commands
/// with multiple args take a single `payload` struct.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub type_filter: String,
    #[serde(default)]
    pub project_filter: String,
    pub limit: Option<i64>,
    /// When true, rebuild the index from disk before searching. The frontend
    /// passes this on initial load (replacing the old `?init=true`).
    #[serde(default)]
    pub rebuild: bool,
}

/// Input for the `create_file` command.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileInput {
    pub name: String,
    pub slug: String,
    pub file_type: String,
    pub projects: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Managed state wrapper around the open SQLite connection.
pub struct Db(pub Mutex<Connection>);

// ── Paths ───────────────────────────────────────────────────────────────────

/// The configured memory root, read from Tauri managed state
/// (`settings::MemoryRoot`). This is resolved from the persisted settings at
/// startup and kept in sync whenever settings are saved, so search indexes and
/// queries the user's configured root rather than a hardcoded path. Falls back
/// to `~/Projects/tfl/memory` if the lock is poisoned.
fn memory_root(root: &State<'_, crate::settings::MemoryRoot>) -> PathBuf {
    root.0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_memory_root())
}

// ── Schema / connection ─────────────────────────────────────────────────────

pub(crate) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS memory_files (
      path      TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      type      TEXT NOT NULL DEFAULT '',
      projects  TEXT NOT NULL DEFAULT '',
      created   TEXT NOT NULL DEFAULT '',
      updated   TEXT NOT NULL DEFAULT '',
      tags      TEXT NOT NULL DEFAULT '',
      status    TEXT NOT NULL DEFAULT 'active',
      body      TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      name,
      type,
      projects,
      tags,
      body,
      content=memory_files,
      content_rowid=rowid
    );

    -- Key/value metadata (e.g. the active embedding dimension). Used so the
    -- vector store can be recreated when the embedding model changes (TIN-1692).
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- The `chunks` vector store (TIN-1631/1632) is created separately by
    -- `ensure_chunks_table` so its F32_BLOB width can follow the active model.

    -- Wiki-linking layer (TIN-1639). `links` is rebuilt from scratch on every
    -- index build (see links::rebuild_links); `ticket_cache` persists resolved
    -- Linear titles across rebuilds.
    CREATE TABLE IF NOT EXISTS links (
      from_path     TEXT NOT NULL,
      to_path       TEXT,
      to_ticket_id  TEXT,
      link_type     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS links_from ON links(from_path);
    CREATE INDEX IF NOT EXISTS links_to   ON links(to_path);

    CREATE TABLE IF NOT EXISTS ticket_cache (
      ticket_id  TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      fetched_at TEXT NOT NULL DEFAULT ''
    );
";

/// Dimensionality of stored embeddings. Tied to the active embedder — the
/// bundled candle model (TIN-1691). When this changes, `ensure_chunks_table`
/// recreates the vector store at the new width.
pub const EMBEDDING_DIM: usize = crate::local_embed::LOCAL_DIM;

/// Create the `chunks` vector table at the current [`EMBEDDING_DIM`]. If an
/// existing chunks table was built for a different width (e.g. a 1536-d OpenAI
/// DB), drop and recreate it so stored vectors always match the active model,
/// recording the dim in `meta`. Safe to call on every startup.
pub fn ensure_chunks_table(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;
    let stored: Option<i64> = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'embedding_dim'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if stored != Some(EMBEDDING_DIM as i64) {
        conn.execute("DROP TABLE IF EXISTS chunks", [])?;
    }
    conn.execute(
        &format!(
            "CREATE TABLE IF NOT EXISTS chunks (
               id        INTEGER PRIMARY KEY,
               file_path TEXT NOT NULL,
               chunk_idx INTEGER NOT NULL,
               content   TEXT NOT NULL,
               sha256    TEXT NOT NULL,
               embedding F32_BLOB({EMBEDDING_DIM}),
               UNIQUE(file_path, chunk_idx)
             )"
        ),
        [],
    )?;
    conn.execute("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(file_path)", [])?;
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('embedding_dim', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![EMBEDDING_DIM.to_string()],
    )?;
    Ok(())
}

/// Register the statically-linked `sqlite-vec` extension as a SQLite
/// *auto-extension*, so it is initialised on every connection opened afterwards
/// (including rusqlite's in-memory connections in tests).
///
/// Mechanism (sqlite-vec 0.1.9 + rusqlite 0.37, bundled SQLite):
/// `sqlite_vec::sqlite3_vec_init` is the extension's C entry point. We hand it
/// to `sqlite3_auto_extension`, which SQLite invokes for each new connection.
/// This is the crate's documented integration path — no loadable `.so`/`.dylib`
/// and no per-connection `load_extension` call, so `tauri build`'s static link
/// is unaffected.
///
/// `Once` guards against double-registration (auto-extensions are process-wide
/// global state; registering the same init twice is harmless but pointless, and
/// tests open many connections).
pub fn register_sqlite_vec() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `sqlite3_vec_init` has the C signature SQLite expects for an
        // auto-extension entry point; the transmute only erases the typed fn
        // pointer to the `unsafe extern "C" fn()` that the FFI binding wants.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                unsafe extern "C" fn(
                    *mut rusqlite::ffi::sqlite3,
                    *mut *mut i8,
                    *const rusqlite::ffi::sqlite3_api_routines,
                ) -> i32,
            >(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// Open (creating if needed) the index DB in `root` and ensure the schema.
pub fn init_db(root: &Path) -> rusqlite::Result<Connection> {
    // Register sqlite-vec BEFORE opening the connection so `F32_BLOB` columns
    // and the `vec_*` functions are available when the schema is created.
    register_sqlite_vec();

    // Make sure the root exists so Connection::open can create the db file.
    let _ = fs::create_dir_all(root);
    let db_path = root.join(".studio-index.db");
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // The ambient maintenance worker (TIN-1766) opens its OWN connection to this
    // same file so its local-model work never holds the shared `Db` mutex. WAL
    // already lets readers and writers coexist; a busy_timeout makes the brief
    // window where both connections write retry rather than error out.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    ensure_chunks_table(&conn)?;
    Ok(conn)
}

// ── Vector store (chunks) ────────────────────────────────────────────────────

/// Encode an f32 embedding into the little-endian byte blob sqlite-vec stores in
/// an `F32_BLOB` column.
pub fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// Decode an `F32_BLOB` byte blob back into an f32 embedding. Trailing bytes
/// that don't complete a 4-byte float are ignored (the column is fixed-width so
/// this is defensive only). Used to rehydrate representative embeddings for MMR.
pub fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// One nearest-neighbour hit from [`nearest_chunks`].
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkHit {
    pub id: i64,
    pub file_path: String,
    pub chunk_idx: i64,
    pub content: String,
    /// Cosine distance to the query vector (0 = identical direction).
    pub distance: f64,
}

/// Insert a chunk and its embedding, returning the new row id. `embedding` must
/// have [`EMBEDDING_DIM`] elements — sqlite-vec rejects a mismatched length.
/// Used by the embeddings pipeline (TIN-1631). Currently only exercised from
/// test modules in other files (embeddings.rs, continuity.rs) pending that
/// pipeline being wired to call it directly, hence the explicit allow.
#[allow(dead_code)]
pub fn insert_chunk(
    conn: &Connection,
    file_path: &str,
    chunk_idx: i64,
    content: &str,
    sha256: &str,
    embedding: &[f32],
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO chunks (file_path, chunk_idx, content, sha256, embedding)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![file_path, chunk_idx, content, sha256, embedding_to_blob(embedding)],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Cosine-similarity nearest-neighbour query over `chunks`. Returns up to
/// `limit` rows ordered by ascending `vec_distance_cosine` (closest first).
/// Used by hybrid search (TIN-1632).
pub fn nearest_chunks(
    conn: &Connection,
    query: &[f32],
    limit: i64,
) -> rusqlite::Result<Vec<ChunkHit>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_path, chunk_idx, content,
                vec_distance_cosine(embedding, ?1) AS distance
         FROM chunks
         WHERE embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![embedding_to_blob(query), limit], |row| {
        Ok(ChunkHit {
            id: row.get("id")?,
            file_path: row.get("file_path")?,
            chunk_idx: row.get("chunk_idx")?,
            content: row.get("content")?,
            distance: row.get("distance")?,
        })
    })?;
    rows.collect()
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────

/// Read a scalar string field from the parsed frontmatter map.
fn pod_string(map: &HashMap<String, Pod>, key: &str) -> Option<String> {
    map.get(key).and_then(|p| p.as_string().ok())
}

/// Read a field that may be either a scalar string or a list of strings
/// (mirrors the old `normalizeProjects` / `normalizeTags`).
fn pod_string_list(map: &HashMap<String, Pod>, key: &str) -> Vec<String> {
    match map.get(key) {
        Some(p) => {
            if let Ok(items) = p.as_vec() {
                items.iter().filter_map(|x| x.as_string().ok()).collect()
            } else if let Ok(s) = p.as_string() {
                if s.is_empty() {
                    Vec::new()
                } else {
                    vec![s]
                }
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    }
}

/// Parsed view of a single memory file, ready to insert.
struct FileRecord {
    path: String,
    name: String,
    type_: String,
    projects: String,
    created: String,
    updated: String,
    tags: String,
    status: String,
    body: String,
}

fn parse_file(matter: &Matter<YAML>, path: &Path) -> Option<FileRecord> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: ParsedEntity = matter.parse(&raw).ok()?;
    let map = parsed
        .data
        .as_ref()
        .and_then(|d| d.as_hashmap().ok())
        .unwrap_or_default();

    let fallback_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    Some(FileRecord {
        path: path.to_string_lossy().to_string(),
        name: pod_string(&map, "name").unwrap_or(fallback_name),
        type_: pod_string(&map, "type").unwrap_or_default(),
        projects: pod_string_list(&map, "projects").join(","),
        created: pod_string(&map, "created").unwrap_or_default(),
        updated: pod_string(&map, "updated").unwrap_or_default(),
        tags: pod_string_list(&map, "tags").join(","),
        status: pod_string(&map, "status").unwrap_or_else(|| "active".to_string()),
        body: parsed.content.trim().to_string(),
    })
}

// ── Indexing ────────────────────────────────────────────────────────────────

/// Recursively collect `.md` files under `dir`, skipping hidden files/dirs and
/// `MEMORY.md` (the index loaded directly into the agent's context).
fn collect_md_files(dir: &Path, results: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let full = entry.path();
        if full.is_dir() {
            collect_md_files(&full, results);
        } else if name.ends_with(".md") && name != "MEMORY.md" {
            results.push(full);
        }
    }
}

/// Full rebuild of the index from disk. Returns the number of files indexed.
pub fn build_index(root: &Path, conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute_batch("DELETE FROM memory_fts; DELETE FROM memory_files;")?;

    let mut files = Vec::new();
    collect_md_files(root, &mut files);

    let matter = Matter::<YAML>::new();
    // (path, name, body) for each indexed file — handed to the wiki-link scanner
    // after the FTS rows are committed.
    let mut link_inputs: Vec<(String, String, String)> = Vec::new();
    let tx = conn.unchecked_transaction()?;
    {
        let mut insert_file = tx.prepare(
            "INSERT INTO memory_files
               (path, name, type, projects, created, updated, tags, status, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let mut insert_fts = tx.prepare(
            "INSERT INTO memory_fts (rowid, name, type, projects, tags, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;

        for path in &files {
            if let Some(rec) = parse_file(&matter, path) {
                insert_file.execute(params![
                    rec.path,
                    rec.name,
                    rec.type_,
                    rec.projects,
                    rec.created,
                    rec.updated,
                    rec.tags,
                    rec.status,
                    rec.body,
                ])?;
                let rowid = tx.last_insert_rowid();
                insert_fts.execute(params![
                    rowid,
                    rec.name,
                    rec.type_,
                    rec.projects,
                    rec.tags,
                    rec.body,
                ])?;
                link_inputs.push((rec.path, rec.name, rec.body));
            }
        }
    }
    tx.commit()?;

    // Rebuild the wiki-link graph from the freshly-indexed content (TIN-1639).
    crate::links::rebuild_links(conn, &link_inputs)?;

    // Change-triggered maintenance dispatch (TIN-1763): diff this pass's notes
    // against the stored fingerprints and fan each add/edit/delete out to the
    // registered handlers. Detection rides the same parsed bodies we just
    // indexed (`link_inputs` carries (path, name, body)), so it adds no extra
    // file reads beyond an mtime stat per note. A failure here is logged and
    // swallowed — maintenance is ambient and must never fail the index/search.
    let present: Vec<crate::maintenance::IndexedNote> = link_inputs
        .iter()
        .map(|(path, _name, body)| crate::maintenance::IndexedNote { path, body })
        .collect();
    let handlers = crate::maintenance::default_handlers();
    if let Err(e) = crate::maintenance::detect_and_dispatch(conn, &present, &handlers) {
        log::warn!("[maintenance] change dispatch failed (index unaffected): {e}");
    }

    Ok(files.len())
}

// ── search_core (headless CLI entry point, TIN-1739) ─────────────────────────

/// Core search pipeline, callable with a plain `&Db` (no Tauri state). Used by
/// the headless `recall` CLI subcommand (TIN-1739); the `search` Tauri command
/// is a thin async wrapper around the same steps.
///
/// When `top_n` is 0 the default of 20 is used. The function runs the async
/// embedding step on a fresh current-thread tokio runtime so it can be called
/// from synchronous CLI code — matching the pattern used by `add-memory`.
pub fn search_core(db: &Db, input: &SearchInput, top_n: usize) -> Result<Vec<SearchResult>, String> {
    let top_n = if top_n == 0 { 20 } else { top_n };
    let query = input.q.trim().to_string();

    // ── Phase A: locked FTS pass ─────────────────────────────────────────────
    let fts = if query.is_empty() {
        // No text query — recency / filter list.
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut results = run_search(&conn, input).map_err(|e| e.to_string())?;
        derank_superseded(&mut results);
        return Ok(results);
    } else {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        fts_candidates(&conn, input).map_err(|e| e.to_string())?
    };

    // ── Phase B: embed the query ─────────────────────────────────────────────
    // Called synchronously from the CLI — the embedder is CPU-bound (candle),
    // so we call it directly rather than spawning a blocking task. The Tauri
    // command wraps the same step with spawn_blocking to avoid blocking the
    // async runtime; here we are already on a plain OS thread.
    let query_vec: Option<Vec<f32>> = if query.len() >= 2 {
        crate::local_embed::embed(vec![query.clone()])
            .ok()
            .and_then(|mut v| v.pop())
    } else {
        None
    };
    let has_embeddings = query_vec.is_some();

    // ── Phase C: vector arm + candidate assembly ─────────────────────────────
    let candidates = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_rank_inputs(&conn, input, fts, query_vec.as_deref()).map_err(|e| e.to_string())?
    };

    // ── Phase D: rank ────────────────────────────────────────────────────────
    let mut results = crate::hybrid::rank(candidates, has_embeddings, chrono::Local::now().date_naive(), top_n);
    derank_superseded(&mut results);
    Ok(results)
}

// ── Superseded de-ranking ────────────────────────────────────────────────────

/// Stable secondary sort that demotes `status == "superseded"` notes below all
/// other statuses. Active notes with better relevance still surface first; a
/// superseded note only loses its position relative to an equally-ranked active
/// one. Superseded notes are NEVER removed — they remain reachable via the
/// supersedes chain and are still displayed (the frontend renders a quiet chip).
///
/// Per-query LLM judging of active-vs-active conflicts at retrieval time is
/// intentionally deferred: it would add one model call per search, which is too
/// expensive for an interactive query path. Conflict detection at write-time
/// (TIN-1730/continuity scorer) covers that case instead.
pub(crate) fn derank_superseded(results: &mut [SearchResult]) {
    results.sort_by_key(|r| u8::from(r.status.trim() == "superseded"));
}

// ── Querying ────────────────────────────────────────────────────────────────

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<SearchResult> {
    let projects: String = row.get("projects")?;
    let tags: String = row.get("tags")?;
    Ok(SearchResult {
        path: row.get("path")?,
        name: row.get("name")?,
        type_: row.get("type")?,
        projects: projects.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
        created: row.get("created")?,
        updated: row.get("updated")?,
        tags: tags.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
        status: row.get("status")?,
        excerpt: row.get("excerpt")?,
    })
}

fn run_search(conn: &Connection, input: &SearchInput) -> rusqlite::Result<Vec<SearchResult>> {
    use rusqlite::types::Value;

    let limit = input.limit.unwrap_or(30);
    let type_f = input.type_filter.trim();
    let project_f = input.project_filter.trim();
    let query = input.q.trim();

    // Build the optional filter SQL and the matching positional params in the
    // same order they appear in the statement.
    let mut filter_sql = String::new();
    let mut filter_params: Vec<Value> = Vec::new();
    if !type_f.is_empty() {
        filter_sql.push_str(" AND mf.type = ?");
        filter_params.push(Value::Text(type_f.to_string()));
    }
    if !project_f.is_empty() {
        filter_sql.push_str(" AND (',' || mf.projects || ',') LIKE ?");
        filter_params.push(Value::Text(format!("%,{},%", project_f)));
    }

    let (sql, params): (String, Vec<Value>) = if !query.is_empty() {
        // FTS5 prefix query — wrap in quotes to neutralise FTS syntax chars.
        let fts_query = format!("\"{}\"*", query.replace('"', "\"\""));
        let sql = format!(
            "SELECT mf.path, mf.name, mf.type, mf.projects, mf.created, mf.updated,
                    mf.tags, mf.status,
                    snippet(memory_fts, 4, '', '', '…', 20) AS excerpt
             FROM memory_fts
             JOIN memory_files mf ON mf.rowid = memory_fts.rowid
             WHERE memory_fts MATCH ?{filter_sql}
             ORDER BY rank
             LIMIT ?"
        );
        let mut params = vec![Value::Text(fts_query)];
        params.extend(filter_params);
        params.push(Value::Integer(limit));
        (sql, params)
    } else if !type_f.is_empty() || !project_f.is_empty() {
        // Filters only, no text query — list filtered files, newest first.
        let sql = format!(
            "SELECT mf.path, mf.name, mf.type, mf.projects, mf.created, mf.updated,
                    mf.tags, mf.status, substr(mf.body, 1, 160) AS excerpt
             FROM memory_files mf
             WHERE 1=1{filter_sql}
             ORDER BY mf.updated DESC
             LIMIT ?"
        );
        let mut params = filter_params;
        params.push(Value::Integer(limit));
        (sql, params)
    } else {
        // No query, no filters — most-recently-updated files.
        let sql = "SELECT path, name, type, projects, created, updated, tags, status,
                    substr(body, 1, 160) AS excerpt
             FROM memory_files
             ORDER BY updated DESC
             LIMIT ?"
            .to_string();
        (sql, vec![Value::Integer(limit)])
    };

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
        results.push(map_row(row)?);
    }
    Ok(results)
}

// ── Hybrid search (TIN-1632) ─────────────────────────────────────────────────

/// How many candidates to pull from each retriever before ranking. Larger than
/// the returned `top_n` so temporal decay + MMR have room to reorder.
const CANDIDATE_POOL: i64 = 50;

/// Build the optional `type`/`project` filter SQL fragment and its positional
/// params, shared by the FTS and hybrid paths.
fn build_filters(input: &SearchInput) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let mut sql = String::new();
    let mut params: Vec<Value> = Vec::new();
    let type_f = input.type_filter.trim();
    let project_f = input.project_filter.trim();
    if !type_f.is_empty() {
        sql.push_str(" AND mf.type = ?");
        params.push(Value::Text(type_f.to_string()));
    }
    if !project_f.is_empty() {
        sql.push_str(" AND (',' || mf.projects || ',') LIKE ?");
        params.push(Value::Text(format!("%,{},%", project_f)));
    }
    (sql, params)
}

/// Lowercased, de-duplicated content tokens (alphanumeric words) for the Jaccard
/// MMR fallback. Capped so a huge file doesn't blow up the candidate payload.
fn tokenize(body: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in body.split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        let tok = raw.to_lowercase();
        if seen.insert(tok.clone()) {
            out.push(tok);
            if out.len() >= 200 {
                break;
            }
        }
    }
    out
}

/// True if a result satisfies the active type/project filters (applied to
/// vector-only candidates, which bypass the FTS WHERE clause).
fn passes_filters(result: &SearchResult, input: &SearchInput) -> bool {
    let tf = input.type_filter.trim();
    let pf = input.project_filter.trim();
    if !tf.is_empty() && result.type_ != tf {
        return false;
    }
    if !pf.is_empty() && !result.projects.iter().any(|p| p == pf) {
        return false;
    }
    true
}

/// FTS5 candidates for a non-empty text query, each carrying its BM25 `rank` and
/// content tokens. This is the BM25 arm of the hybrid pipeline.
fn fts_candidates(
    conn: &Connection,
    input: &SearchInput,
) -> rusqlite::Result<Vec<hybrid::RankInput>> {
    use rusqlite::types::Value;
    let query = input.q.trim();
    let fts_query = format!("\"{}\"*", query.replace('"', "\"\""));
    let (filter_sql, filter_params) = build_filters(input);

    let sql = format!(
        "SELECT mf.path, mf.name, mf.type, mf.projects, mf.created, mf.updated,
                mf.tags, mf.status,
                snippet(memory_fts, 4, '', '', '…', 20) AS excerpt,
                mf.body AS body, rank AS rank
         FROM memory_fts
         JOIN memory_files mf ON mf.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ?{filter_sql}
         ORDER BY rank
         LIMIT ?"
    );
    let mut params: Vec<Value> = vec![Value::Text(fts_query)];
    params.extend(filter_params);
    params.push(Value::Integer(CANDIDATE_POOL));

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let result = map_row(row)?;
        let body: String = row.get("body")?;
        let rank: f64 = row.get("rank")?;
        out.push(hybrid::RankInput {
            result,
            bm25_rank: Some(rank),
            vec_dist: None,
            embedding: None,
            terms: tokenize(&body),
        });
    }
    Ok(out)
}

/// Fetch display metadata + body for a single file by path (for vector-only
/// candidates the FTS arm never saw).
fn fetch_meta(conn: &Connection, path: &str) -> Option<(SearchResult, String)> {
    conn.query_row(
        "SELECT path, name, type, projects, created, updated, tags, status,
                substr(body, 1, 160) AS excerpt, body
         FROM memory_files WHERE path = ?1",
        params![path],
        |row| {
            let projects: String = row.get("projects")?;
            let tags: String = row.get("tags")?;
            let body: String = row.get("body")?;
            Ok((
                SearchResult {
                    path: row.get("path")?,
                    name: row.get("name")?,
                    type_: row.get("type")?,
                    projects: projects.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
                    created: row.get("created")?,
                    updated: row.get("updated")?,
                    tags: tags.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
                    status: row.get("status")?,
                    excerpt: row.get("excerpt")?,
                },
                body,
            ))
        },
    )
    .ok()
}

/// A representative embedding for a file (its first stored chunk), decoded for
/// MMR cosine similarity. `None` when the file has no embedded chunk.
fn representative_embedding(conn: &Connection, path: &str) -> Option<Vec<f32>> {
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT embedding FROM chunks
             WHERE file_path = ?1 AND embedding IS NOT NULL
             ORDER BY chunk_idx LIMIT 1",
            params![path],
            |r| r.get(0),
        )
        .ok()?;
    Some(blob_to_embedding(&blob))
}

/// Assemble the full candidate set for hybrid ranking: FTS hits, plus any
/// vector-only (semantic) hits, with each candidate's best cosine distance and a
/// representative embedding attached. When `query_vec` is `None` (no API key),
/// this degrades to the FTS candidates alone — pure BM25.
fn build_rank_inputs(
    conn: &Connection,
    input: &SearchInput,
    mut candidates: Vec<hybrid::RankInput>,
    query_vec: Option<&[f32]>,
) -> rusqlite::Result<Vec<hybrid::RankInput>> {
    if let Some(qv) = query_vec {
        // Best (smallest) cosine distance per file across its chunks.
        let hits = nearest_chunks(conn, qv, CANDIDATE_POOL)?;
        let mut best: HashMap<String, f64> = HashMap::new();
        for h in hits {
            let e = best.entry(h.file_path).or_insert(h.distance);
            if h.distance < *e {
                *e = h.distance;
            }
        }

        // Attach distances to existing FTS candidates.
        for c in candidates.iter_mut() {
            if let Some(d) = best.get(&c.result.path) {
                c.vec_dist = Some(*d);
            }
        }

        // Add vector-only candidates (respecting filters).
        let known: std::collections::HashSet<String> =
            candidates.iter().map(|c| c.result.path.clone()).collect();
        for (path, dist) in best.iter() {
            if known.contains(path) {
                continue;
            }
            if let Some((result, body)) = fetch_meta(conn, path) {
                if passes_filters(&result, input) {
                    candidates.push(hybrid::RankInput {
                        result,
                        bm25_rank: None,
                        vec_dist: Some(*dist),
                        embedding: None,
                        terms: tokenize(&body),
                    });
                }
            }
        }

        // Rehydrate a representative embedding for every candidate (for MMR).
        for c in candidates.iter_mut() {
            c.embedding = representative_embedding(conn, &c.result.path);
        }
    }
    Ok(candidates)
}

fn distinct_types(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT type FROM memory_files WHERE type != '' ORDER BY type")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn distinct_projects(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT projects FROM memory_files WHERE projects != ''")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut set: Vec<String> = Vec::new();
    for joined in rows.filter_map(Result::ok) {
        for p in joined.split(',').filter(|s| !s.is_empty()) {
            if !set.iter().any(|x| x == p) {
                set.push(p.to_string());
            }
        }
    }
    set.sort();
    Ok(set)
}

// ── File creation ───────────────────────────────────────────────────────────

fn today_iso() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Serialise a string list as a YAML value: inline scalar for a single entry,
/// a block sequence for many, `[]` for none.
fn yaml_list(values: &[String]) -> String {
    match values.len() {
        0 => "[]".to_string(),
        1 => values[0].clone(),
        _ => {
            let mut out = String::from("\n");
            for v in values {
                out.push_str("  - ");
                out.push_str(v);
                out.push('\n');
            }
            out.pop(); // trailing newline; the template adds its own
            out
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn search(
    payload: SearchInput,
    db: State<'_, Db>,
    memory: State<'_, crate::settings::MemoryRoot>,
) -> Result<SearchResponse, String> {
    let root = memory_root(&memory);
    let query = payload.q.trim().to_string();

    // ── Phase A: locked DB work (no await) ───────────────────────────────────
    // Rebuild if asked, gather the FTS candidate pool, and read the filter
    // facets. The guard is dropped at the end of this block so we never hold it
    // across the embedding await below.
    let (fts, types, projects) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if payload.rebuild {
            build_index(&root, &conn).map_err(|e| e.to_string())?;
        }
        let types = distinct_types(&conn).map_err(|e| e.to_string())?;
        let projects = distinct_projects(&conn).map_err(|e| e.to_string())?;
        // No text query → recency/filter list, exactly as before. Return early.
        if query.is_empty() {
            let mut results = run_search(&conn, &payload).map_err(|e| e.to_string())?;
            derank_superseded(&mut results);
            return Ok(SearchResponse { results, types, projects });
        }
        let fts = fts_candidates(&conn, &payload).map_err(|e| e.to_string())?;
        (fts, types, projects)
    };

    // ── Phase B: embed the query (no lock held) ──────────────────────────────
    // Embed with the bundled local model on a blocking thread (CPU-bound), so
    // the same vectors as the stored chunks drive semantic recall. If the model
    // isn't ready yet (still downloading on first run) or fails, the pipeline
    // degrades to pure BM25 — never an error to the user.
    let query_vec: Option<Vec<f32>> = if query.len() >= 2 {
        let q = query.clone();
        match tokio::task::spawn_blocking(move || crate::local_embed::embed(vec![q])).await {
            Ok(Ok(mut v)) => v.pop(),
            Ok(Err(e)) => {
                log::warn!("[search] local query embed failed, BM25-only: {e}");
                None
            }
            Err(e) => {
                log::warn!("[search] query embed task failed: {e}");
                None
            }
        }
    } else {
        None
    };
    let has_embeddings = query_vec.is_some();

    // ── Phase C: locked DB work — vector arm + candidate assembly ────────────
    let candidates = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_rank_inputs(&conn, &payload, fts, query_vec.as_deref()).map_err(|e| e.to_string())?
    };

    // ── Phase D: pure ranking ────────────────────────────────────────────────
    let top_n = payload.limit.unwrap_or(20).max(1) as usize;
    let mut results = hybrid::rank(candidates, has_embeddings, Local::now().date_naive(), top_n);
    derank_superseded(&mut results);
    Ok(SearchResponse { results, types, projects })
}

/// Render the markdown file content (frontmatter + body) for a new memory file.
fn render_file(payload: &CreateFileInput, today: &str) -> String {
    format!(
        "---\nname: {name}\ntype: {type_}\nprojects: {projects}\ncreated: {created}\nupdated: {updated}\ntags: {tags}\nstatus: active\n---\n\n{body}\n",
        name = payload.slug,
        type_ = payload.file_type,
        projects = yaml_list(&payload.projects),
        created = today,
        updated = today,
        tags = yaml_list(&payload.tags),
        body = payload.name,
    )
}

/// Write a new memory file under `root`, returning its path. Pure of Tauri
/// state and the real memory root so it can be exercised in tests.
fn write_new_file(root: &Path, payload: &CreateFileInput, today: &str) -> Result<PathBuf, String> {
    if payload.name.is_empty()
        || payload.slug.is_empty()
        || payload.file_type.is_empty()
        || payload.projects.is_empty()
    {
        return Err("name, slug, type, and projects are required".to_string());
    }

    let dir = root.join(&payload.projects[0]);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file_path = dir.join(format!("{}.md", payload.slug));
    if file_path.exists() {
        return Err("File already exists".to_string());
    }

    fs::write(&file_path, render_file(payload, today)).map_err(|e| e.to_string())?;
    Ok(file_path)
}

#[tauri::command]
pub fn create_file(
    payload: CreateFileInput,
    db: State<'_, Db>,
    memory: State<'_, crate::settings::MemoryRoot>,
) -> Result<String, String> {
    let root = memory_root(&memory);
    let file_path = write_new_file(&root, &payload, &today_iso())?;

    // Rebuild the index so the new file is immediately searchable.
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    build_index(&root, &conn).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory connection with the production schema applied. Registers
    /// sqlite-vec first so the `chunks` table's `F32_BLOB` column is recognised.
    fn mem_db() -> Connection {
        register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ensure_chunks_table(&conn).unwrap();
        conn
    }

    /// Fresh temp dir, uniquely tagged per test (no RNG needed).
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn input(q: &str) -> SearchInput {
        SearchInput {
            q: q.to_string(),
            type_filter: String::new(),
            project_filter: String::new(),
            limit: None,
            rebuild: false,
        }
    }

    // build_index is a state projector + run_search is a resolver:
    // CRUD round-trips aren't enough, so these prove the logic fires,
    // doesn't fire incorrectly, and handles the tree's edge cases.

    #[test]
    fn search_fires_on_matching_term() {
        let root = temp_root("fires");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nThe rusqlite migration is load-bearing.");
        write(&root, "studio/b.md", "---\nname: beta\ntype: project\nprojects: studio\n---\nSomething about embeddings.");
        let conn = mem_db();
        let n = build_index(&root, &conn).unwrap();
        assert_eq!(n, 2);

        let hits = run_search(&conn, &input("rusqlite")).unwrap();
        assert_eq!(hits.len(), 1, "exactly the file mentioning rusqlite");
        assert_eq!(hits[0].name, "alpha");
    }

    #[test]
    fn search_does_not_fire_on_absent_term() {
        let root = temp_root("absent");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nNothing notable here.");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let hits = run_search(&conn, &input("kubernetes")).unwrap();
        assert!(hits.is_empty(), "absent term yields no results");
    }

    #[test]
    fn type_filter_narrows_results() {
        let root = temp_root("typefilter");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nshared keyword widget");
        write(&root, "studio/b.md", "---\nname: beta\ntype: project\nprojects: studio\n---\nshared keyword widget");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let mut q = input("widget");
        q.type_filter = "project".to_string();
        let hits = run_search(&conn, &q).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].type_, "project");
    }

    #[test]
    fn project_filter_handles_string_and_list_frontmatter() {
        let root = temp_root("projlist");
        // `projects` as a scalar...
        write(&root, "attic/a.md", "---\nname: alpha\ntype: project\nprojects: attic\n---\nshared keyword");
        // ...and as a YAML list including the same project.
        write(&root, "studio/b.md", "---\nname: beta\ntype: project\nprojects:\n  - studio\n  - attic\n---\nshared keyword");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let mut q = input("keyword");
        q.project_filter = "attic".to_string();
        let mut names: Vec<String> = run_search(&conn, &q).unwrap().into_iter().map(|r| r.name).collect();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta"], "both the scalar and list forms match the project filter");
    }

    #[test]
    fn index_skips_memory_md_and_hidden() {
        let root = temp_root("skips");
        write(&root, "MEMORY.md", "---\nname: index\n---\nshould be skipped");
        write(&root, ".hidden/secret.md", "---\nname: secret\n---\nshould be skipped");
        write(&root, "studio/real.md", "---\nname: real\ntype: feedback\nprojects: studio\n---\nindexme");
        let conn = mem_db();
        let n = build_index(&root, &conn).unwrap();
        assert_eq!(n, 1, "only the real file is indexed");
        assert_eq!(run_search(&conn, &input("indexme")).unwrap().len(), 1);
    }

    #[test]
    fn create_then_search_round_trips() {
        // Cascade: write a new file, then confirm it's indexed and findable.
        let root = temp_root("create");
        let payload = CreateFileInput {
            name: "Hybrid search keeps the recall high".to_string(),
            slug: "hybrid-search-note".to_string(),
            file_type: "feedback".to_string(),
            projects: vec!["studio".to_string()],
            tags: vec!["search".to_string(), "recall".to_string()],
        };
        let path = write_new_file(&root, &payload, "2026-06-20").unwrap();
        assert!(path.ends_with("studio/hybrid-search-note.md"));

        let conn = mem_db();
        build_index(&root, &conn).unwrap();
        let hits = run_search(&conn, &input("recall")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "hybrid-search-note");
        assert_eq!(hits[0].tags, vec!["search".to_string(), "recall".to_string()]);
    }

    #[test]
    fn create_rejects_duplicate_and_missing_fields() {
        let root = temp_root("dup");
        let payload = CreateFileInput {
            name: "x".to_string(),
            slug: "dup".to_string(),
            file_type: "feedback".to_string(),
            projects: vec!["studio".to_string()],
            tags: vec![],
        };
        write_new_file(&root, &payload, "2026-06-20").unwrap();
        assert!(write_new_file(&root, &payload, "2026-06-20").is_err(), "duplicate path rejected");

        let mut bad = payload.clone();
        bad.projects = vec![];
        assert!(write_new_file(&root, &bad, "2026-06-20").is_err(), "missing projects rejected");
    }

    // ── sqlite-vec ────────────────────────────────────────────────────────────

    /// An [`EMBEDDING_DIM`]-wide unit-ish vector pointing mostly along `axis`.
    /// Cheap way to make vectors whose cosine ordering is predictable.
    fn axis_vec(axis: usize) -> Vec<f32> {
        let mut v = vec![0.0_f32; EMBEDDING_DIM];
        v[axis] = 1.0;
        v[axis + 1] = 0.1; // small off-axis component so it's not degenerate
        v
    }

    #[test]
    fn chunks_table_recreated_on_dim_change() {
        // A DB built for a 1536-d model should have its vector store dropped and
        // recreated at the current dim (TIN-1692), so no stale-width rows remain.
        register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL,
               chunk_idx INTEGER NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL,
               embedding F32_BLOB(1536), UNIQUE(file_path, chunk_idx))",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO meta(key, value) VALUES ('embedding_dim', '1536')", []).unwrap();
        conn.execute(
            "INSERT INTO chunks(file_path, chunk_idx, content, sha256, embedding)
             VALUES ('a.md', 0, 'x', 'sha', ?1)",
            params![embedding_to_blob(&vec![0.1_f32; 1536])],
        )
        .unwrap();

        ensure_chunks_table(&conn).unwrap();

        let n: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "stale 1536-d rows dropped when the dim changes");
        // New inserts at the current dim work, and the meta dim is updated.
        insert_chunk(&conn, "b.md", 0, "y", "sha2", &vec![0.2_f32; EMBEDDING_DIM]).unwrap();
        let stored: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'embedding_dim'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, EMBEDDING_DIM.to_string());
    }

    #[test]
    fn sqlite_vec_loads_and_reports_version() {
        // Proves the extension actually registered against the bundled SQLite
        // build — if the static link failed this row query would error.
        let conn = mem_db();
        let version: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .expect("vec_version() should exist once sqlite-vec is loaded");
        assert!(version.starts_with('v'), "got vec_version = {version:?}");
    }

    #[test]
    fn cosine_nn_orders_by_similarity() {
        let conn = mem_db();
        // Chunk 1 sits on axis 0, chunk 2 on axis 500 (orthogonal-ish).
        insert_chunk(&conn, "a.md", 0, "near", "sha-a", &axis_vec(0)).unwrap();
        insert_chunk(&conn, "b.md", 0, "far", "sha-b", &axis_vec(200)).unwrap();

        // Query points along axis 0, so chunk 1 must come first.
        let query = axis_vec(0);
        let hits = nearest_chunks(&conn, &query, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].file_path, "a.md", "closest chunk first");
        assert_eq!(hits[1].file_path, "b.md");
        assert!(
            hits[0].distance < hits[1].distance,
            "cosine distance must increase with the result order: {hits:?}"
        );
        // Identical-direction vector → ~0 cosine distance.
        assert!(hits[0].distance < 1e-3, "near chunk should be ~0 distance");
    }

    #[test]
    fn cosine_nn_respects_limit() {
        let conn = mem_db();
        for i in 0..5 {
            insert_chunk(&conn, "f.md", i, "c", "sha", &axis_vec(i as usize)).unwrap();
        }
        let hits = nearest_chunks(&conn, &axis_vec(0), 3).unwrap();
        assert_eq!(hits.len(), 3, "limit caps the result count");
    }

    #[test]
    fn fts_and_vec_coexist_on_one_connection() {
        // The headline risk: FTS5 + sqlite-vec on the same bundled SQLite. Build
        // the FTS index and run a vector query on the same connection.
        let root = temp_root("coexist");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nrusqlite migration note");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();
        assert_eq!(run_search(&conn, &input("rusqlite")).unwrap().len(), 1);

        insert_chunk(&conn, "studio/a.md", 0, "rusqlite migration note", "sha", &axis_vec(0)).unwrap();
        let hits = nearest_chunks(&conn, &axis_vec(0), 5).unwrap();
        assert_eq!(hits.len(), 1);
        // And FTS still works after the vector ops.
        assert_eq!(run_search(&conn, &input("rusqlite")).unwrap().len(), 1);
    }

    // ── hybrid candidate assembly (TIN-1632) ───────────────────────────────────
    // These exercise the SQL-bearing arms of the pipeline (the `rank` column,
    // the vector merge, the metadata fetch for semantic-only hits). The pure
    // ranking math lives in hybrid.rs's own tests.

    #[test]
    fn fts_candidates_carry_rank_and_terms() {
        let root = temp_root("fts-cand");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nThe rusqlite migration is load-bearing.");
        write(&root, "studio/b.md", "---\nname: beta\ntype: project\nprojects: studio\n---\nUnrelated note.");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let cands = fts_candidates(&conn, &input("rusqlite")).unwrap();
        assert_eq!(cands.len(), 1, "only the file mentioning rusqlite is an FTS hit");
        assert!(cands[0].bm25_rank.is_some(), "candidate carries a BM25 rank");
        assert!(!cands[0].terms.is_empty(), "tokens populated for the MMR fallback");
        assert_eq!(cands[0].result.name, "alpha");
    }

    #[test]
    fn build_rank_inputs_is_bm25_only_without_query_vector() {
        let root = temp_root("rank-bm25");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nrusqlite note");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let fts = fts_candidates(&conn, &input("rusqlite")).unwrap();
        let out = build_rank_inputs(&conn, &input("rusqlite"), fts, None).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].vec_dist.is_none(), "no vector arm without a query vector");
        assert!(out[0].embedding.is_none(), "no embedding rehydration in BM25-only mode");
    }

    #[test]
    fn build_rank_inputs_adds_semantic_only_candidate() {
        // Cascade: a file that is NOT a BM25 hit but IS a vector neighbour must
        // be pulled into the candidate set with its distance + embedding.
        let root = temp_root("rank-vec");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nrusqlite migration");
        write(&root, "studio/b.md", "---\nname: beta\ntype: feedback\nprojects: studio\n---\nprose about gardening");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        // Embed B along axis 0 and query along axis 0 → B is the vector hit,
        // even though it shares no terms with the FTS query "rusqlite".
        let b_path = root.join("studio/b.md").to_string_lossy().to_string();
        insert_chunk(&conn, &b_path, 0, "prose about gardening", "sha-b", &axis_vec(0)).unwrap();

        let fts = fts_candidates(&conn, &input("rusqlite")).unwrap();
        assert_eq!(fts.len(), 1, "only A is an FTS hit");

        let out = build_rank_inputs(&conn, &input("rusqlite"), fts, Some(&axis_vec(0))).unwrap();
        let names: Vec<&str> = out.iter().map(|c| c.result.name.as_str()).collect();
        assert!(names.contains(&"alpha"), "FTS hit retained");
        assert!(names.contains(&"beta"), "semantic-only hit added");

        let b = out.iter().find(|c| c.result.name == "beta").unwrap();
        assert!(b.vec_dist.is_some(), "vector distance attached to the semantic hit");
        assert!(b.bm25_rank.is_none(), "B was not a BM25 hit");
        assert!(b.embedding.is_some(), "representative embedding rehydrated for MMR");
    }

    // ── superseded de-ranking (TIN-1732) ──────────────────────────────────────

    #[test]
    fn derank_superseded_moves_superseded_after_active() {
        // An active note and a superseded note in any order — after de-ranking,
        // the active note must always come first. Superseded notes are never
        // removed (findable, just ranked lower).
        let make = |name: &str, status: &str| SearchResult {
            path: format!("/m/{name}.md"),
            name: name.to_string(),
            type_: "project".to_string(),
            projects: vec![],
            created: "2026-01-01".to_string(),
            updated: "2026-01-01".to_string(),
            tags: vec![],
            status: status.to_string(),
            excerpt: String::new(),
        };

        // Case 1: superseded first in list, active second.
        let mut results = vec![make("old-decision", "superseded"), make("new-decision", "active")];
        derank_superseded(&mut results);
        assert_eq!(results[0].name, "new-decision", "active should come first");
        assert_eq!(results[1].name, "old-decision", "superseded remains in list (findable)");

        // Case 2: active first already — stable sort keeps it there.
        let mut results = vec![make("new-decision", "active"), make("old-decision", "superseded")];
        derank_superseded(&mut results);
        assert_eq!(results[0].name, "new-decision");
        assert_eq!(results[1].name, "old-decision");

        // Case 3: multiple active + superseded — all superseded demoted after all active.
        let mut results = vec![
            make("sup-a", "superseded"),
            make("act-b", "active"),
            make("sup-c", "superseded"),
            make("act-d", "active"),
        ];
        derank_superseded(&mut results);
        let statuses: Vec<&str> = results.iter().map(|r| r.status.as_str()).collect();
        assert_eq!(&statuses[..2], &["active", "active"], "active notes first");
        assert_eq!(&statuses[2..], &["superseded", "superseded"], "superseded notes last");
    }

    #[test]
    fn derank_superseded_preserves_internal_order() {
        // Stability: two active notes A and B in relevance order must stay A, B
        // after the secondary sort (sort_by_key is stable in Rust).
        let make = |name: &str, status: &str| SearchResult {
            path: format!("/m/{name}.md"),
            name: name.to_string(),
            type_: "project".to_string(),
            projects: vec![],
            created: "2026-01-01".to_string(),
            updated: "2026-01-01".to_string(),
            tags: vec![],
            status: status.to_string(),
            excerpt: String::new(),
        };

        let mut results =
            vec![make("best-active", "active"), make("second-active", "active"), make("sup", "superseded")];
        derank_superseded(&mut results);
        assert_eq!(results[0].name, "best-active", "internal order preserved for active notes");
        assert_eq!(results[1].name, "second-active");
        assert_eq!(results[2].name, "sup");
    }

    #[test]
    fn derank_superseded_superseded_notes_findable_via_index() {
        // End-to-end: index a superseded and an active note, run a query that
        // matches both. The superseded note must appear in results (not filtered)
        // but after the active one.
        let root = temp_root("derank-e2e");
        write(
            &root,
            "studio/old.md",
            "---\nname: old-decision\ntype: project\nprojects: studio\nstatus: superseded\n---\nThe pricing for Attic Pro.",
        );
        write(
            &root,
            "studio/new.md",
            "---\nname: new-decision\ntype: project\nprojects: studio\nstatus: active\n---\nThe updated pricing for Attic Pro.",
        );
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let mut results = run_search(&conn, &input("pricing")).unwrap();
        derank_superseded(&mut results);
        assert_eq!(results.len(), 2, "both notes are findable (superseded not filtered)");
        assert_eq!(results[0].name, "new-decision", "active note ranks first");
        assert_eq!(results[1].name, "old-decision", "superseded note still findable, ranked second");
    }

    #[test]
    fn build_rank_inputs_respects_filters_on_semantic_hits() {
        // A vector neighbour that fails the type filter must NOT be added.
        let root = temp_root("rank-vec-filter");
        write(&root, "studio/a.md", "---\nname: alpha\ntype: feedback\nprojects: studio\n---\nrusqlite migration");
        write(&root, "studio/b.md", "---\nname: beta\ntype: project\nprojects: studio\n---\nprose about gardening");
        let conn = mem_db();
        build_index(&root, &conn).unwrap();

        let b_path = root.join("studio/b.md").to_string_lossy().to_string();
        insert_chunk(&conn, &b_path, 0, "prose about gardening", "sha-b", &axis_vec(0)).unwrap();

        let mut q = input("rusqlite");
        q.type_filter = "feedback".to_string();
        let fts = fts_candidates(&conn, &q).unwrap();
        let out = build_rank_inputs(&conn, &q, fts, Some(&axis_vec(0))).unwrap();
        assert!(
            out.iter().all(|c| c.result.name != "beta"),
            "a semantic hit of the wrong type is filtered out"
        );
    }
}
