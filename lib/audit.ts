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

/**
 * Subscribe to individual findings as they arrive during an audit run.
 * Findings stream live, before the final batch resolves. Returns an unlisten fn.
 */
export async function onFinding(cb: (f: Finding) => void): Promise<UnlistenFn> {
  return listen<Finding>('audit://finding', (e) => cb(e.payload))
}

/** Cancel an in-progress consistency audit. Partial results remain visible. */
export function cancelAudit(): Promise<void> {
  return invoke('cancel_audit')
}

/**
 * Status of the maintained consistency picture (TIN-1761). `seeded` is true once
 * the first full pass has run; `count` is the number of currently-maintained
 * findings. Cheap — read on mount and on window focus / interval to stay fresh.
 */
export interface ConsistencyStatus {
  seeded: boolean
  count: number
}

/** Read whether the consistency picture has been seeded and how many findings
 *  it currently holds. */
export async function consistencyStatus(): Promise<ConsistencyStatus> {
  return invoke<ConsistencyStatus>('consistency_status')
}

/** Read the maintained current contradictions. Updates in the background as
 *  notes change (no event is emitted; refetch on focus / when the view activates). */
export async function consistencyFindings(): Promise<Finding[]> {
  return invoke<Finding[]>('consistency_findings')
}

/** The settled readout state a status maps to (TIN-1761). `unseeded` invites the
 *  one-time seed; `fresh-findings` reads the maintained table; `fresh-clear` is
 *  the calm all-agree state. Pure, so the mapping is unit-testable. */
export type ConsistencyReadout = 'unseeded' | 'fresh-findings' | 'fresh-clear'

export function statusToReadout(status: ConsistencyStatus): ConsistencyReadout {
  if (!status.seeded) return 'unseeded'
  return status.count > 0 ? 'fresh-findings' : 'fresh-clear'
}
