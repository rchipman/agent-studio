/**
 * audit.ts
 *
 * Frontend client for the Consistency Audit (TIN-1695) — find contradictions
 * across the memory base. Embeddings cluster related notes; a local reasoning
 * model judges each related pair; findings come back with file references.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** One flagged contradiction between two notes (mirrors audit.rs `Finding`). */
export interface Finding {
  /** The two file paths involved. */
  files: string[]
  /** Display names for those files. */
  names: string[]
  /** One-sentence description of the conflict. */
  summary: string
}

/** Progress of an in-flight audit (`done` of `total` related pairs judged). */
export interface AuditProgress {
  done: number
  total: number
}

/**
 * Run the audit: cluster related notes, judge the most-similar pairs with the
 * local reasoning model, return concrete findings. Can take a while (local LLM
 * over many pairs) — subscribe with {@link onAuditProgress} for a progress line.
 * Rejects with a calm message if no reasoning model is reachable.
 */
export async function consistencyAudit(): Promise<Finding[]> {
  return invoke<Finding[]>('consistency_audit')
}

/** Subscribe to audit progress events; returns an unlisten fn. */
export async function onAuditProgress(cb: (p: AuditProgress) => void): Promise<UnlistenFn> {
  return listen<AuditProgress>('audit://progress', (e) => cb(e.payload))
}
