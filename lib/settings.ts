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

/**
 * Retention policy for the durable session archive (TIN-1759). Tagged on `kind`
 * to mirror the Rust enum's serde representation.
 */
export type RetentionPolicy =
  | { kind: 'keepAll' }
  | { kind: 'sizeCap'; maxBytes: number }
  | { kind: 'keepMonths'; months: number }

/** The full persisted settings shape (secrets excluded). */
export interface Settings {
  memoryRoot: string
  promptsRoot: string
  skillsRoot: string
  transcriptsRoot: string
  agents: Agent[]
  archiveEnabled: boolean
  retentionPolicy: RetentionPolicy
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

// ── Gemini reasoning key (TIN-1789) ─────────────────────────────────────────────

export type GeminiKeyStatus = 'set' | 'unset'

/** Whether a Gemini reasoning key is stored, without revealing it. */
export async function geminiKeyStatus(): Promise<GeminiKeyStatus> {
  return invoke<GeminiKeyStatus>('gemini_key_status')
}

/** Store the Gemini API key in the keychain. An empty key clears it. */
export async function setGeminiKey(key: string): Promise<void> {
  await invoke('set_gemini_key', { payload: { key } })
}

/** Reveal the plaintext Gemini key. Call only on explicit user action. */
export async function revealGeminiKey(): Promise<string> {
  return invoke<string>('reveal_gemini_key')
}

// ── Linear ────────────────────────────────────────────────────────────────────

export type LinearKeyStatus = 'set' | 'unset'

export interface LinearTeam {
  key: string
  name: string
}

export interface LinearSyncResult {
  issueCount: number
  epicCount: number
  commentCount: number
  lastSynced: string
}

/** Whether a Linear key is stored, without revealing it. */
export async function linearKeyStatus(): Promise<LinearKeyStatus> {
  return invoke<LinearKeyStatus>('linear_key_status')
}

/** Store the Linear API key in the keychain. An empty key clears it. */
export async function setLinearKey(key: string): Promise<void> {
  await invoke('set_linear_key', { payload: { key } })
}

/** Reveal the plaintext Linear API key. Call only on explicit user action. */
export async function revealLinearKey(): Promise<string> {
  return invoke<string>('reveal_linear_key')
}

/** List Linear teams available with the stored key. */
export async function listLinearTeams(): Promise<LinearTeam[]> {
  return invoke<LinearTeam[]>('list_linear_teams')
}

/** Trigger a Linear sync. Pass teamKey to scope to a specific team. */
export async function syncLinear(teamKey?: string): Promise<LinearSyncResult> {
  return invoke<LinearSyncResult>('sync_linear', { payload: { teamKey } })
}

// ── Session archive (TIN-1759) ──────────────────────────────────────────────────

/** Manifest-derived preview of what a retention cleanup would prune. */
export interface PrunePreview {
  count: number
  bytes: number
}

/** Instant status snapshot for the Session archive section, from the manifest. */
export interface ArchiveStatus {
  enabled: boolean
  sessionCount: number
  storedBytes: number
  oldestDate: string
  newestDate: string
  overCapBytes: number
  prunablePreview: PrunePreview
}

/** Result of a retention cleanup run. */
export interface CleanupResult {
  prunedCount: number
  freedBytes: number
  newStoredBytes: number
}

/** Read the archive status (size, range, prune preview). Reconciles on first call. */
export async function archiveStatus(): Promise<ArchiveStatus> {
  return invoke<ArchiveStatus>('archive_status')
}

/** Persist the archive toggle + retention policy. */
export async function setRetentionPolicy(
  policy: RetentionPolicy,
  enabled: boolean,
): Promise<void> {
  await invoke('set_retention_policy', { payload: { policy, enabled } })
}

/** Trim the archive back under its cap / window. Idempotent; zeros when nothing prunable. */
export async function runRetentionCleanup(): Promise<CleanupResult> {
  return invoke<CleanupResult>('run_retention_cleanup')
}
