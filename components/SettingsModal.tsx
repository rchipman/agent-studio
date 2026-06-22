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
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme'
import {
  getSettings,
  setSettings,
  rebuildIndex,
  setEmbeddingKey,
  embeddingKeyStatus,
  revealEmbeddingKey,
  type Settings,
  type Agent,
  type EmbeddingKeyStatus,
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
}

const MASK = '••••••••••••'

// Reindex flow state for the memory-root row.
type Reindex =
  | { kind: 'idle' }
  | { kind: 'confirm' } // root changed, inline "Rebuild index now?"
  | { kind: 'rebuilding' }
  | { kind: 'done' } // "Index rebuilt" for a beat
  | { kind: 'stale' } // deferred: "Index may be out of date."

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState(false)
  const [settings, setSettingsState] = useState<Settings>(EMPTY_SETTINGS)
  const [initialMemoryRoot, setInitialMemoryRoot] = useState('')

  // Embedding key
  const [keyStatus, setKeyStatus] = useState<EmbeddingKeyStatus>('unset')
  const [keyDraft, setKeyDraft] = useState<string | null>(null) // null = untouched
  const [revealed, setRevealed] = useState(false)

  const [reindex, setReindex] = useState<Reindex>({ kind: 'idle' })

  // ── Load on open ──
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setSaveError(false)
    setReindex({ kind: 'idle' })
    setKeyDraft(null)
    setRevealed(false)
    ;(async () => {
      try {
        const [s, status] = await Promise.all([getSettings(), embeddingKeyStatus()])
        if (cancelled) return
        setSettingsState(s)
        setInitialMemoryRoot(s.memoryRoot)
        setKeyStatus(status)
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
                <button
                  onClick={toggleReveal}
                  style={textBtnStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.color = color.ink)}
                  onMouseLeave={(e) => (e.currentTarget.style.color = color.inkSoft)}
                >
                  {revealed ? 'Hide' : 'Reveal'}
                </button>
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
            <button
              onClick={onClose}
              style={secondaryBtnStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = color.bgFieldStrong)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Cancel
            </button>
            <button
              onClick={handleDone}
              style={primaryBtnStyle}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.92')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            >
              Done
            </button>
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
        <button
          onClick={onChoose}
          style={chooseBtnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = color.bgFieldStrong)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          Choose…
        </button>
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
            <button
              onClick={() => setState({ kind: 'stale' })}
              style={textBtnStyle}
              onMouseEnter={(e) => (e.currentTarget.style.color = color.ink)}
              onMouseLeave={(e) => (e.currentTarget.style.color = color.inkSoft)}
            >
              Not now
            </button>
            <button onClick={onRebuild} style={smallPrimaryBtnStyle}>
              Rebuild
            </button>
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
      <button
        onClick={onRebuild}
        style={{ ...textBtnStyle, color: color.notice, marginLeft: space[3] }}
      >
        Rebuild
      </button>
    </div>
  )
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
        <button
          onClick={onRemove}
          style={{ ...textBtnStyle, flexShrink: 0, alignSelf: 'flex-end', paddingBottom: space[2] }}
          onMouseEnter={(e) => (e.currentTarget.style.color = color.ink)}
          onMouseLeave={(e) => (e.currentTarget.style.color = color.inkSoft)}
        >
          Remove
        </button>
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

const chooseBtnStyle: React.CSSProperties = {
  ...type.body,
  flexShrink: 0,
  background: 'transparent',
  color: color.inkSoft,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  padding: `${space[2]}px ${space[4]}px`,
  cursor: 'pointer',
}

const textBtnStyle: React.CSSProperties = {
  ...type.body,
  background: 'transparent',
  border: 'none',
  color: color.inkSoft,
  cursor: 'pointer',
  padding: 0,
}

const primaryBtnStyle: React.CSSProperties = {
  background: color.forest,
  color: '#fff',
  border: 'none',
  borderRadius: radius.md,
  padding: `7px ${space[5]}px`,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: font.sans,
  cursor: 'pointer',
}

const smallPrimaryBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  padding: `${space[1]}px ${space[4]}px`,
  fontSize: 12,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: color.inkSoft,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  padding: `7px ${space[5]}px`,
  fontSize: 13,
  fontFamily: font.sans,
  cursor: 'pointer',
}

const reindexNoticeStyle: React.CSSProperties = {
  background: 'rgba(155,123,90,0.08)',
  borderRadius: radius.md,
  padding: `${space[3]}px ${space[4]}px`,
  marginTop: `-${space[2]}px`,
  marginBottom: space[4],
}
