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
use std::sync::Mutex;

use chrono::Local;
use gray_matter::engine::YAML;
use gray_matter::{Matter, ParsedEntity, Pod};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

// ── Types ───────────────────────────────────────────────────────────────────

/// A single search result. Field names match `MemorySearchResult` in
/// `lib/types.ts` (note `type` is a reserved word in Rust, hence the rename).
#[derive(Serialize, Clone)]
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

/// The memory root: `~/Projects/tfl/memory`.
pub fn memory_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join("Projects/tfl/memory")
}

// ── Schema / connection ─────────────────────────────────────────────────────

const SCHEMA: &str = "
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
";

/// Open (creating if needed) the index DB in `root` and ensure the schema.
pub fn init_db(root: &Path) -> rusqlite::Result<Connection> {
    // Make sure the root exists so Connection::open can create the db file.
    let _ = fs::create_dir_all(root);
    let db_path = root.join(".studio-index.db");
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
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
            }
        }
    }
    tx.commit()?;

    Ok(files.len())
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
pub fn search(payload: SearchInput, db: State<'_, Db>) -> Result<SearchResponse, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if payload.rebuild {
        build_index(&memory_root(), &conn).map_err(|e| e.to_string())?;
    }
    let results = run_search(&conn, &payload).map_err(|e| e.to_string())?;
    let types = distinct_types(&conn).map_err(|e| e.to_string())?;
    let projects = distinct_projects(&conn).map_err(|e| e.to_string())?;
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
pub fn create_file(payload: CreateFileInput, db: State<'_, Db>) -> Result<String, String> {
    let root = memory_root();
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

    /// In-memory connection with the production schema applied.
    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
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
}
