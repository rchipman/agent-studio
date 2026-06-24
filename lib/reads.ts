/**
 * reads.ts
 *
 * Frontend client for the read-tracking layer (TIN-1745). A thin typed
 * wrapper over the `record_note_open` Tauri command in
 * `src-tauri/src/memory_reads.rs`.
 *
 * All exports are fire-and-forget safe: callers should `.catch(() => {})` if
 * they don't want unhandled-rejection noise in dev tools, but the command
 * itself never throws — any error is logged server-side and swallowed.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Record that the user opened a memory note in the GUI. Called fire-and-forget
 * from `loadFile` in `app/page.tsx`; never blocks the UI or changes behaviour.
 */
export async function recordNoteOpen(path: string): Promise<void> {
  return invoke<void>('record_note_open', { payload: { path } })
}
