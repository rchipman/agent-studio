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
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

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

// ── Confidence suggestions (TIN-1758) ────────────────────────────────────────

/** Provenance of a field's resolved value (drives the micro-label). */
export type FieldSource = 'path' | 'agree' | 'file-date' | 'rules' | 'model' | 'none'

/** One field's resolved value plus how sure we are and where it came from. */
export interface FieldConfidence {
  value: string
  /** 0..1 per the provenance ladder. */
  confidence: number
  source: FieldSource
}

/** Confidence band for a per-file overall score. */
export type Band = 'settled' | 'likely' | 'unsure'

/** A confidence-scored suggestion for one file (mirrors Rust `ConfidenceResult`). */
export interface ConfidenceResult {
  /** Absolute path of the file this suggestion is for. */
  path: string
  suggestion: Suggestion
  /** Per-missing-field confidence, keyed `type` | `projects` | `created`. */
  fields: Record<string, FieldConfidence>
  /** Per-file band score = the minimum across `fields` (1.0 when none missing). */
  overall: number
  /** True when no reasoning model was reachable (rules + path only). */
  degraded: boolean
}

/** Band cut points, shared with the Rust `band()` (Settled ≥0.85, Likely ≥0.55). */
export function bandOf(overall: number): Band {
  if (overall >= 0.85) return 'settled'
  if (overall >= 0.55) return 'likely'
  return 'unsure'
}

export interface KnownVocab {
  knownTypes?: string[]
  knownProjects?: string[]
  knownTags?: string[]
}

/**
 * Confidence-scored suggestion for a single file (the per-row expand path).
 * Never throws on a missing model: returns the rules+path result with
 * `degraded: true`.
 */
export async function suggestWithConfidence(
  path: string,
  content: string,
  vocab: KnownVocab = {},
): Promise<ConfidenceResult> {
  return invoke<ConfidenceResult>('suggest_with_confidence', {
    payload: {
      path,
      content,
      knownTypes: vocab.knownTypes ?? [],
      knownProjects: vocab.knownProjects ?? [],
      knownTags: vocab.knownTags ?? [],
    },
  })
}

/**
 * Background pass: confidence-score every unhealthy file. Emits `audit://progress`
 * (subscribe with {@link onAuditProgress} from `lib/audit`). Path/rule-only files
 * cost no model call; degrades calmly with no model.
 */
export async function suggestAll(skip: string[] = []): Promise<ConfidenceResult[]> {
  return invoke<ConfidenceResult[]>('suggest_all', { skip })
}

/**
 * Subscribe to each suggestion as `suggest_all` produces it (one per file),
 * so rows can light up live instead of waiting for the whole pass. Returns an
 * unlisten fn. The final {@link suggestAll} resolution still returns the full
 * set as a backstop.
 */
export async function onSuggestResult(cb: (r: ConfidenceResult) => void): Promise<UnlistenFn> {
  return listen<ConfidenceResult>('suggest://result', (e) => cb(e.payload))
}

/** One file's apply payload: the reviewed suggestion + the recording actor. */
export interface ApplySuggestionPayload {
  path: string
  suggestion: Suggestion
  /** The model name, or `"rules"` when degraded. */
  actorId: string
}

/**
 * Apply one file's suggested frontmatter (body-preserving), record a memory_audit
 * row (actor = the model), and rebuild the index so the row re-resolves.
 */
export async function applySuggestion(payload: ApplySuggestionPayload): Promise<void> {
  return invoke('apply_suggestion', { payload })
}

/**
 * Apply a batch of suggestions: write + record each, emit `audit://progress` per
 * write, rebuild the index ONCE at the end. Returns the count applied.
 */
export async function applySuggestionsBulk(payloads: ApplySuggestionPayload[]): Promise<number> {
  return invoke<number>('apply_suggestions_bulk', { payload: payloads })
}

/** Cancel an in-progress suggest_all pass. Partial results remain visible. */
export function cancelSuggest(): Promise<void> {
  return invoke('cancel_suggest')
}
