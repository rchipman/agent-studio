'use client'

/**
 * SettingsModal.tsx
 *
 * The Settings surface (TIN-1637) — a tall cream modal per
 * docs/design/studio-surfaces.md §1. Three sections: Roots, Embedding, Agents.
 * Self-contained: reads/writes via lib/settings.ts. Props: { open, onClose }.
 *
 * House rules: tokens only (no magic numbers), no red (tan `--notice` for the
 * out-of-date state), native folder picker, calm copy, no em-dashes.
 */

import { useCallback, useEffect, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { color, space, radius, font, shadow, type } from '@/lib/tokens'
import Button from '@/components/Button'
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme'
import {
  getSettings,
  setSettings,
  rebuildIndex,
  setEmbeddingKey,
  embeddingKeyStatus,
  revealEmbeddingKey,
  setGeminiKey,
  geminiKeyStatus,
  revealGeminiKey,
  linearKeyStatus,
  setLinearKey,
  revealLinearKey,
  listLinearTeams,
  syncLinear,
  archiveStatus,
  setRetentionPolicy,
  runRetentionCleanup,
  type Settings,
  type Agent,
  type EmbeddingKeyStatus,
  type GeminiKeyStatus,
  type LinearKeyStatus,
  type LinearTeam,
  type ArchiveStatus,
  type RetentionPolicy,
} from '@/lib/settings'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const EMPTY_SETTINGS: Settings = {
  memoryRoot: '',
  promptsRoot: '',
  skillsRoot: '',
  transcriptsRoot: '',
  agents: [],
  archiveEnabled: true,
  retentionPolicy: { kind: 'sizeCap', maxBytes: 2_147_483_648 },
}

/** One gibibyte, the unit the size-cap field works in. */
const BYTES_PER_GB = 1_073_741_824

const MASK = '••••••••••••'

// Reindex flow state for the memory-root row.
type Reindex =
  | { kind: 'idle' }
  | { kind: 'confirm' } // root changed, inline "Rebuild index now?"
  | { kind: 'rebuilding' }
  | { kind: 'done' } // "Index rebuilt" for a beat
  | { kind: 'stale' } // deferred: "Index may be out of date."

// Linear sync flow state.
type LinearSync =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; lastSynced: string }
  | { kind: 'error' }

// Archive cleanup ("Free up space") flow state. Mirrors the Linear-sync idiom.
type Cleanup =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; newStoredBytes: number }
  | { kind: 'error' }

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState(false)
  const [settings, setSettingsState] = useState<Settings>(EMPTY_SETTINGS)
  const [initialMemoryRoot, setInitialMemoryRoot] = useState('')

  // Embedding key
  const [keyStatus, setKeyStatus] = useState<EmbeddingKeyStatus>('unset')
  const [keyDraft, setKeyDraft] = useState<string | null>(null) // null = untouched
  const [revealed, setRevealed] = useState(false)

  // Gemini reasoning key (TIN-1789)
  const [geminiStatus, setGeminiStatus] = useState<GeminiKeyStatus>('unset')
  const [geminiKeyDraft, setGeminiKeyDraft] = useState<string | null>(null) // null = untouched
  const [geminiRevealed, setGeminiRevealed] = useState(false)

  const [reindex, setReindex] = useState<Reindex>({ kind: 'idle' })

  // Linear key
  const [linearStatus, setLinearStatus] = useState<LinearKeyStatus>('unset')
  const [linearKeyDraft, setLinearKeyDraft] = useState<string | null>(null) // null = untouched
  const [linearRevealed, setLinearRevealed] = useState(false)
  // Linear teams
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([])
  const [linearTeamKey, setLinearTeamKey] = useState<string>('')
  // Sync state
  const [linearSync, setLinearSync] = useState<LinearSync>({ kind: 'idle' })

  // ── Session archive (TIN-1759) ──
  const [archive, setArchive] = useState<ArchiveStatus | null>(null)
  const [cleanup, setCleanup] = useState<Cleanup>({ kind: 'idle' })

  // ── Load on open ──
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setSaveError(false)
    setReindex({ kind: 'idle' })
    setKeyDraft(null)
    setRevealed(false)
    setGeminiKeyDraft(null)
    setGeminiRevealed(false)
    setLinearKeyDraft(null)
    setLinearRevealed(false)
    setLinearSync({ kind: 'idle' })
    setCleanup({ kind: 'idle' })
    ;(async () => {
      try {
        const [s, status, gemStatus, linStatus, arch] = await Promise.all([
          getSettings(),
          embeddingKeyStatus(),
          geminiKeyStatus(),
          linearKeyStatus(),
          archiveStatus().catch(() => null),
        ])
        if (cancelled) return
        setSettingsState(s)
        setInitialMemoryRoot(s.memoryRoot)
        setKeyStatus(status)
        setGeminiStatus(gemStatus)
        setLinearStatus(linStatus)
        setArchive(arch)
        // Load teams if key is already set
        if (linStatus === 'set') {
          try {
            const teams = await listLinearTeams()
            if (!cancelled) setLinearTeams(teams)
          } catch {
            // Not fatal — teams list just stays empty
          }
        }
      } catch (err) {
        console.error('[settings] load', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // ── Esc to dismiss ──
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // ── Root field helpers ──
  const setRoot = useCallback((field: keyof Settings, value: string) => {
    setSettingsState((prev) => ({ ...prev, [field]: value }))
  }, [])

  async function chooseFolder(field: keyof Settings, current: string) {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: current || undefined,
      })
      if (typeof picked === 'string') {
        setRoot(field, picked)
        if (field === 'memoryRoot') maybeOfferReindex(picked)
      }
    } catch (err) {
      console.error('[settings] folder picker', err)
    }
  }

  // When the memory root differs from the loaded value, offer the inline confirm.
  function maybeOfferReindex(nextRoot: string) {
    if (nextRoot.trim() !== initialMemoryRoot.trim()) {
      setReindex({ kind: 'confirm' })
    } else {
      setReindex({ kind: 'idle' })
    }
  }

  async function doRebuild() {
    setReindex({ kind: 'rebuilding' })
    try {
      // Persist first so the backend rebuilds against the new root.
      await persist(settings)
      await rebuildIndex()
      setInitialMemoryRoot(settings.memoryRoot)
      setReindex({ kind: 'done' })
      setTimeout(() => setReindex((r) => (r.kind === 'done' ? { kind: 'idle' } : r)), 1800)
    } catch (err) {
      console.error('[settings] rebuild', err)
      setReindex({ kind: 'stale' })
    }
  }

  // Reindex the current memory root on demand (no root change needed). Lets the
  // index pick up files added outside Studio without relaunching.
  async function manualReindex() {
    setReindex({ kind: 'rebuilding' })
    try {
      await rebuildIndex()
      setReindex({ kind: 'done' })
      setTimeout(() => setReindex((r) => (r.kind === 'done' ? { kind: 'idle' } : r)), 1800)
    } catch (err) {
      console.error('[settings] manual reindex', err)
      setReindex({ kind: 'stale' })
    }
  }

  // ── Embedding key ──
  async function toggleReveal() {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (keyDraft !== null) {
      // Showing the in-progress draft already.
      setRevealed(true)
      return
    }
    try {
      const plain = await revealEmbeddingKey()
      setKeyDraft(plain)
      setRevealed(true)
    } catch (err) {
      console.error('[settings] reveal', err)
    }
  }

  // ── Gemini key (TIN-1789) ──
  async function toggleGeminiReveal() {
    if (geminiRevealed) {
      setGeminiRevealed(false)
      return
    }
    if (geminiKeyDraft !== null) {
      // Showing the in-progress draft already.
      setGeminiRevealed(true)
      return
    }
    try {
      const plain = await revealGeminiKey()
      setGeminiKeyDraft(plain)
      setGeminiRevealed(true)
    } catch (err) {
      console.error('[settings] gemini reveal', err)
    }
  }

  // ── Linear key ──
  async function toggleLinearReveal() {
    if (linearRevealed) {
      setLinearRevealed(false)
      return
    }
    if (linearKeyDraft !== null) {
      setLinearRevealed(true)
      return
    }
    try {
      const plain = await revealLinearKey()
      setLinearKeyDraft(plain)
      setLinearRevealed(true)
    } catch (err) {
      console.error('[settings] linear reveal', err)
    }
  }

  // ── Linear sync ──
  async function doLinearSync() {
    setLinearSync({ kind: 'syncing' })
    try {
      // Persist the key draft first if it has changed
      if (linearKeyDraft !== null) {
        await setLinearKey(linearKeyDraft)
        setLinearStatus(linearKeyDraft.trim() ? 'set' : 'unset')
      }
      const result = await syncLinear(linearTeamKey || undefined)
      // Load teams after first sync
      try {
        const teams = await listLinearTeams()
        setLinearTeams(teams)
      } catch {
        // Not fatal
      }
      setLinearSync({ kind: 'done', lastSynced: result.lastSynced })
    } catch (err) {
      console.error('[settings] linear sync', err)
      setLinearSync({ kind: 'error' })
    }
  }

  // ── Session archive (TIN-1759) ──
  // Persist the toggle + policy, then refresh the status readout so the prune
  // preview and over-cap line reflect the new policy immediately.
  async function persistArchive(policy: RetentionPolicy, enabled: boolean) {
    setSettingsState((prev) => ({ ...prev, archiveEnabled: enabled, retentionPolicy: policy }))
    setCleanup({ kind: 'idle' })
    try {
      await setRetentionPolicy(policy, enabled)
      const next = await archiveStatus()
      setArchive(next)
    } catch (err) {
      console.error('[settings] archive policy', err)
    }
  }

  function toggleArchive(enabled: boolean) {
    void persistArchive(settings.retentionPolicy, enabled)
  }

  function changePolicy(policy: RetentionPolicy) {
    void persistArchive(policy, settings.archiveEnabled)
  }

  async function doCleanup() {
    setCleanup({ kind: 'running' })
    try {
      const result = await runRetentionCleanup()
      const next = await archiveStatus()
      setArchive(next)
      setCleanup({ kind: 'done', newStoredBytes: result.newStoredBytes })
      setTimeout(
        () => setCleanup((c) => (c.kind === 'done' ? { kind: 'idle' } : c)),
        2400,
      )
    } catch (err) {
      console.error('[settings] cleanup', err)
      setCleanup({ kind: 'error' })
    }
  }

  // ── Agents ──
  function addAgent() {
    setSettingsState((prev) => ({
      ...prev,
      agents: [...prev.agents, { name: '', command: '', args: [], cwd: '' }],
    }))
  }

  function updateAgent(index: number, patch: Partial<Agent>) {
    setSettingsState((prev) => ({
      ...prev,
      agents: prev.agents.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    }))
  }

  function removeAgent(index: number) {
    setSettingsState((prev) => ({
      ...prev,
      agents: prev.agents.filter((_, i) => i !== index),
    }))
  }

  // ── Persist ──
  async function persist(s: Settings) {
    await setSettings(s)
    if (keyDraft !== null) {
      await setEmbeddingKey(keyDraft)
      setKeyStatus(keyDraft.trim() ? 'set' : 'unset')
    }
    if (geminiKeyDraft !== null) {
      await setGeminiKey(geminiKeyDraft)
      setGeminiStatus(geminiKeyDraft.trim() ? 'set' : 'unset')
    }
    if (linearKeyDraft !== null) {
      await setLinearKey(linearKeyDraft)
      setLinearStatus(linearKeyDraft.trim() ? 'set' : 'unset')
    }
  }

  async function handleDone() {
    setSaveError(false)
    try {
      await persist(settings)
      onClose()
    } catch (err) {
      console.error('[settings] save', err)
      setSaveError(true)
    }
  }

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2100,
        background: color.scrim,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: `${space[8]}px ${space[5]}px`,
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        style={{
          width: 560,
          maxWidth: '100%',
          background: color.bgRaised,
          borderRadius: radius.lg,
          boxShadow: shadow.modal,
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <div style={{ padding: `${space[7]}px ${space[7]}px ${space[5]}px` }}>
          <div id="settings-modal-title" style={{ ...type.title, color: color.ink }}>
            Settings
          </div>
        </div>

        {loading ? (
          <div
            style={{
              ...type.body,
              color: color.inkSoft,
              textAlign: 'center',
              padding: `${space[8]}px`,
            }}
          >
            Loading settings…
          </div>
        ) : (
          <div style={{ padding: `0 ${space[7]}px` }}>
            {/* ── Appearance ── */}
            <Section label="Appearance">
              <label style={{ ...type.label, color: color.inkSoft }}>Theme</label>
              <div style={{ marginTop: space[2] }}>
                <ThemeControl />
              </div>
            </Section>

            {/* ── Roots ── */}
            <Section label="Roots">
              <RootField
                label="Memory root"
                value={settings.memoryRoot}
                onChange={(v) => {
                  setRoot('memoryRoot', v)
                }}
                onBlur={() => maybeOfferReindex(settings.memoryRoot)}
                onChoose={() => chooseFolder('memoryRoot', settings.memoryRoot)}
              />
              <ReindexRow state={reindex} setState={setReindex} onRebuild={doRebuild} />
              <RootField
                label="Prompts root"
                value={settings.promptsRoot}
                onChange={(v) => setRoot('promptsRoot', v)}
                onChoose={() => chooseFolder('promptsRoot', settings.promptsRoot)}
              />
              <RootField
                label="Skills root"
                value={settings.skillsRoot}
                onChange={(v) => setRoot('skillsRoot', v)}
                onChoose={() => chooseFolder('skillsRoot', settings.skillsRoot)}
              />
              <RootField
                label="Transcripts root"
                value={settings.transcriptsRoot}
                onChange={(v) => setRoot('transcriptsRoot', v)}
                onChoose={() => chooseFolder('transcriptsRoot', settings.transcriptsRoot)}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[3] }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={manualReindex}
                  disabled={reindex.kind === 'rebuilding'}
                >
                  {reindex.kind === 'rebuilding' ? 'Reindexing…' : 'Reindex now'}
                </Button>
                <span style={{ ...type.meta, color: color.inkFaint }}>
                  Rebuild the search index to pick up files added outside Studio.
                </span>
              </div>
            </Section>

            {/* ── Session archive ── */}
            <Section label="Session archive">
              <ArchiveControls
                settings={settings}
                archive={archive}
                cleanup={cleanup}
                onToggle={toggleArchive}
                onChangePolicy={changePolicy}
                onCleanup={doCleanup}
              />
            </Section>

            {/* ── Embedding ── */}
            <Section label="Embedding">
              <label style={{ ...type.label, color: color.inkSoft }}>Embedding API key</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[2] }}>
                <input
                  type={revealed ? 'text' : 'password'}
                  value={revealed ? keyDraft ?? '' : keyDraft !== null ? keyDraft : MASK}
                  placeholder={keyStatus === 'set' ? MASK : 'sk-…'}
                  onChange={(e) => {
                    setKeyDraft(e.target.value)
                  }}
                  onFocus={(e) => {
                    if (keyDraft === null) {
                      // First edit: clear the masked placeholder representation.
                      setKeyDraft('')
                    }
                    e.currentTarget.style.borderColor = color.forest
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = color.line
                  }}
                  style={{
                    flex: 1,
                    ...fieldStyle,
                    fontFamily: font.mono,
                  }}
                />
                <Button variant="tertiary" padding="none" onClick={toggleReveal}>
                  {revealed ? 'Hide' : 'Reveal'}
                </Button>
              </div>
              <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[2] }}>
                {keyDraft !== null
                  ? keyDraft.trim()
                    ? 'Set'
                    : 'Not set'
                  : keyStatus === 'set'
                    ? 'Set'
                    : 'Not set'}
              </div>
            </Section>

            {/* ── Reasoning (TIN-1789) ── */}
            <Section label="Reasoning">
              <label style={{ ...type.label, color: color.inkSoft }}>Gemini API key</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[2] }}>
                <input
                  type={geminiRevealed ? 'text' : 'password'}
                  value={geminiRevealed ? geminiKeyDraft ?? '' : geminiKeyDraft !== null ? geminiKeyDraft : MASK}
                  placeholder={geminiStatus === 'set' ? MASK : 'AIza…'}
                  onChange={(e) => {
                    setGeminiKeyDraft(e.target.value)
                  }}
                  onFocus={(e) => {
                    if (geminiKeyDraft === null) {
                      // First edit: clear the masked placeholder representation.
                      setGeminiKeyDraft('')
                    }
                    e.currentTarget.style.borderColor = color.forest
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = color.line
                  }}
                  style={{
                    flex: 1,
                    ...fieldStyle,
                    fontFamily: font.mono,
                  }}
                />
                <Button variant="tertiary" padding="none" onClick={toggleGeminiReveal}>
                  {geminiRevealed ? 'Hide' : 'Reveal'}
                </Button>
              </div>
              <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[2] }}>
                {geminiKeyDraft !== null
                  ? geminiKeyDraft.trim()
                    ? 'Set'
                    : 'Not set'
                  : geminiStatus === 'set'
                    ? 'Set'
                    : 'Not set'}
              </div>
              <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[1] }}>
                Continuity scoring, contradiction judging, and note summaries use Gemini&apos;s free
                tier when a key is set. Without one, they fall back to a local Ollama model, or
                degrade calmly if neither is available. Stored in your system keychain.
              </div>
            </Section>

            {/* ── Linear ── */}
            <Section label="Linear">
              <label style={{ ...type.label, color: color.inkSoft }}>API key</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[2] }}>
                <input
                  type={linearRevealed ? 'text' : 'password'}
                  value={linearRevealed ? linearKeyDraft ?? '' : linearKeyDraft !== null ? linearKeyDraft : MASK}
                  placeholder={linearStatus === 'set' ? MASK : 'lin_api_…'}
                  onChange={(e) => {
                    setLinearKeyDraft(e.target.value)
                  }}
                  onFocus={(e) => {
                    if (linearKeyDraft === null) {
                      setLinearKeyDraft('')
                    }
                    e.currentTarget.style.borderColor = color.forest
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = color.line
                  }}
                  style={{
                    flex: 1,
                    ...fieldStyle,
                    fontFamily: font.mono,
                  }}
                />
                <Button variant="tertiary" padding="none" onClick={toggleLinearReveal}>
                  {linearRevealed ? 'Hide' : 'Reveal'}
                </Button>
              </div>
              <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[2] }}>
                {linearKeyDraft !== null
                  ? linearKeyDraft.trim()
                    ? 'Set'
                    : 'Not set'
                  : linearStatus === 'set'
                    ? 'Set'
                    : 'Not set'}
              </div>
              <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[1] }}>
                Use a read-scoped personal API key. Studio only reads tickets, never writes.
              </div>
              <div style={{ marginTop: space[4] }}>
                <label style={{ ...type.label, color: color.inkSoft }}>Team</label>
                <select
                  value={linearTeamKey}
                  onChange={(e) => setLinearTeamKey(e.target.value)}
                  style={{
                    display: 'block',
                    marginTop: space[2],
                    ...fieldStyle,
                    fontFamily: font.sans,
                  }}
                >
                  {linearTeams.length === 0 ? (
                    <option value="" disabled>
                      Sync to choose a team
                    </option>
                  ) : (
                    <>
                      <option value="">Default team</option>
                      {linearTeams.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.name}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[3] }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={doLinearSync}
                  disabled={linearSync.kind === 'syncing'}
                >
                  {linearSync.kind === 'syncing' ? 'Syncing…' : 'Sync now'}
                </Button>
                {linearSync.kind === 'idle' && (
                  <span style={{ ...type.meta, color: color.inkFaint }}>Not synced yet.</span>
                )}
                {linearSync.kind === 'syncing' && null}
                {linearSync.kind === 'done' && (
                  <span style={{ ...type.meta, color: color.inkFaint }}>
                    {isJustNow(linearSync.lastSynced)
                      ? 'Last synced just now.'
                      : `Last synced ${relativeTime(linearSync.lastSynced)}.`}
                  </span>
                )}
                {linearSync.kind === 'error' && (
                  <>
                    <span style={{ ...type.meta, color: color.notice }}>
                      Sync could not finish just now.
                    </span>
                    <Button variant="tertiary" tone="notice" padding="none" onClick={doLinearSync}>
                      Try again
                    </Button>
                  </>
                )}
              </div>
            </Section>

            {/* ── Agents ── */}
            <Section label="Agents">
              {settings.agents.length === 0 ? (
                <div style={{ ...type.body, color: color.inkFaint, padding: `${space[2]}px 0` }}>
                  No agents yet. Add one to launch sessions.
                </div>
              ) : (
                settings.agents.map((agent, i) => (
                  <AgentRow
                    key={i}
                    agent={agent}
                    onChange={(patch) => updateAgent(i, patch)}
                    onRemove={() => removeAgent(i)}
                  />
                ))
              )}
              <button
                onClick={addAgent}
                style={{
                  ...type.body,
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  marginTop: space[3],
                  padding: `${space[3]}px ${space[4]}px`,
                  background: 'transparent',
                  border: `1px dashed ${color.line}`,
                  borderRadius: radius.card,
                  color: color.inkSoft,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = color.bgFieldStrong
                  e.currentTarget.style.color = color.ink
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = color.inkSoft
                }}
              >
                + Add agent
              </button>
            </Section>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ padding: `${space[5]}px ${space[7]}px ${space[7]}px` }}>
          {saveError && (
            <div
              style={{
                ...type.body,
                color: color.notice,
                background: color.tanTint,
                borderRadius: radius.md,
                padding: `${space[3]}px ${space[4]}px`,
                marginBottom: space[4],
              }}
            >
              Could not save settings. Your changes are still here.
            </div>
          )}
          <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDone}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: `${space[5]}px 0`, borderTop: `1px solid ${color.hair}` }}>
      <div style={{ ...type.label, color: color.inkSoft, marginBottom: space[4] }}>{label}</div>
      {children}
    </div>
  )
}

// ── Theme control (TIN-1673) ─────────────────────────────────────────────────

/** A calm Light / Dark / System segmented control. */
function ThemeControl() {
  const [pref, setPref] = useState<ThemePref>('system')
  useEffect(() => { setPref(getThemePref()) }, [])

  const choose = (p: ThemePref) => {
    setPref(p)
    setThemePref(p)
  }

  const options: { value: ThemePref; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ]

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        borderRadius: radius.field,
        border: `1px solid ${color.line}`,
        background: color.bgField,
      }}
    >
      {options.map((o) => {
        const active = pref === o.value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => choose(o.value)}
            style={{
              padding: `${space[2]}px ${space[4]}px`,
              borderRadius: radius.md,
              border: 'none',
              background: active ? color.forestWash : 'transparent',
              color: active ? color.forest : color.inkSoft,
              fontFamily: font.sans,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              transition: 'all 0.12s ease',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Root field ─────────────────────────────────────────────────────────────────

function RootField({
  label,
  value,
  onChange,
  onChoose,
  onBlur,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onChoose: () => void
  onBlur?: () => void
}) {
  return (
    <div style={{ marginBottom: space[4] }}>
      <label style={{ ...type.label, color: color.inkSoft }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[2] }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = color.line
            onBlur?.()
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
          style={{ flex: 1, ...fieldStyle, fontFamily: font.mono }}
          spellCheck={false}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={onChoose}
          style={{ flexShrink: 0 }}
        >
          Choose…
        </Button>
      </div>
    </div>
  )
}

// ── Inline reindex row ──────────────────────────────────────────────────────────

function ReindexRow({
  state,
  setState,
  onRebuild,
}: {
  state: Reindex
  setState: (r: Reindex) => void
  onRebuild: () => void
}) {
  if (state.kind === 'idle') return null

  if (state.kind === 'confirm') {
    return (
      <div style={reindexNoticeStyle}>
        <div style={{ ...type.body, color: color.ink }}>Memory root changed.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: space[4], marginTop: space[2] }}>
          <span style={{ ...type.body, color: color.inkSoft }}>Rebuild index now?</span>
          <span style={{ display: 'flex', gap: space[3], marginLeft: 'auto' }}>
            <Button variant="tertiary" onClick={() => setState({ kind: 'stale' })}>
              Not now
            </Button>
            <Button variant="primary" size="sm" onClick={onRebuild}>
              Rebuild
            </Button>
          </span>
        </div>
      </div>
    )
  }

  if (state.kind === 'rebuilding') {
    return (
      <div style={reindexNoticeStyle}>
        <span style={{ ...type.body, color: color.inkSoft }}>Rebuilding index…</span>
      </div>
    )
  }

  if (state.kind === 'done') {
    return (
      <div style={reindexNoticeStyle}>
        <span style={{ ...type.body, color: color.inkSoft }}>Index rebuilt</span>
      </div>
    )
  }

  // stale
  return (
    <div style={reindexNoticeStyle}>
      <span style={{ ...type.body, color: color.notice }}>Index may be out of date.</span>
      <Button
        variant="tertiary"
        tone="notice"
        padding="none"
        onClick={onRebuild}
        style={{ marginLeft: space[3] }}
      >
        Rebuild
      </Button>
    </div>
  )
}

// ── Session archive controls (TIN-1759) ─────────────────────────────────────────

function ArchiveControls({
  settings,
  archive,
  cleanup,
  onToggle,
  onChangePolicy,
  onCleanup,
}: {
  settings: Settings
  archive: ArchiveStatus | null
  cleanup: Cleanup
  onToggle: (enabled: boolean) => void
  onChangePolicy: (policy: RetentionPolicy) => void
  onCleanup: () => void
}) {
  const enabled = settings.archiveEnabled
  const policy: RetentionPolicy =
    settings.retentionPolicy ?? { kind: 'sizeCap', maxBytes: 2_147_483_648 }
  const dim: React.CSSProperties = enabled ? {} : { opacity: 0.5, pointerEvents: 'none' }

  // The size-cap field works in whole-ish GB; convert to/from bytes.
  const capBytes = policy.kind === 'sizeCap' ? policy.maxBytes : 2_147_483_648
  const capGb = capBytes / BYTES_PER_GB
  const capLabel = `${formatGb(capGb)} GB`

  const prunable = archive?.prunablePreview
  const overCap = (archive?.overCapBytes ?? 0) > 0

  return (
    <div>
      {/* Toggle */}
      <label
        style={{ display: 'flex', alignItems: 'flex-start', gap: space[3], cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ marginTop: 2, accentColor: color.forest }}
        />
        <span>
          <span style={{ ...type.body, color: color.ink, display: 'block' }}>
            Keep a durable copy of every session
          </span>
          <span style={{ ...type.meta, color: color.inkFaint, display: 'block', marginTop: space[1] }}>
            Studio copies each session out of Claude Code before it can prune them.
          </span>
        </span>
      </label>

      {!enabled && (
        <div style={{ ...type.meta, color: color.inkSoft, marginTop: space[3] }}>
          Archiving is off. New sessions are not being copied.
        </div>
      )}

      {/* Readout */}
      <div style={{ ...dim, marginTop: space[4] }}>
        <div style={{ ...type.body, color: color.ink }}>
          {archive
            ? `${archive.sessionCount.toLocaleString()} ${archive.sessionCount === 1 ? 'session' : 'sessions'} · ${formatBytes(archive.storedBytes)}`
            : 'No sessions archived yet.'}
        </div>
        {archive && archive.sessionCount > 0 && (
          <div style={{ ...type.meta, color: color.inkFaint, marginTop: space[1] }}>
            {`Oldest ${formatMonthYear(archive.oldestDate)}, newest ${describeNewest(archive.newestDate)}`}
          </div>
        )}

        {/* Retention policy */}
        <div style={{ marginTop: space[4] }}>
          <label style={{ ...type.label, color: color.inkSoft }}>Retention</label>
          <div style={{ marginTop: space[2] }}>
            <RetentionControl policy={policy} onChange={onChangePolicy} />
          </div>
        </div>

        {/* Size-cap inline field */}
        {policy.kind === 'sizeCap' && (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[3] }}
          >
            <input
              type="number"
              min={1}
              step={1}
              value={formatGb(capGb)}
              onChange={(e) => {
                const gb = parseFloat(e.target.value)
                if (!Number.isFinite(gb) || gb <= 0) return
                onChangePolicy({ kind: 'sizeCap', maxBytes: Math.round(gb * BYTES_PER_GB) })
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
              onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
              style={{ ...fieldStyle, width: 96, fontFamily: font.mono }}
            />
            <span style={{ ...type.meta, color: color.inkFaint }}>GB stored</span>
          </div>
        )}

        {/* Standing over-cap / under-cap line (tan notice, never red) */}
        <div style={{ ...type.meta, color: color.inkSoft, marginTop: space[4] }}>
          {policy.kind === 'keepAll'
            ? 'Keeping every session. Nothing is pruned.'
            : overCap && prunable && prunable.count > 0
              ? `Will free ${formatBytes(prunable.bytes)} by archiving the ${prunable.count} oldest ${prunable.count === 1 ? 'session' : 'sessions'} back to ${capLabel}.`
              : prunable && prunable.count > 0
                ? `Will free ${formatBytes(prunable.bytes)} by archiving the ${prunable.count} oldest ${prunable.count === 1 ? 'session' : 'sessions'}.`
                : policy.kind === 'sizeCap'
                  ? `Nothing to free up. You’re under ${capLabel}.`
                  : 'Nothing to free up.'}
        </div>

        {/* Free up space */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[3] }}>
          <Button
            variant="primary"
            size="sm"
            onClick={onCleanup}
            disabled={
              cleanup.kind === 'running' || !prunable || prunable.count === 0
            }
          >
            {cleanup.kind === 'running' ? 'Freeing space…' : 'Free up space'}
          </Button>
          {cleanup.kind === 'done' && (
            <span style={{ ...type.meta, color: color.inkFaint }}>
              {`Archive trimmed to ${formatBytes(cleanup.newStoredBytes)}.`}
            </span>
          )}
          {cleanup.kind === 'error' && (
            <>
              <span style={{ ...type.meta, color: color.notice }}>
                Could not free space just now.
              </span>
              <Button variant="tertiary" tone="notice" padding="none" onClick={onCleanup}>
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Keep everything · Size cap · Keep N months. Same idiom as ThemeControl. */
function RetentionControl({
  policy,
  onChange,
}: {
  policy: RetentionPolicy
  onChange: (policy: RetentionPolicy) => void
}) {
  const options: { value: RetentionPolicy['kind']; label: string }[] = [
    { value: 'keepAll', label: 'Keep everything' },
    { value: 'sizeCap', label: 'Size cap' },
    { value: 'keepMonths', label: 'Keep N months' },
  ]

  const choose = (kind: RetentionPolicy['kind']) => {
    if (kind === policy.kind) return
    if (kind === 'keepAll') onChange({ kind: 'keepAll' })
    else if (kind === 'sizeCap') onChange({ kind: 'sizeCap', maxBytes: 2_147_483_648 })
    else onChange({ kind: 'keepMonths', months: 6 })
  }

  return (
    <div
      role="radiogroup"
      aria-label="Retention policy"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        borderRadius: radius.field,
        border: `1px solid ${color.line}`,
        background: color.bgField,
      }}
    >
      {options.map((o) => {
        const active = policy.kind === o.value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => choose(o.value)}
            style={{
              padding: `${space[2]}px ${space[4]}px`,
              borderRadius: radius.md,
              border: 'none',
              background: active ? color.forestWash : 'transparent',
              color: active ? color.forest : color.inkSoft,
              fontFamily: font.sans,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              transition: 'all 0.12s ease',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Archive formatting helpers ───────────────────────────────────────────────────

/** Human byte size: B / KB / MB / GB with one decimal above MB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return `${formatGb(gb)} GB`
}

/** Trim a GB value to at most one decimal, dropping a trailing .0. */
function formatGb(gb: number): string {
  const rounded = Math.round(gb * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** YYYY-MM-DD → "Month YYYY" (e.g. "December 2025"). */
function formatMonthYear(iso: string): string {
  const d = parseIsoDate(iso)
  if (!d) return iso
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** "today" when the ISO date is today, else "Month YYYY". */
function describeNewest(iso: string): string {
  const d = parseIsoDate(iso)
  if (!d) return iso
  const now = new Date()
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return 'today'
  }
  return formatMonthYear(iso)
}

function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

// ── Agent row ───────────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  onChange,
  onRemove,
}: {
  agent: Agent
  onChange: (patch: Partial<Agent>) => void
  onRemove: () => void
}) {
  return (
    <div
      style={{
        padding: `${space[4]}px`,
        marginBottom: space[3],
        background: color.bgCard,
        border: `1px solid ${color.hairSoft}`,
        borderRadius: radius.card,
        display: 'flex',
        flexDirection: 'column',
        gap: space[3],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space[3] }}>
        <AgentField
          label="Name"
          value={agent.name}
          mono={false}
          onChange={(v) => onChange({ name: v })}
        />
        <Button
          variant="tertiary"
          padding="none"
          onClick={onRemove}
          style={{ flexShrink: 0, alignSelf: 'flex-end' }}
        >
          Remove
        </Button>
      </div>
      <AgentField
        label="Command"
        value={agent.command}
        mono
        onChange={(v) => onChange({ command: v })}
      />
      <AgentField
        label="Arguments"
        value={agent.args.join(' ')}
        mono
        placeholder="--print --model opus"
        onChange={(v) => onChange({ args: v.split(/\s+/).filter(Boolean) })}
      />
      <AgentField
        label="Default working directory"
        value={agent.cwd}
        mono
        onChange={(v) => onChange({ cwd: v })}
      />
    </div>
  )
}

function AgentField({
  label,
  value,
  onChange,
  mono,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono: boolean
  placeholder?: string
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: space[1] }}>
      <label style={{ ...type.label, color: color.inkFaint }}>{label}</label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
        onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
        spellCheck={false}
        style={{
          ...fieldStyle,
          fontFamily: mono ? font.mono : font.sans,
          fontWeight: label === 'Name' ? 600 : 400,
        }}
      />
    </div>
  )
}

// ── Linear time helpers ─────────────────────────────────────────────────────────

/** Returns true if the ISO timestamp is within the last 60 seconds. */
function isJustNow(iso: string): boolean {
  try {
    return Date.now() - new Date(iso).getTime() < 60_000
  } catch {
    return false
  }
}

/** Human-readable relative time from an ISO timestamp. */
function relativeTime(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 1) return 'just now'
    if (diffMin === 1) return '1 minute ago'
    if (diffMin < 60) return `${diffMin} minutes ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr === 1) return '1 hour ago'
    if (diffHr < 24) return `${diffHr} hours ago`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay === 1) return 'yesterday'
    return `${diffDay} days ago`
  } catch {
    return iso
  }
}

// ── Shared inline styles (composed from tokens) ─────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: `${space[2]}px ${space[3]}px`,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  background: color.bgField,
  color: color.ink,
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

const reindexNoticeStyle: React.CSSProperties = {
  background: 'rgba(155,123,90,0.08)',
  borderRadius: radius.md,
  padding: `${space[3]}px ${space[4]}px`,
  marginTop: `-${space[2]}px`,
  marginBottom: space[4],
}
