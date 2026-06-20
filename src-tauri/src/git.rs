//! git.rs
//!
//! Read-only git commands exposed to the frontend as Tauri commands.
//! Runs `git` via std::process::Command in the provided working directory.
//!
//! Commands:
//!   git_status(dir) -> GitStatusResult  — branch + file list with M/A/D status
//!   git_diff(payload) -> String          — raw unified diff for a single file
//!
//! Convention: commands with ≥2 args take a single payload struct.

use std::process::Command;

use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

/// A single changed file.
#[derive(Serialize, Clone, Debug)]
pub struct GitFile {
    pub path: String,
    /// "M" | "A" | "D" | "?" (unknown / untracked)
    pub status: String,
}

/// Response from `git_status`.
#[derive(Serialize, Clone, Debug)]
pub struct GitStatusResult {
    pub branch: String,
    pub files: Vec<GitFile>,
}

/// Payload for `git_diff` (≥2 args -> payload struct per project convention).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPayload {
    pub dir: String,
    pub file: String,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Run a git command in `dir`, returning stdout as a String.
/// Returns Err if the process fails to spawn or exits with a non-zero status
/// that signals "not a git repo" (exit 128).
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;

    // Exit 128 = fatal: not a git repository (or any other git fatal error).
    if output.status.code() == Some(128) {
        return Err("not-a-repo".to_string());
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parse `git status --porcelain` output into a list of GitFile entries.
///
/// Porcelain v1 format: two-char XY status, a space, then the path.
/// We collapse the XY pair to a single semantic letter:
///   - A if added (index or worktree)
///   - D if deleted (index or worktree)
///   - M otherwise (including renames, copies, modifications)
///
/// Untracked files (??) are included with status "?".
fn parse_porcelain(raw: &str) -> Vec<GitFile> {
    let mut files = Vec::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let path = line[3..].to_string();

        // Porcelain rename format: "old -> new"; we want the new path.
        let path = if let Some(arrow) = path.find(" -> ") {
            path[arrow + 4..].to_string()
        } else {
            path
        };

        let status = match xy {
            "??" => "?".to_string(),
            _ => {
                let x = xy.chars().next().unwrap_or(' ');
                let y = xy.chars().nth(1).unwrap_or(' ');
                // Index (x) takes precedence; fall back to worktree (y).
                let ch = if x != ' ' && x != '?' { x } else { y };
                match ch {
                    'A' => "A".to_string(),
                    'D' => "D".to_string(),
                    _ => "M".to_string(),
                }
            }
        };

        files.push(GitFile { path, status });
    }
    files
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Return the current branch name and changed files for `dir`.
///
/// Errors are surfaced as typed strings so the frontend can distinguish
/// between "not a repo" and other failures without parsing messages.
///
/// Error values:
///   "not-a-repo"  — `dir` is not inside a git repository
///   anything else — unexpected git error
#[tauri::command]
pub fn git_status(dir: String) -> Result<GitStatusResult, String> {
    // Branch name
    let branch_raw = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = branch_raw.trim().to_string();

    // Changed files (porcelain v1, NUL-safe for paths with spaces via -z omitted
    // intentionally; paths with newlines are exotic enough to skip for now).
    let status_raw = run_git(&dir, &["status", "--porcelain"])?;
    let files = parse_porcelain(&status_raw);

    Ok(GitStatusResult { branch, files })
}

/// Return the raw unified diff for a single file in `dir`.
///
/// For untracked files (status "?") we diff against /dev/null so the caller
/// gets a valid unified-diff string showing the entire file as additions.
/// For staged-only deletions the output may be empty (file already gone from
/// worktree); the frontend should handle that gracefully.
#[tauri::command]
pub fn git_diff(payload: GitDiffPayload) -> Result<String, String> {
    let dir = &payload.dir;
    let file = &payload.file;

    // Try worktree diff first (unstaged changes).
    let diff = run_git(dir, &["diff", "--", file])?;

    // If the worktree diff is empty, the change may be staged only.
    let diff = if diff.trim().is_empty() {
        run_git(dir, &["diff", "--cached", "--", file])?
    } else {
        diff
    };

    // Still empty: file may be untracked. Show it as all-additions vs /dev/null.
    let diff = if diff.trim().is_empty() {
        match run_git(dir, &["diff", "--no-index", "--", "/dev/null", file]) {
            Ok(d) => d,
            // exit 1 from --no-index diff is normal (files differ); only fail on 128+
            Err(e) if e == "not-a-repo" => return Err(e),
            Err(_) => String::new(),
        }
    } else {
        diff
    };

    Ok(diff)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_modified() {
        let raw = " M src/lib.rs\n";
        let files = parse_porcelain(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].status, "M");
    }

    #[test]
    fn parse_porcelain_added() {
        let raw = "A  new-file.ts\n";
        let files = parse_porcelain(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "A");
    }

    #[test]
    fn parse_porcelain_deleted() {
        let raw = " D gone.rs\n";
        let files = parse_porcelain(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "D");
    }

    #[test]
    fn parse_porcelain_untracked() {
        let raw = "?? untracked.md\n";
        let files = parse_porcelain(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "?");
    }

    #[test]
    fn parse_porcelain_rename() {
        let raw = "R  old.rs -> new.rs\n";
        let files = parse_porcelain(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.rs");
        assert_eq!(files[0].status, "M");
    }
}
