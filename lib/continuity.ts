/**
 * continuity.ts
 *
 * Frontend client for the write-time continuity surfaces (TIN-1730 + TIN-1728).
 * Typed wrappers over the Rust commands in `src-tauri/src/continuity.rs` and
 * `src-tauri/src/memory_audit.rs`:
 *   - `scoreMemory`        — judge a candidate note against the memory base and
 *     surface any contradictions (the human feedback path)
 *   - `recordMemoryChange` — record a change to the memory ledger with its actor
 *
 * Types mirror the `Serialize`/`Deserialize` structs (camelCase) in those files.
 * These live here, not in a shared lib file, to keep the write-time UX cluster's
 * invoke wrappers self-contained.
 */

import { invoke } from '@tauri-apps/api/core'

// ── Types (mirror continuity.rs / memory_audit.rs) ──────────────────────────────

/** One contradiction the candidate content has with an existing note. */
export interface Conflict {
  /** Path of the note the candidate contradicts. */
  path: string
  /** That note's display name. */
  name: string
  /** The decision the candidate appears to contradict. */
  contradictedDecision: string
  /** A short reason for the contradiction. */
  why: string
}

/** Result of the `score_memory` command. */
export interface ContinuityScore {
  /** 0..1, where 1.0 is consistent (or genuinely novel). */
  continuityScore: number
  /** The contradictions found (empty when consistent or degraded). */
  conflicts: Conflict[]
  /** True when no reasoning model was reachable; a similarity-only estimate. */
  degraded: boolean
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Score a candidate note for continuity with the existing memory base, surfacing
 * any contradictions. Degrades gracefully (similarity-only, no conflicts) when no
 * reasoning model is available; never writes, never throws on a missing model.
 */
export async function scoreMemory(content: string, path?: string): Promise<ContinuityScore> {
  return invoke<ContinuityScore>('score_memory', { payload: { content, path } })
}

/** Record a change to the memory ledger; returns the new entry's id. */
export async function recordMemoryChange(args: {
  path: string
  actorType: string
  actorId: string
  continuityScore?: number
  changeSummary: string
  contentHash: string
}): Promise<number> {
  return invoke<number>('record_memory_change', { payload: args })
}

/**
 * A small, dependency-free body hash (FNV-1a, 32-bit, hex). Stable across runs;
 * used both as the `contentHash` on the ledger and to detect a stale summary.
 */
export function bodyHash(body: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
