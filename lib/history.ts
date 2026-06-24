/**
 * history.ts
 *
 * Thin typed wrapper over the Rust `get_memory_history` command (TIN-1728).
 * Returns audit entries for a memory file, newest-first.
 */

import { invoke } from '@tauri-apps/api/core'

/** A single audit entry for a memory file. */
export interface AuditEntry {
  id: string
  ts: string
  actorType: 'human' | 'agent' | 'external'
  actorId: string
  continuityScore?: number
  changeSummary: string
}

/** Fetch the audit history for a memory file at `path`. Newest-first. */
export async function getMemoryHistory(path: string): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>('get_memory_history', { payload: { path } })
}
