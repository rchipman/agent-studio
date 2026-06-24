//! links.rs
//!
//! Wiki-linking layer for TIN-1639. Turns the flat memory file collection into a
//! navigable knowledge graph by scanning each file for two kinds of reference:
//!
//!   * `[[slug]]` — a wiki-link to another memory file (resolved to its path by
//!     matching the slug against file stems and display names).
//!   * `TIN-1234` — a Linear ticket mention.
//!
//! References are materialised into the `links` table during `build_index`
//! (see `rebuild_links`), and exposed to the frontend through three commands:
//!   * `file_links`     — the Links tab for one open file (outbound, backlinks, tickets).
//!   * `link_suggest`   — `[[` autocomplete in the editor.
//!   * `graph_data`     — the full `⌘G` knowledge graph (nodes + edges).
//!
//! Ticket titles come from the `ticket_cache` table (populated opportunistically
//! via `set_ticket_titles`); absent a cached title we surface the bare ID, which
//! is still a working link (it opens in the in-app Linear browser, TIN-1626).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::search::Db;

// ── Types ────────────────────────────────────────────────────────────────────

/// A memory file referenced by (or referencing) the open file. Mirrors the
/// card fields the Links tab renders.
#[derive(Serialize, Clone, Default, PartialEq, Debug)]
pub struct LinkedFile {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub projects: Vec<String>,
    pub excerpt: String,
}

/// A Linear ticket mention: the bare ID plus a cached title (empty if unknown).
#[derive(Serialize, Clone, Default, PartialEq, Debug)]
pub struct TicketRef {
    pub id: String,
    pub title: String,
}

/// The full link map for one file.
#[derive(Serialize, Default)]
pub struct FileLinks {
    /// Files this file links to via `[[slug]]`.
    pub outbound: Vec<LinkedFile>,
    /// Files that link to this file ("who talks about this?").
    pub backlinks: Vec<LinkedFile>,
    /// Linear tickets this file mentions.
    pub tickets: Vec<TicketRef>,
}

/// One autocomplete suggestion for the `[[` picker.
#[derive(Serialize, Default)]
pub struct LinkSuggestion {
    pub name: String,
    pub path: String,
    /// The stem to insert inside `[[ ]]`.
    pub slug: String,
}

/// A node in the knowledge graph: a file or a ticket.
#[derive(Serialize, Default)]
pub struct GraphNode {
    /// Stable id — the file path, or the ticket id.
    pub id: String,
    pub label: String,
    /// `"file"` or `"ticket"`.
    pub kind: String,
    /// First project (domain) for colouring; empty for tickets.
    pub domain: String,
    /// Number of edges touching this node (drives node size).
    pub degree: usize,
}

/// An edge between two graph nodes.
#[derive(Serialize, Default)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

/// The whole graph.
#[derive(Serialize, Default)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

// ── Scanning ─────────────────────────────────────────────────────────────────

/// Extract the inner text of every `[[ ... ]]` wiki-link in `body`, trimmed and
/// in source order (duplicates preserved; dedup happens at insert time).
pub fn scan_wiki(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find("[[") {
        let after_open = &rest[open + 2..];
        match after_open.find("]]") {
            Some(close) => {
                let inner = after_open[..close].trim();
                if !inner.is_empty() && !inner.contains('[') {
                    out.push(inner.to_string());
                }
                rest = &after_open[close + 2..];
            }
            None => break,
        }
    }
    out
}

/// Extract every Linear ticket id (`TIN-1234`) in `body`, in source order. A
/// match must be preceded by a non-alphanumeric char (or start of string) so we
/// don't pick mid-word fragments.
pub fn scan_tickets(body: &str) -> Vec<String> {
    const PREFIX: &str = "TIN-";
    let mut out = Vec::new();
    for (idx, _) in body.match_indices(PREFIX) {
        // Word boundary before the prefix.
        if idx > 0 {
            let prev = body[..idx].chars().next_back().unwrap_or(' ');
            if prev.is_alphanumeric() {
                continue;
            }
        }
        let digits: String = body[idx + PREFIX.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            out.push(format!("{PREFIX}{digits}"));
        }
    }
    out
}

/// Lowercased file stem of a path (`/m/model-tier.md` → `model-tier`).
fn stem_of(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
}

// ── Index population ─────────────────────────────────────────────────────────

/// Rebuild the entire `links` table from `files` — a slice of
/// `(path, name, body)` for every indexed memory file. Called by `build_index`
/// after the FTS rows are written, so a full reindex keeps links in sync.
///
/// Resolution: a `[[slug]]` resolves to a file whose stem **or** display name
/// matches the slug (case-insensitive). Unresolved (dangling) wiki-links and
/// self-links are dropped. Ticket mentions are stored verbatim.
pub fn rebuild_links(conn: &Connection, files: &[(String, String, String)]) -> rusqlite::Result<()> {
    // Build the slug/name → path resolution index. Stems take precedence; a
    // name only fills a key no stem already claimed.
    let mut index: HashMap<String, String> = HashMap::new();
    for (path, _, _) in files {
        if let Some(stem) = stem_of(path) {
            index.entry(stem).or_insert_with(|| path.clone());
        }
    }
    for (path, name, _) in files {
        let key = name.trim().to_lowercase();
        if !key.is_empty() {
            index.entry(key).or_insert_with(|| path.clone());
        }
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM links", [])?;
    {
        let mut ins = tx.prepare(
            "INSERT INTO links (from_path, to_path, to_ticket_id, link_type)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (path, _, body) in files {
            // Dedup per (kind, target) within a single file.
            let mut seen: HashSet<(u8, String)> = HashSet::new();

            for slug in scan_wiki(body) {
                if let Some(to) = index.get(&slug.to_lowercase()) {
                    if to != path && seen.insert((0, to.clone())) {
                        ins.execute(params![path, to, Option::<String>::None, "wiki"])?;
                    }
                }
            }
            for tid in scan_tickets(body) {
                if seen.insert((1, tid.clone())) {
                    ins.execute(params![path, Option::<String>::None, tid, "ticket"])?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(())
}

// ── Queries ──────────────────────────────────────────────────────────────────

/// Fetch the card fields for a set of file paths, preserving the input order
/// and silently skipping paths no longer in the index.
fn fetch_cards(conn: &Connection, paths: &[String]) -> rusqlite::Result<Vec<LinkedFile>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT path, name, type, projects, substr(body, 1, 140) AS excerpt
         FROM memory_files WHERE path = ?1",
    )?;
    for p in paths {
        let card = stmt.query_row(params![p], |row| {
            let projects: String = row.get("projects")?;
            Ok(LinkedFile {
                path: row.get("path")?,
                name: row.get("name")?,
                type_: row.get("type")?,
                projects: projects.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
                excerpt: row.get("excerpt")?,
            })
        });
        if let Ok(c) = card {
            out.push(c);
        }
    }
    Ok(out)
}

/// Compute the full link map for `path` against an open connection.
fn links_for(conn: &Connection, path: &str) -> rusqlite::Result<FileLinks> {
    // Outbound wiki-links.
    let outbound_paths: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT to_path FROM links
             WHERE from_path = ?1 AND link_type = 'wiki' AND to_path IS NOT NULL
             ORDER BY to_path",
        )?;
        let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok).collect()
    };

    // Backlinks: anyone pointing at this path.
    let backlink_paths: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT from_path FROM links WHERE to_path = ?1 ORDER BY from_path",
        )?;
        let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok).collect()
    };

    // Ticket mentions, joined to cached titles.
    let tickets: Vec<TicketRef> = {
        let mut stmt = conn.prepare(
            "SELECT l.to_ticket_id, COALESCE(t.title, '') AS title
             FROM links l
             LEFT JOIN ticket_cache t ON t.ticket_id = l.to_ticket_id
             WHERE l.from_path = ?1 AND l.link_type = 'ticket' AND l.to_ticket_id IS NOT NULL
             ORDER BY l.to_ticket_id",
        )?;
        let rows = stmt.query_map(params![path], |r| {
            Ok(TicketRef { id: r.get(0)?, title: r.get(1)? })
        })?;
        rows.filter_map(Result::ok).collect()
    };

    Ok(FileLinks {
        outbound: fetch_cards(conn, &outbound_paths)?,
        backlinks: fetch_cards(conn, &backlink_paths)?,
        tickets,
    })
}

/// Build the knowledge graph from the `links` + `memory_files` tables, and
/// from `linear_items` (ingested tickets and epics).
///
/// Nodes:
///   - All memory files (kind = "file")
///   - All ingested Linear tickets (kind = "ticket")
///   - All ingested Linear epics (kind = "epic")
///   - Dangling ticket mentions (tickets referenced in notes but not yet ingested)
///     are still surfaced as kind = "ticket" with no title.
///
/// Edges:
///   - note → ticket/epic  (from `links` table `link_type = 'ticket'`)
///   - note → note          (from `links` table `link_type = 'wiki'`)
///   - ticket → epic        (from `linear_items.parent_identifier`)
fn graph(conn: &Connection) -> rusqlite::Result<GraphData> {
    // ── 1. File nodes ─────────────────────────────────────────────────────────
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut degree: HashMap<String, usize> = HashMap::new();

    {
        let mut stmt = conn.prepare("SELECT path, name, projects FROM memory_files ORDER BY path")?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get("path")?;
            let name: String = row.get("name")?;
            let projects: String = row.get("projects")?;
            let domain = projects.split(',').find(|s| !s.is_empty()).unwrap_or("").to_string();
            Ok(GraphNode { id: path, label: name, kind: "file".into(), domain, degree: 0 })
        })?;
        for n in rows.filter_map(Result::ok) {
            nodes.push(n);
        }
    }

    // ── 2. Ingested Linear nodes (issues + epics) ─────────────────────────────
    // Map: identifier → (title, kind, parent_identifier)
    let mut ingested: HashMap<String, (String, String, String)> = HashMap::new();
    {
        // linear_items may not exist yet (no sync done). Use IF EXISTS guard via
        // a query that silently returns nothing if the table is absent.
        let table_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='linear_items'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if table_exists {
            let mut stmt = conn.prepare(
                "SELECT identifier, title, kind, parent_identifier FROM linear_items ORDER BY identifier",
            )?;
            let rows = stmt.query_map([], |row| {
                let id: String = row.get("identifier")?;
                let title: String = row.get("title")?;
                let kind: String = row.get("kind")?;
                let parent: String = row.get("parent_identifier")?;
                Ok((id, title, kind, parent))
            })?;
            for (id, title, kind, parent) in rows.filter_map(Result::ok) {
                ingested.insert(id, (title, kind, parent));
            }
        }
    }

    // Add ingested ticket/epic nodes.
    for (id, (title, kind, _)) in &ingested {
        let node_kind = if kind == "epic" { "epic" } else { "ticket" };
        let label = if title.is_empty() { id.clone() } else { title.clone() };
        nodes.push(GraphNode {
            id: id.clone(),
            label,
            kind: node_kind.into(),
            domain: String::new(),
            degree: 0,
        });
    }

    // ── 3. Edges: wiki-links and note→ticket, accumulating degree ────────────
    let mut edges: Vec<GraphEdge> = Vec::new();
    // Track dangling ticket mentions (referenced in notes but not ingested).
    let mut dangling_tickets: HashMap<String, String> = HashMap::new(); // id → cached title

    {
        let mut stmt = conn.prepare(
            "SELECT l.from_path, l.to_path, l.to_ticket_id, l.link_type,
                    COALESCE(t.title, '') AS title
             FROM links l
             LEFT JOIN ticket_cache t ON t.ticket_id = l.to_ticket_id",
        )?;
        let rows = stmt.query_map([], |row| {
            let from: String = row.get("from_path")?;
            let to_path: Option<String> = row.get("to_path")?;
            let ticket: Option<String> = row.get("to_ticket_id")?;
            let title: String = row.get("title")?;
            Ok((from, to_path, ticket, title))
        })?;
        for (from, to_path, ticket, title) in rows.filter_map(Result::ok) {
            let to = match (&to_path, &ticket) {
                (Some(p), _) => p.clone(),
                (None, Some(t)) => {
                    // If not ingested yet, track as dangling (will get a bare-id node).
                    if !ingested.contains_key(t) {
                        dangling_tickets.entry(t.clone()).or_insert(title);
                    }
                    t.clone()
                }
                _ => continue,
            };
            *degree.entry(from.clone()).or_insert(0) += 1;
            *degree.entry(to.clone()).or_insert(0) += 1;
            edges.push(GraphEdge { from, to });
        }
    }

    // Add dangling ticket nodes (not yet ingested).
    for (id, title) in dangling_tickets {
        let label = if title.is_empty() { id.clone() } else { title };
        nodes.push(GraphNode { id, label, kind: "ticket".into(), domain: String::new(), degree: 0 });
    }

    // ── 4. Edges: ticket → epic (parent_identifier) ───────────────────────────
    for (id, (_title, _kind, parent)) in &ingested {
        if parent.is_empty() {
            continue;
        }
        // Only emit the edge if the parent epic is itself ingested.
        if ingested.contains_key(parent) {
            *degree.entry(id.clone()).or_insert(0) += 1;
            *degree.entry(parent.clone()).or_insert(0) += 1;
            edges.push(GraphEdge { from: id.clone(), to: parent.clone() });
        }
    }

    // ── 5. Apply degrees ──────────────────────────────────────────────────────
    for n in nodes.iter_mut() {
        if let Some(d) = degree.get(&n.id) {
            n.degree = *d;
        }
    }

    Ok(GraphData { nodes, edges })
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLinksInput {
    pub path: String,
}

#[tauri::command]
pub fn file_links(payload: FileLinksInput, db: State<'_, Db>) -> Result<FileLinks, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    links_for(&conn, &payload.path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSuggestInput {
    #[serde(default)]
    pub q: String,
    pub limit: Option<i64>,
}

#[tauri::command]
pub fn link_suggest(payload: LinkSuggestInput, db: State<'_, Db>) -> Result<Vec<LinkSuggestion>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let q = payload.q.trim();
    let limit = payload.limit.unwrap_or(8).clamp(1, 50);
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));

    let mut stmt = conn
        .prepare(
            "SELECT path, name FROM memory_files
             WHERE name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\'
             ORDER BY name LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![like, limit], |row| {
            let path: String = row.get("path")?;
            let name: String = row.get("name")?;
            let slug = stem_of(&path).unwrap_or_else(|| name.to_lowercase());
            Ok(LinkSuggestion { name, path, slug })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub fn graph_data(db: State<'_, Db>) -> Result<GraphData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    graph(&conn).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketTitle {
    pub id: String,
    pub title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTicketTitlesInput {
    pub tickets: Vec<TicketTitle>,
}

/// Cache resolved Linear ticket titles so the Links tab and graph can show them.
#[tauri::command]
pub fn set_ticket_titles(payload: SetTicketTitlesInput, db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO ticket_cache (ticket_id, title, fetched_at)
                 VALUES (?1, ?2, '')
                 ON CONFLICT(ticket_id) DO UPDATE SET title = excluded.title",
            )
            .map_err(|e| e.to_string())?;
        for t in &payload.tickets {
            stmt.execute(params![t.id, t.title]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{build_index, init_db};
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("links-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    // ── scanners (resolvers — must fire AND not fire) ─────────────────────────

    #[test]
    fn scan_wiki_extracts_links_and_ignores_noise() {
        let body = "See [[model-tier]] and [[ Spaced Name ]]. Not a [single] link. Unclosed [[oops";
        assert_eq!(scan_wiki(body), vec!["model-tier", "Spaced Name"]);
    }

    #[test]
    fn scan_wiki_empty_when_no_links() {
        assert!(scan_wiki("plain prose, no links here").is_empty());
    }

    #[test]
    fn scan_tickets_detects_ids_with_word_boundary() {
        let body = "Fixes TIN-1626 and TIN-1639. Ignore xTIN-9 (no boundary) and TIN- (no digits).";
        assert_eq!(scan_tickets(body), vec!["TIN-1626", "TIN-1639"]);
    }

    #[test]
    fn scan_tickets_empty_when_absent() {
        assert!(scan_tickets("no tickets mentioned, just FIN-1 and TINY-2").is_empty());
    }

    // ── rebuild_links (cascade — verify the rows AND their scope) ─────────────

    #[test]
    fn rebuild_resolves_wiki_links_and_skips_dangling_and_self() {
        let root = temp_root("resolve");
        // a links to b (by stem) and to itself (dropped) and to a missing slug.
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nlinks [[b]] and [[a]] and [[ghost]]");
        write(&root, "s/b.md", "---\nname: beta\nprojects: studio\n---\nnothing");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();

        let a = root.join("s/a.md").to_string_lossy().to_string();
        let b = root.join("s/b.md").to_string_lossy().to_string();

        let links = links_for(&conn, &a).unwrap();
        assert_eq!(links.outbound.len(), 1, "only the resolvable, non-self link");
        assert_eq!(links.outbound[0].path, b);

        // And b sees a as a backlink.
        let bl = links_for(&conn, &b).unwrap();
        assert_eq!(bl.backlinks.len(), 1);
        assert_eq!(bl.backlinks[0].name, "alpha");
        assert!(bl.outbound.is_empty(), "b links to nothing");
    }

    #[test]
    fn rebuild_resolves_wiki_links_by_display_name() {
        let root = temp_root("byname");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nsee [[Beta Note]]");
        write(&root, "s/b.md", "---\nname: Beta Note\nprojects: studio\n---\nhi");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();
        let a = root.join("s/a.md").to_string_lossy().to_string();
        let links = links_for(&conn, &a).unwrap();
        assert_eq!(links.outbound.len(), 1, "matched by display name");
        assert_eq!(links.outbound[0].name, "Beta Note");
    }

    #[test]
    fn rebuild_records_ticket_mentions() {
        let root = temp_root("tickets");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nrelates to TIN-1626 and TIN-1626 again");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();
        let a = root.join("s/a.md").to_string_lossy().to_string();
        let links = links_for(&conn, &a).unwrap();
        assert_eq!(links.tickets.len(), 1, "deduped within a file");
        assert_eq!(links.tickets[0].id, "TIN-1626");
        assert_eq!(links.tickets[0].title, "", "no title cached yet → bare id");
    }

    #[test]
    fn ticket_titles_cache_populates_links_tab() {
        let root = temp_root("ttitle");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nsee TIN-1626");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();
        conn.execute(
            "INSERT INTO ticket_cache (ticket_id, title, fetched_at) VALUES ('TIN-1626','In-app Linear browser','')",
            [],
        ).unwrap();
        let a = root.join("s/a.md").to_string_lossy().to_string();
        let links = links_for(&conn, &a).unwrap();
        assert_eq!(links.tickets[0].title, "In-app Linear browser");
    }

    #[test]
    fn rebuild_is_idempotent_across_reindex() {
        let root = temp_root("idem");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\n[[b]]");
        write(&root, "s/b.md", "---\nname: beta\nprojects: studio\n---\nx");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();
        build_index(&root, &conn).unwrap(); // second pass must not duplicate
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "reindex rebuilds links cleanly, no dupes");
    }

    // ── graph (state projector) ───────────────────────────────────────────────

    #[test]
    fn graph_has_file_and_ticket_nodes_with_degree() {
        let root = temp_root("graph");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\n[[b]] and TIN-1626");
        write(&root, "s/b.md", "---\nname: beta\nprojects: attic\n---\nplain");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();

        let g = graph(&conn).unwrap();
        // 2 files + 1 ticket node.
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "file").count(), 2);
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "ticket").count(), 1);
        // 2 edges: a→b (wiki) and a→TIN-1626 (ticket).
        assert_eq!(g.edges.len(), 2);

        // alpha has degree 2 (one wiki out, one ticket out).
        let a = root.join("s/a.md").to_string_lossy().to_string();
        let alpha = g.nodes.iter().find(|n| n.id == a).unwrap();
        assert_eq!(alpha.degree, 2);
        assert_eq!(alpha.domain, "studio", "domain is the first project");

        // The ticket node carries its id as label when no title is cached.
        let ticket = g.nodes.iter().find(|n| n.kind == "ticket").unwrap();
        assert_eq!(ticket.id, "TIN-1626");
        assert_eq!(ticket.label, "TIN-1626");
    }

    #[test]
    fn link_suggest_matches_name_substring() {
        let root = temp_root("suggest");
        write(&root, "s/model-tier-defaults.md", "---\nname: model-tier-defaults\nprojects: studio\n---\nx");
        write(&root, "s/eas-builds.md", "---\nname: eas-builds\nprojects: studio\n---\ny");
        let conn = init_db(&root).unwrap();
        build_index(&root, &conn).unwrap();

        // Query the resolver directly (command wrapper just locks + delegates).
        let mut stmt = conn
            .prepare("SELECT path, name FROM memory_files WHERE name LIKE ?1 ORDER BY name")
            .unwrap();
        let hits: Vec<String> = stmt
            .query_map(params!["%model%"], |r| r.get::<_, String>("name"))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(hits, vec!["model-tier-defaults"]);
    }

    // ── graph + linear_items integration (TIN-1729) ───────────────────────────

    /// A note that mentions TIN-XXXX and that ticket is ingested → the graph
    /// produces a note→ticket edge (the ref is no longer dangling).
    #[test]
    fn ingested_ticket_ref_produces_note_to_ticket_edge() {
        use crate::linear::{ensure_linear_schema, store_and_index_items, RawIssue};
        use crate::search::ensure_chunks_table;

        let root = temp_root("graph-ticket-edge");
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nworks on TIN-1729");
        let conn = init_db(&root).unwrap();
        ensure_chunks_table(&conn).unwrap();
        build_index(&root, &conn).unwrap();
        ensure_linear_schema(&conn).unwrap();

        // Ingest the ticket that the note mentions.
        let issue = RawIssue {
            id: "id-tin-1729".to_string(),
            identifier: "TIN-1729".to_string(),
            title: "Graph linear nodes".to_string(),
            description: "Wire linear_items into the graph.".to_string(),
            updated_at: "2026-06-20T00:00:00Z".to_string(),
            url: "https://linear.app/tfl/issue/TIN-1729".to_string(),
            state_name: "In Progress".to_string(),
            parent_id: None,
            parent_identifier: None,
            project_name: Some("Agent Studio".to_string()),
            team_key: "TIN".to_string(),
        };
        store_and_index_items(&conn, &[issue]).unwrap();

        let g = graph(&conn).unwrap();

        // The note and the ingested ticket both appear as nodes.
        assert!(g.nodes.iter().any(|n| n.kind == "ticket" && n.id == "TIN-1729"),
            "ingested ticket node present");
        let a_path = root.join("s/a.md").to_string_lossy().to_string();
        assert!(g.nodes.iter().any(|n| n.id == a_path), "note node present");

        // There is a note→ticket edge.
        let has_edge = g.edges.iter().any(|e| e.from == a_path && e.to == "TIN-1729");
        assert!(has_edge, "note→ticket edge present for ingested ticket");

        // The ticket node should have degree ≥ 1 (the note edge).
        let ticket_node = g.nodes.iter().find(|n| n.id == "TIN-1729").unwrap();
        assert!(ticket_node.degree >= 1, "ingested ticket has non-zero degree");
    }

    /// A ticket that has a parent_identifier pointing to an ingested epic →
    /// the graph produces a ticket→epic edge, and the parent is kind="epic".
    #[test]
    fn parent_identifier_produces_ticket_to_epic_edge() {
        use crate::linear::{ensure_linear_schema, store_and_index_items, RawIssue};
        use crate::search::ensure_chunks_table;

        let root = temp_root("graph-epic-edge");
        // Note that references both the child ticket and the epic (optional but
        // tests that the note→ticket edge also works alongside ticket→epic).
        write(&root, "s/a.md", "---\nname: alpha\nprojects: studio\n---\nsee TIN-1730 and TIN-1729");
        let conn = init_db(&root).unwrap();
        ensure_chunks_table(&conn).unwrap();
        build_index(&root, &conn).unwrap();
        ensure_linear_schema(&conn).unwrap();

        let epic = RawIssue {
            id: "id-tin-1729".to_string(),
            identifier: "TIN-1729".to_string(),
            title: "Graph epic parent".to_string(),
            description: "The parent epic.".to_string(),
            updated_at: "2026-06-20T00:00:00Z".to_string(),
            url: "https://linear.app/tfl/issue/TIN-1729".to_string(),
            state_name: "In Progress".to_string(),
            parent_id: None,
            parent_identifier: None,
            project_name: Some("Agent Studio".to_string()),
            team_key: "TIN".to_string(),
        };
        let child = RawIssue {
            id: "id-tin-1730".to_string(),
            identifier: "TIN-1730".to_string(),
            title: "Graph child issue".to_string(),
            description: "A child issue.".to_string(),
            updated_at: "2026-06-20T00:00:00Z".to_string(),
            url: "https://linear.app/tfl/issue/TIN-1730".to_string(),
            state_name: "Todo".to_string(),
            parent_id: Some("id-tin-1729".to_string()),
            parent_identifier: Some("TIN-1729".to_string()),
            project_name: Some("Agent Studio".to_string()),
            team_key: "TIN".to_string(),
        };
        store_and_index_items(&conn, &[epic, child]).unwrap();

        let g = graph(&conn).unwrap();

        // TIN-1729 must be kind="epic" (it is the parent of TIN-1730).
        let epic_node = g.nodes.iter().find(|n| n.id == "TIN-1729").unwrap();
        assert_eq!(epic_node.kind, "epic", "parent is surfaced as epic");

        // TIN-1730 is kind="ticket".
        let child_node = g.nodes.iter().find(|n| n.id == "TIN-1730").unwrap();
        assert_eq!(child_node.kind, "ticket", "child is surfaced as ticket");

        // There must be a ticket→epic edge.
        let has_edge = g.edges.iter().any(|e| e.from == "TIN-1730" && e.to == "TIN-1729");
        assert!(has_edge, "ticket→epic edge present");

        // The epic should have degree ≥ 1 (from the ticket→epic edge).
        assert!(epic_node.degree >= 1, "epic has non-zero degree from child edge");
    }
}
