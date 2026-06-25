//! launcher.rs
//!
//! Filesystem support for the Prompt launcher (TIN-1633, the north star). Three
//! read-only commands let the frontend browse the composition surfaces:
//!
//!   - `list_prompts(dir)`  — prompt files in the prompts root, each with the
//!                            `description` pulled from its frontmatter.
//!   - `read_prompt(path)`  — the full text of a single prompt or skill file
//!                            (used both for the serif preview and for composing
//!                            the launch bundle).
//!   - `list_skills(dir)`   — skill files in the skills root, each with a short
//!                            description (frontmatter `description`, falling back
//!                            to the first prose line).
//!
//! Skills in `~/.claude/skills` are commonly directories holding a `SKILL.md`;
//! plain `.md` files are supported too. Prompts are flat `.md` files.

use std::fs;
use std::path::{Path, PathBuf};

use std::collections::HashMap;

use gray_matter::engine::YAML;
use gray_matter::{Matter, ParsedEntity, Pod};
use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

/// A prompt file listed for the Prompts column. `path` is absolute; `name` is the
/// human title (frontmatter `name`, else the filename stem); `description` is a
/// one-line summary from frontmatter (may be empty).
#[derive(Serialize, Clone)]
pub struct PromptEntry {
    pub path: String,
    pub name: String,
    pub description: String,
}

/// A skill file listed for the Persona / skills picker. Same shape as a prompt;
/// `path` points at the readable markdown (the `SKILL.md` inside a skill dir, or
/// the `.md` file itself).
#[derive(Serialize, Clone)]
pub struct SkillEntry {
    pub path: String,
    pub name: String,
    pub description: String,
}

// ── Frontmatter helpers ──────────────────────────────────────────────────────

fn pod_string(map: &HashMap<String, Pod>, key: &str) -> Option<String> {
    map.get(key).and_then(|p| p.as_string().ok()).and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// Parse a markdown file's frontmatter, returning (name, description). `name`
/// falls back to the provided default (the filename stem). `description` falls
/// back to the first non-empty, non-heading prose line of the body.
fn parse_meta(raw: &str, default_name: &str) -> (String, String) {
    let matter = Matter::<YAML>::new();
    let parsed: ParsedEntity = match matter.parse(raw) {
        Ok(p) => p,
        Err(_) => return (default_name.to_string(), first_prose_line(raw)),
    };
    let map = parsed
        .data
        .as_ref()
        .and_then(|d| d.as_hashmap().ok())
        .unwrap_or_default();

    let name = pod_string(&map, "name").unwrap_or_else(|| default_name.to_string());
    let description =
        pod_string(&map, "description").unwrap_or_else(|| first_prose_line(&parsed.content));
    (name, description)
}

/// First non-empty, non-heading line of the body, truncated for a one-line
/// description. Empty string when nothing usable is found.
fn first_prose_line(body: &str) -> String {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("---") {
            continue;
        }
        const MAX: usize = 140;
        if t.chars().count() > MAX {
            let truncated: String = t.chars().take(MAX).collect();
            return format!("{}…", truncated.trim_end());
        }
        return t.to_string();
    }
    String::new()
}

fn filename_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Input for `list_prompts` / `list_skills`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub dir: String,
}

/// Input for `read_prompt`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadInput {
    pub path: String,
}

/// Input for `write_prompt` (TIN-1764, in-app prompt authoring).
///
/// `dir` is the prompts root. `slug` is the kebab filename stem (no extension);
/// the backend writes `{dir}/{slug}.md`. `body` is the prompt prose (no
/// frontmatter). `name` / `description` become frontmatter. When `overwrite` is
/// false and `{dir}/{slug}.md` already exists, the write fails (the frontend
/// suffixes the slug and retries) so a NEW prompt never clobbers an existing one.
/// When `overwrite` is true (EDIT in place) the file is rewritten, preserving any
/// frontmatter keys other than `name`/`description`/`context`/`system_facts`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePromptInput {
    pub dir: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub body: String,
    #[serde(default)]
    pub overwrite: bool,
    /// Optional default-context block, written as a `context:` frontmatter list of
    /// `{ kind, ref }` maps. Empty / absent leaves no `context:` key.
    #[serde(default)]
    pub context: Vec<PromptContextRef>,
    /// Optional auto-fact ids (e.g. `["time"]`), written as `system_facts:`.
    #[serde(default, rename = "systemFacts")]
    pub system_facts: Vec<String>,
}

/// A portable default-context reference carried in a prompt's frontmatter.
#[derive(Serialize, Deserialize, Clone)]
pub struct PromptContextRef {
    /// One of `skill` | `memory` | `file`.
    pub kind: String,
    /// A root-relative (or absolute, for files) reference.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// Output of `write_prompt`: the absolute path written.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePromptResult {
    pub path: String,
}

/// List prompt files (flat `.md`) under `dir`, each with its frontmatter
/// description. Sorted by name. A missing or empty dir yields an empty list (the
/// frontend renders the "set a prompts root" / empty states), so an unset root is
/// not an error.
#[tauri::command]
pub fn list_prompts(payload: ListInput) -> Result<Vec<PromptEntry>, String> {
    let dir = PathBuf::from(payload.dir.trim());
    if payload.dir.trim().is_empty() || !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out: Vec<PromptEntry> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = filename_stem(&path);
        let raw = fs::read_to_string(&path).unwrap_or_default();
        let (name, description) = parse_meta(&raw, &stem);
        out.push(PromptEntry {
            path: path.to_string_lossy().to_string(),
            name,
            description,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// List skill files under `dir`. Each child may be a directory holding a
/// `SKILL.md` (the Claude skills convention) or a plain `.md` file. Sorted by
/// name. A missing or empty dir yields an empty list.
#[tauri::command]
pub fn list_skills(payload: ListInput) -> Result<Vec<SkillEntry>, String> {
    let dir = PathBuf::from(payload.dir.trim());
    if payload.dir.trim().is_empty() || !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out: Vec<SkillEntry> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();

        // Directory skill: look for SKILL.md (then a lowercase skill.md).
        let target: Option<PathBuf> = if path.is_dir() {
            let skill_md = path.join("SKILL.md");
            if skill_md.is_file() {
                Some(skill_md)
            } else {
                let lower = path.join("skill.md");
                if lower.is_file() {
                    Some(lower)
                } else {
                    None
                }
            }
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            Some(path.clone())
        } else {
            None
        };

        let Some(target) = target else { continue };

        // Name the skill after its directory when it's a dir-skill, else the file.
        let default_name = if path.is_dir() {
            path.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            filename_stem(&target)
        };

        let raw = fs::read_to_string(&target).unwrap_or_default();
        let (name, description) = parse_meta(&raw, &default_name);
        out.push(SkillEntry {
            path: target.to_string_lossy().to_string(),
            name,
            description,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Read the full text of a prompt or skill file. Returns the raw file contents
/// (frontmatter included); the frontend strips frontmatter for the serif preview
/// and composes the body into the launch bundle.
#[tauri::command]
pub fn read_prompt(payload: ReadInput) -> Result<String, String> {
    let path = PathBuf::from(payload.path.trim());
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── Prompt authoring (TIN-1764) ────────────────────────────────────────────────

/// YAML-escape a scalar string: wrap in double quotes only when it could be
/// misparsed (contains a colon, quote, leading/trailing space, or a leading
/// indicator char). Keeps clean values bare so hand-written prompts stay readable.
fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s != s.trim()
        || s.contains(':')
        || s.contains('#')
        || s.contains('"')
        || s.contains('\n')
        || s.starts_with(['-', '?', '*', '&', '!', '%', '@', '`', '[', '{', '>', '|', '\'']);
    if needs_quote {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

/// Render the frontmatter keys this command owns (`name`, `description`,
/// `context`, `system_facts`), plus any `preserved` extra lines, into a YAML
/// block (without the `---` fences). `created` is appended only when provided.
fn build_frontmatter(
    name: &str,
    description: &str,
    created: Option<&str>,
    context: &[PromptContextRef],
    system_facts: &[String],
    preserved: &[String],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("name: {}", yaml_scalar(name)));
    if !description.is_empty() {
        lines.push(format!("description: {}", yaml_scalar(description)));
    }
    if let Some(c) = created {
        lines.push(format!("created: {}", yaml_scalar(c)));
    }
    if !context.is_empty() {
        lines.push("context:".to_string());
        for item in context {
            lines.push(format!(
                "  - kind: {}",
                yaml_scalar(&item.kind)
            ));
            lines.push(format!("    ref: {}", yaml_scalar(&item.reference)));
        }
    }
    if !system_facts.is_empty() {
        let inner = system_facts
            .iter()
            .map(|f| yaml_scalar(f))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("system_facts: [{inner}]"));
    }
    for extra in preserved {
        lines.push(extra.clone());
    }
    lines.join("\n")
}

/// Pull the verbatim frontmatter lines for keys we do NOT own, so an edit-in-place
/// rewrite preserves them. Owned (and therefore dropped) keys are `name`,
/// `description`, `created`, `context`, `system_facts`. Indented continuation
/// lines (list items, nested maps) of a dropped key are skipped with it.
fn preserved_frontmatter_lines(raw: &str) -> Vec<String> {
    const OWNED: [&str; 5] = ["name", "description", "created", "context", "system_facts"];
    let Some(block) = extract_frontmatter_block(raw) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let mut skipping = false;
    for line in block.lines() {
        let is_indented = line.starts_with(' ') || line.starts_with('\t');
        if is_indented {
            // Continuation of the previous top-level key.
            if !skipping {
                out.push(line.to_string());
            }
            continue;
        }
        if line.trim().is_empty() {
            if !skipping {
                out.push(line.to_string());
            }
            continue;
        }
        let key = line.split(':').next().unwrap_or("").trim();
        if OWNED.contains(&key) {
            skipping = true;
        } else {
            skipping = false;
            out.push(line.to_string());
        }
    }
    // Drop trailing blank lines for a clean join.
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out
}

/// Pull the `created:` value from an existing file's frontmatter, if present.
fn existing_created(raw: &str) -> Option<String> {
    let block = extract_frontmatter_block(raw)?;
    for line in block.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("created:") {
            let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Return the inner text of a leading `---`-fenced YAML block, or None.
fn extract_frontmatter_block(raw: &str) -> Option<&str> {
    if !raw.starts_with("---") {
        return None;
    }
    let after_open = raw.find('\n')? + 1;
    let rest = &raw[after_open..];
    let end_rel = rest.find("\n---").or_else(|| {
        if rest.starts_with("---") {
            Some(0)
        } else {
            None
        }
    })?;
    Some(&rest[..end_rel])
}

/// Write or rewrite a prompt `.md` in the prompts root.
///
/// NEW (overwrite=false): refuses to clobber an existing file (the frontend
/// suffixes the slug and retries). Stamps `created`.
/// EDIT (overwrite=true): rewrites in place, refreshing `name`/`description`/
/// `context`/`system_facts` and preserving every other frontmatter key and the
/// original `created`.
#[tauri::command]
pub fn write_prompt(payload: WritePromptInput) -> Result<WritePromptResult, String> {
    let dir = PathBuf::from(payload.dir.trim());
    if payload.dir.trim().is_empty() {
        return Err("No prompts root configured.".to_string());
    }
    let slug = payload.slug.trim();
    if slug.is_empty() {
        return Err("Empty slug.".to_string());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{slug}.md"));

    let (created, preserved): (Option<String>, Vec<String>) = if payload.overwrite {
        let existing = fs::read_to_string(&path).unwrap_or_default();
        (existing_created(&existing), preserved_frontmatter_lines(&existing))
    } else {
        if path.exists() {
            return Err(format!("{} already exists.", path.to_string_lossy()));
        }
        (Some(today_iso()), Vec::new())
    };

    let frontmatter = build_frontmatter(
        payload.name.trim(),
        payload.description.trim(),
        created.as_deref(),
        &payload.context,
        &payload.system_facts,
        &preserved,
    );

    let body = payload.body.trim_end();
    let contents = format!("---\n{frontmatter}\n---\n\n{body}\n");
    fs::write(&path, contents).map_err(|e| e.to_string())?;

    Ok(WritePromptResult {
        path: path.to_string_lossy().to_string(),
    })
}

/// Today's date as `YYYY-MM-DD` (local), for the `created` frontmatter stamp.
fn today_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Days since epoch → civil date (Howard Hinnant's algorithm). Avoids pulling
    // chrono just for a stamp; UTC is fine for a created date.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_prefers_frontmatter() {
        let raw = "---\nname: My Prompt\ndescription: Does a thing\n---\nbody text here\n";
        let (name, desc) = parse_meta(raw, "fallback");
        assert_eq!(name, "My Prompt");
        assert_eq!(desc, "Does a thing");
    }

    #[test]
    fn meta_falls_back_to_stem_and_first_line() {
        let raw = "# Heading\n\nThe first real sentence.\n";
        let (name, desc) = parse_meta(raw, "fallback");
        assert_eq!(name, "fallback");
        assert_eq!(desc, "The first real sentence.");
    }

    #[test]
    fn first_prose_line_truncates_long_lines() {
        let long = "x".repeat(200);
        let raw = format!("{long}\n");
        let desc = first_prose_line(&raw);
        assert!(desc.ends_with('…'));
        assert!(desc.chars().count() <= 141);
    }

    #[test]
    fn empty_dir_lists_empty() {
        let out = list_prompts(ListInput { dir: String::new() }).unwrap();
        assert!(out.is_empty());
        let out = list_skills(ListInput { dir: "   ".into() }).unwrap();
        assert!(out.is_empty());
    }

    // ── write_prompt (TIN-1764) ────────────────────────────────────────────────

    fn ctx(kind: &str, reference: &str) -> PromptContextRef {
        PromptContextRef {
            kind: kind.to_string(),
            reference: reference.to_string(),
        }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!(
            "agent-studio-write-prompt-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        d
    }

    #[test]
    fn write_new_prompt_writes_frontmatter_and_body() {
        let dir = tmp_dir("new");
        let res = write_prompt(WritePromptInput {
            dir: dir.to_string_lossy().to_string(),
            slug: "my-prompt".into(),
            name: "My Prompt".into(),
            description: "A test".into(),
            body: "Hello body.".into(),
            overwrite: false,
            context: vec![ctx("skill", "jonny")],
            system_facts: vec!["time".into()],
        })
        .unwrap();
        let raw = fs::read_to_string(&res.path).unwrap();
        assert!(raw.starts_with("---\n"));
        assert!(raw.contains("name: My Prompt"));
        assert!(raw.contains("description: A test"));
        assert!(raw.contains("created: "));
        assert!(raw.contains("context:"));
        assert!(raw.contains("- kind: skill"));
        assert!(raw.contains("ref: jonny"));
        assert!(raw.contains("system_facts: [time]"));
        assert!(raw.contains("Hello body."));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_new_prompt_refuses_to_clobber() {
        let dir = tmp_dir("clobber");
        let input = || WritePromptInput {
            dir: dir.to_string_lossy().to_string(),
            slug: "dup".into(),
            name: "Dup".into(),
            description: String::new(),
            body: "one".into(),
            overwrite: false,
            context: vec![],
            system_facts: vec![],
        };
        write_prompt(input()).unwrap();
        let err = write_prompt(input());
        assert!(err.is_err(), "second NEW write to same slug must error");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_in_place_preserves_other_frontmatter_keys() {
        let dir = tmp_dir("edit");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.md");
        fs::write(
            &path,
            "---\nname: Old\ndescription: old desc\ncreated: 2020-01-01\ntags: [a, b]\nstatus: active\n---\n\nOriginal body.\n",
        )
        .unwrap();

        let res = write_prompt(WritePromptInput {
            dir: dir.to_string_lossy().to_string(),
            slug: "doc".into(),
            name: "New Name".into(),
            description: "new desc".into(),
            body: "Rewritten body.".into(),
            overwrite: true,
            context: vec![],
            system_facts: vec![],
        })
        .unwrap();

        let raw = fs::read_to_string(&res.path).unwrap();
        assert!(raw.contains("name: New Name"));
        assert!(raw.contains("description: new desc"));
        // Preserved untouched keys + original created.
        assert!(raw.contains("created: 2020-01-01"), "created preserved");
        assert!(raw.contains("tags: [a, b]"), "tags preserved");
        assert!(raw.contains("status: active"), "status preserved");
        assert!(raw.contains("Rewritten body."));
        // No duplicate name keys.
        assert_eq!(raw.matches("name:").count(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn yaml_scalar_quotes_when_ambiguous() {
        assert_eq!(yaml_scalar("plain"), "plain");
        assert_eq!(yaml_scalar("has: colon"), "\"has: colon\"");
        assert_eq!(yaml_scalar(""), "\"\"");
    }

    #[test]
    fn today_iso_is_well_formed() {
        let d = today_iso();
        assert_eq!(d.len(), 10);
        assert_eq!(d.as_bytes()[4], b'-');
        assert_eq!(d.as_bytes()[7], b'-');
    }
}
