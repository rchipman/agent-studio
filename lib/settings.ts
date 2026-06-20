/**
 * settings.ts
 *
 * Typed load/save for Agent Studio settings, backed by the Rust commands in
 * `src-tauri/src/settings.rs` (persisted JSON store) plus the OS keychain for
 * the embedding API key.
 *
 * The embedding API key is never part of `Settings`: it lives in the keychain
 * and is reached only through the dedicated key commands below. The frontend
 * shows Set/Not set status and reveals the plaintext on explicit demand.
 */

import { invoke } from '@tauri-apps/api/core'

/** A registered coding agent the launcher can spawn. */
export interface Agent {
  name: string
  command: string
  args: string[]
  cwd: string
}

/** The full persisted settings shape (secrets excluded). */
export interface Settings {
  memoryRoot: string
  promptsRoot: string
  skillsRoot: string
  transcriptsRoot: string
  agents: Agent[]
}

export type EmbeddingKeyStatus = 'set' | 'unset'

/** Load the persisted settings (defaults are filled in by the backend). */
export async function getSettings(): Promise<Settings> {
  return invoke<Settings>('get_settings')
}

/**
 * Persist settings. The backend rebuilds the search index automatically if the
 * memory root changed.
 */
export async function setSettings(settings: Settings): Promise<void> {
  await invoke('set_settings', { payload: { settings } })
}

/** Rebuild the search index against the currently-configured memory root. */
export async function rebuildIndex(): Promise<number> {
  return invoke<number>('rebuild_index')
}

/** Store the embedding API key in the keychain. An empty key clears it. */
export async function setEmbeddingKey(key: string): Promise<void> {
  await invoke('set_embedding_key', { payload: { key } })
}

/** Whether an embedding key is stored, without revealing it. */
export async function embeddingKeyStatus(): Promise<EmbeddingKeyStatus> {
  return invoke<EmbeddingKeyStatus>('embedding_key_status')
}

/** Reveal the plaintext embedding key. Call only on explicit user action. */
export async function revealEmbeddingKey(): Promise<string> {
  return invoke<string>('reveal_embedding_key')
}
