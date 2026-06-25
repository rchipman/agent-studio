//! outcomes.rs
//!
//! Extract a session's *outcomes* — the things it produced — from its raw
//! `.jsonl` transcript (TIN-1771). These feed the Session detail "Outcomes"
//! ribbon: a calm index of PRs, Linear tickets, memories, files, images, and
//! commits, each clickable (open externally / open the doc / jump to the moment
//! in the transcript that produced it).
//!
//! Extraction is deliberately dependency-free (no `regex`): URLs and ticket refs
//! are scanned by hand over each line, and structured artifacts (file writes,
//! commits, images) are read from the content blocks. Per-line scanning of the
//! whole raw string is intentional for URLs/tickets — they can appear in text,
//! a tool_result, or a top-level `toolUseResult`, and a blunt scan catches them
//! all without modelling every shape.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// One produced artifact. `address` is the openable target (URL or absolute file
/// path), empty for images. `kind` is one of
/// `pr | ticket | memory | file | image | commit`.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub kind: String,
    pub label: String,
    pub address: String,
}

impl Outcome {
    fn new(kind: &str, label: impl Into<String>, address: impl Into<String>) -> Self {
        Outcome {
            kind: kind.to_string(),
            label: label.into(),
            address: address.into(),
        }
    }
}

/// Extract every outcome from a session's raw transcript text. `memory_root`
/// classifies a written file as a `memory` (under the root) vs a plain `file`.
/// Addressable kinds are de-duplicated by (kind, address); images are kept one
/// per block (they have no address) so the ribbon can count them.
pub fn extract_outcomes(raw: &str, memory_root: &Path) -> Vec<Outcome> {
    let mut out: Vec<Outcome> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    let mut push_unique = |o: Outcome, out: &mut Vec<Outcome>| {
        let key = (o.kind.clone(), o.address.clone());
        if seen.insert(key) {
            out.push(o);
        }
    };

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // URLs + ticket refs: scan the whole raw line (robust to text vs
        // tool_result vs toolUseResult placement).
        for o in scan_pr_urls(line) {
            push_unique(o, &mut out);
        }
        for o in scan_tickets(line) {
            push_unique(o, &mut out);
        }

        // Structured artifacts: file writes, commits, images — from content blocks.
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let content = value.get("message").and_then(|m| m.get("content"));
        let Some(Value::Array(blocks)) = content else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "tool_use" => {
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let input = block.get("input");
                    if is_write_tool(name) {
                        if let Some(fp) = input
                            .and_then(|i| i.get("file_path"))
                            .and_then(|f| f.as_str())
                        {
                            push_unique(classify_write(fp, memory_root), &mut out);
                        }
                    } else if name == "Bash" {
                        if let Some(cmd) = input
                            .and_then(|i| i.get("command"))
                            .and_then(|c| c.as_str())
                        {
                            if let Some(o) = scan_commit(cmd) {
                                push_unique(o, &mut out);
                            }
                        }
                    }
                }
                "image" => {
                    // No address → always pushed; the ribbon counts them.
                    out.push(Outcome::new("image", "screenshot", ""));
                }
                _ => {}
            }
        }
    }

    out
}

/// Write-style tools whose `file_path` input is a produced artifact.
fn is_write_tool(name: &str) -> bool {
    matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit")
}

/// Classify a written path as a memory (under the memory root) or a plain file.
/// The label is the filename; the address is the absolute path.
fn classify_write(file_path: &str, memory_root: &Path) -> Outcome {
    let name = file_path.rsplit('/').next().unwrap_or(file_path).to_string();
    let root = memory_root.to_string_lossy();
    let is_memory = !root.is_empty() && file_path.starts_with(root.as_ref());
    if is_memory {
        Outcome::new("memory", name, file_path)
    } else {
        Outcome::new("file", name, file_path)
    }
}

/// Find every `github.com/<owner>/<repo>/pull/<n>` URL in `text`. The label is
/// `<repo>#<n>`; the address is the normalized `https://` URL.
fn scan_pr_urls(text: &str) -> Vec<Outcome> {
    let mut out = Vec::new();
    let needle = "github.com/";
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(rel) = text[from..].find(needle) {
        let start = from + rel + needle.len();
        // Parse owner/repo/pull/<digits>.
        let rest = &text[start..];
        if let Some(pr) = parse_pull(rest) {
            out.push(pr);
        }
        from = start;
        if from >= bytes.len() {
            break;
        }
    }
    out
}

/// Parse `<owner>/<repo>/pull/<n>` at the start of `s` into a PR outcome.
fn parse_pull(s: &str) -> Option<Outcome> {
    let mut parts = s.splitn(5, '/');
    let owner = parts.next().filter(|p| is_url_segment(p))?;
    let repo = parts.next().filter(|p| is_url_segment(p))?;
    let kw = parts.next()?;
    if kw != "pull" {
        return None;
    }
    let num_seg = parts.next()?;
    let num: String = num_seg.chars().take_while(|c| c.is_ascii_digit()).collect();
    if num.is_empty() {
        return None;
    }
    let address = format!("https://github.com/{owner}/{repo}/pull/{num}");
    Some(Outcome::new("pr", format!("{repo}#{num}"), address))
}

/// A plausible URL path segment (owner/repo): non-empty, no spaces or slashes.
fn is_url_segment(s: &str) -> bool {
    !s.is_empty() && !s.contains(|c: char| c.is_whitespace() || c == '/')
}

/// Find Linear ticket references: bare `TIN-<n>` and `linear.app/.../issue/TIN-<n>`
/// URLs. De-dupes to one outcome per ticket id; an address is set when a
/// linear.app URL is present, else a constructed issue link is omitted (address
/// stays the ticket id so the frontend can resolve it).
fn scan_tickets(text: &str) -> Vec<Outcome> {
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if &text[i..i + 4] == "TIN-" {
            // Must be a word boundary before TIN- (not e.g. "XTIN-").
            let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let digits: String = text[i + 4..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if prev_ok && !digits.is_empty() {
                let id = format!("TIN-{digits}");
                if seen.insert(id.clone()) {
                    out.push(Outcome::new("ticket", id.clone(), id));
                }
                i += 4 + digits.len();
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Detect a `git commit` in a bash command and, when present, use its `-m`
/// message as the label. Returns None for non-commit commands. The address is
/// empty (a commit is not externally addressable from the transcript alone).
fn scan_commit(command: &str) -> Option<Outcome> {
    if !command.contains("git commit") {
        return None;
    }
    let label = commit_message(command).unwrap_or_else(|| "commit".to_string());
    // Address carries the message too so repeated identical messages de-dupe.
    Some(Outcome::new("commit", label.clone(), format!("commit:{label}")))
}

/// Pull the first `-m "..."` (or `-m '...'`) message out of a git command.
fn commit_message(command: &str) -> Option<String> {
    let idx = command.find("-m ")?;
    let after = command[idx + 3..].trim_start();
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &after[1..];
    let end = body.find(quote)?;
    let msg = body[..end].trim();
    if msg.is_empty() {
        None
    } else {
        // First line only, trimmed for a compact chip.
        Some(msg.lines().next().unwrap_or(msg).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn mem_root() -> PathBuf {
        PathBuf::from("/Users/rob/Projects/tfl/memory")
    }

    fn kinds(out: &[Outcome]) -> Vec<&str> {
        out.iter().map(|o| o.kind.as_str()).collect()
    }

    #[test]
    fn pr_url_extracted_with_repo_and_number() {
        let prs = scan_pr_urls("opened https://github.com/rchipman/agent-studio/pull/77 today");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].kind, "pr");
        assert_eq!(prs[0].label, "agent-studio#77");
        assert_eq!(prs[0].address, "https://github.com/rchipman/agent-studio/pull/77");
    }

    #[test]
    fn pr_url_ignores_non_pull_github_urls() {
        let prs = scan_pr_urls("see github.com/rchipman/agent-studio/blob/main/x.rs");
        assert!(prs.is_empty());
    }

    #[test]
    fn tickets_bare_and_url_dedupe_per_id() {
        let t = scan_tickets("TIN-1766 fixed; see linear.app/tiny/issue/TIN-1766/foo and TIN-1770");
        let ids: Vec<&str> = t.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(ids, vec!["TIN-1766", "TIN-1770"]);
        assert!(t.iter().all(|o| o.kind == "ticket"));
    }

    #[test]
    fn ticket_requires_word_boundary() {
        // "XTIN-9" must not match; "(TIN-9)" must.
        assert!(scan_tickets("XTIN-9").is_empty());
        assert_eq!(scan_tickets("(TIN-9)")[0].label, "TIN-9");
    }

    #[test]
    fn write_classifies_memory_vs_file() {
        let mem = classify_write("/Users/rob/Projects/tfl/memory/studio/note.md", &mem_root());
        assert_eq!(mem.kind, "memory");
        assert_eq!(mem.label, "note.md");
        let file = classify_write("/Users/rob/Dev/agent-studio/src/x.rs", &mem_root());
        assert_eq!(file.kind, "file");
        assert_eq!(file.label, "x.rs");
    }

    #[test]
    fn commit_message_pulled_from_dash_m() {
        let o = scan_commit(r#"git commit -m "fix: the thing" --amend"#).unwrap();
        assert_eq!(o.kind, "commit");
        assert_eq!(o.label, "fix: the thing");
        assert!(scan_commit("ls -la").is_none());
    }

    #[test]
    fn extract_walks_a_realistic_session() {
        // One user line, one assistant line with a Write tool_use + a PR url in
        // text, one bash commit, one image block.
        let raw = [
            r#"{"type":"user","message":{"role":"user","content":"go"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Opened https://github.com/rchipman/agent-studio/pull/80 for TIN-1769"},{"type":"tool_use","name":"Write","input":{"file_path":"/Users/rob/Projects/tfl/memory/studio/x.md"}},{"type":"tool_use","name":"Bash","input":{"command":"git commit -m \"feat: x\""}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}}"#,
        ]
        .join("\n");
        let out = extract_outcomes(&raw, &mem_root());
        let ks = kinds(&out);
        assert!(ks.contains(&"pr"), "pr extracted: {ks:?}");
        assert!(ks.contains(&"ticket"), "ticket extracted");
        assert!(ks.contains(&"memory"), "memory write extracted");
        assert!(ks.contains(&"commit"), "commit extracted");
        assert!(ks.contains(&"image"), "image extracted");
    }

    #[test]
    fn extract_dedupes_addressable_outcomes() {
        // Same PR mentioned twice → one outcome.
        let raw = [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"github.com/a/b/pull/5"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"again github.com/a/b/pull/5"}]}}"#,
        ]
        .join("\n");
        let out = extract_outcomes(&raw, &mem_root());
        let prs: Vec<_> = out.iter().filter(|o| o.kind == "pr").collect();
        assert_eq!(prs.len(), 1, "duplicate PR collapses to one");
    }
}
