/**
 * frontmatter.ts
 *
 * Frontend client for the frontmatter manager (TIN-1638). Typed wrappers over
 * the Rust commands in `src-tauri/src/frontmatter.rs`:
 *   - `suggestFrontmatter` — rule-based suggestion from a markdown body
 *     (smart generation on create + import flow)
 *   - `auditFrontmatter`   — frontmatter health for every memory file
 *   - `importMarkdown`     — write a body with reviewed frontmatter into memory
 *
 * Types mirror the `Serialize` structs in frontmatter.rs (note `type` is
 * serialised from Rust's `type_`).
 */

import { invoke } from '@tauri-apps/api/core'

// ── Types (mirror frontmatter.rs) ──────────────────────────────────────────────

/** A suggested (and then user-editable) frontmatter set. */
export interface Suggestion {
  /** Slugified identifier (frontmatter `name` + filename stem). */
  name: string
  /** Human-readable title (first heading/sentence) for the preview. */
  title: string
  type: string
  projects: string[]
  tags: string[]
  created: string
  status: string
  /** One-to-two sentence TLDR from the reasoning model. Absent when not yet generated. */
  summary?: string
}

/** Health classification of `'complete' | 'partial' | 'missing'`. */
export type AuditStatus = 'complete' | 'partial' | 'missing'

/** One row of the frontmatter audit. */
export interface AuditEntry {
  path: string
  status: AuditStatus
  type: string
  projects: string[]
  created: string
  /** The file's frontmatter `status` field (not the audit status). */
  docStatus: string
  /** Required fields absent from the file (`type` / `projects` / `created`). */
  missing: string[]
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Suggest a full frontmatter set from a markdown body (local, instant). */
export async function suggestFrontmatter(content: string): Promise<Suggestion> {
  return invoke<Suggestion>('suggest_frontmatter', { payload: { content } })
}

/** Frontmatter health for every indexed memory file, unhealthy first. */
export async function auditFrontmatter(): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>('audit_frontmatter')
}

/** Write `content` with the reviewed `frontmatter` into memory; returns its path. */
export async function importMarkdown(content: string, frontmatter: Suggestion): Promise<string> {
  return invoke<string>('import_markdown', { payload: { content, frontmatter } })
}

/** Rewrite an existing file's frontmatter in place (the audit "fix" path). */
export async function updateFrontmatter(path: string, frontmatter: Suggestion): Promise<void> {
  return invoke('update_frontmatter', { payload: { path, frontmatter } })
}

/** Result of the `summarize_note` command. */
export interface SummarizeNoteResult {
  /** The generated TLDR, or an empty string when degraded. */
  summary: string
  /** True when no reasoning model was reachable; `summary` will be empty. */
  degraded: boolean
}

/**
 * Generate a one-to-two sentence TLDR of a note using the local reasoning model.
 * Degrades gracefully: returns `{ summary: "", degraded: true }` when no model
 * is available — never throws.
 */
export async function summarizeNote(content: string): Promise<SummarizeNoteResult> {
  return invoke<SummarizeNoteResult>('summarize_note', { payload: { content } })
}
