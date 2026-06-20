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
}
