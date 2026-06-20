'use client'

/**
 * Launcher.tsx — the Prompt launcher + context picker (TIN-1633, the north star).
 *
 * A single composition canvas, three columns, one button:
 *   1. Prompts        — browse + search the prompts root, select one.
 *   2. Preview+Context — the prompt rendered as serif reading body, plus the three
 *                        context pickers (Persona/skills, Memory, Project files);
 *                        every added item shows as a removable chip grouped by kind.
 *   3. Run            — agent selector, working-dir selector, context tally, and
 *                        the big primary Run button (the gravity well, ⌘↩).
 *
 * Run composes the bundle (prompt body + selected context, light headers), writes
 * it to a temp file, and spawns the chosen agent in the TerminalPanel with the
 * bundle injected. Per-prompt memory restores the last setup on re-select.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import MarkdownContent from './MarkdownContent'
import { color, radius, space, font, type as typeRamp, shadow } from '@/lib/tokens'
import { getSettings, type Settings, type Agent } from '@/lib/settings'
import {
  listPrompts,
  listSkills,
  readPrompt,
  stripFrontmatter,
  buildBundle,
  writeBundle,
  composeAgentArgs,
  getSetup,
  saveSetup,
  clearSetup,
  getRecentDirs,
  pushRecentDir,
  filename,
  type PromptEntry,
  type SkillEntry,
  type ContextItem,
  type ContextKind,
} from '@/lib/launcher'
import type { MemorySearchResult } from '@/lib/types'
import type { RunRequest } from './TerminalPanel'

// ── Props ──────────────────────────────────────────────────────────────────────

interface LauncherProps {
  open: boolean
  onClose: () => void
  /** Spawn the composed launch in the terminal (wired to TerminalPanel.runRef). */
  onRun: (req: RunRequest) => void
  /** Open Settings (for the "Settings" links in empty states). */
  onOpenSettings: () => void
}

// ── Search client (reuse the existing FTS command, same shape as page.tsx) ──────

interface SearchApiResponse {
  results: MemorySearchResult[]
  types: string[]
  projects: string[]
}

async function fetchMemorySearch(q: string): Promise<MemorySearchResult[]> {
  try {
    const data = await invoke<SearchApiResponse>('search', {
      payload: { q, typeFilter: '', projectFilter: '', rebuild: false },
    })
    return data.results ?? []
  } catch {
    return []
  }
}

// ── Shared inline styles ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  background: color.bgField,
  color: color.ink,
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: font.sans,
}

const sectionLabel: React.CSSProperties = {
  ...typeRamp.label,
  color: color.inkSoft,
}

// ── Removable context chip ──────────────────────────────────────────────────────

const KIND_TINT: Record<ContextKind, { bg: string; fg: string }> = {
  skill: { bg: color.forestTint, fg: color.forest },
  memory: { bg: color.tanTint, fg: color.tan },
  file: { bg: color.neutralTint, fg: color.inkSoft },
}

function ContextChip({ item, onRemove }: { item: ContextItem; onRemove: () => void }) {
  const tint = KIND_TINT[item.kind]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space[2],
        padding: '3px 8px',
        borderRadius: radius.chip,
        background: tint.bg,
        color: tint.fg,
        fontSize: 11,
        fontWeight: 500,
        fontFamily: font.sans,
        maxWidth: '100%',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
      <button
        onClick={onRemove}
        aria-label={`Remove ${item.label}`}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: tint.fg,
          padding: 0,
          display: 'flex',
          opacity: 0.7,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  )
}

// ── Picker popovers (skills / memory / files) ───────────────────────────────────

type PickerKind = 'skills' | 'memory' | 'files' | null

// ── Main component ──────────────────────────────────────────────────────────────

export default function Launcher({ open, onClose, onRun, onOpenSettings }: LauncherProps) {
  const [settings, setSettings] = useState<Settings | null>(null)

  // Prompts column
  const [prompts, setPrompts] = useState<PromptEntry[]>([])
  const [promptQuery, setPromptQuery] = useState('')
  const [loadingPrompts, setLoadingPrompts] = useState(false)

  // Selected prompt + its body
  const [selected, setSelected] = useState<PromptEntry | null>(null)
  const [promptBody, setPromptBody] = useState('')
  const [loadingBody, setLoadingBody] = useState(false)

  // Context bundle (the chips)
  const [context, setContext] = useState<ContextItem[]>([])
  const [restored, setRestored] = useState(false)

  // Run column
  const [agentName, setAgentName] = useState('')
  const [cwd, setCwd] = useState('')
  const [recentDirs, setRecentDirs] = useState<string[]>([])
  const [launching, setLaunching] = useState(false)

  // Active picker popover
  const [picker, setPicker] = useState<PickerKind>(null)

  const bodyByPathRef = useRef<Record<string, string>>({})

  // ── Load settings + prompts when opened ──

  useEffect(() => {
    if (!open) return
    setRecentDirs(getRecentDirs())
    ;(async () => {
      try {
        const s = await getSettings()
        setSettings(s)
        setLoadingPrompts(true)
        const list = await listPrompts(s.promptsRoot)
        setPrompts(list)
      } catch {
        setPrompts([])
      } finally {
        setLoadingPrompts(false)
      }
    })()
  }, [open])

  // ── Select a prompt: load body, restore remembered setup ──

  const selectPrompt = useCallback(
    async (p: PromptEntry, agents: Agent[]) => {
      setSelected(p)
      setPicker(null)
      setLoadingBody(true)

      // Restore remembered setup for this prompt, if any.
      const setup = getSetup(p.path)
      if (setup) {
        setContext(setup.context)
        setAgentName(setup.agentName)
        setCwd(setup.cwd)
        setRestored(true)
      } else {
        setContext([])
        setRestored(false)
        // Default agent + its cwd.
        const first = agents[0]
        setAgentName(first?.name ?? '')
        setCwd(first?.cwd ?? '')
      }

      try {
        const cached = bodyByPathRef.current[p.path]
        const raw = cached ?? (await readPrompt(p.path))
        bodyByPathRef.current[p.path] = raw
        setPromptBody(raw)
      } catch {
        setPromptBody('')
      } finally {
        setLoadingBody(false)
      }
    },
    [],
  )

  // ── Context add / remove ──

  const addContext = useCallback((item: ContextItem) => {
    setRestored(false)
    setContext((prev) => (prev.some((c) => c.path === item.path) ? prev : [...prev, item]))
  }, [])

  const removeContext = useCallback((path: string) => {
    setRestored(false)
    setContext((prev) => prev.filter((c) => c.path !== path))
  }, [])

  const startFresh = useCallback(() => {
    if (selected) clearSetup(selected.path)
    setContext([])
    setRestored(false)
    const first = settings?.agents[0]
    setAgentName(first?.name ?? '')
    setCwd(first?.cwd ?? '')
  }, [selected, settings])

  // ── Working dir picker ──

  const pickDir = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, defaultPath: cwd || undefined })
      if (typeof picked === 'string') setCwd(picked)
    } catch {
      /* user cancelled */
    }
  }, [cwd])

  // ── Run ──

  const agents = settings?.agents ?? []
  const activeAgent = agents.find((a) => a.name === agentName) ?? null
  const canRun = !!selected && !!activeAgent && !!cwd && !launching

  const handleRun = useCallback(async () => {
    if (!selected || !activeAgent || !cwd) return
    setLaunching(true)
    try {
      // Remember this setup for the prompt before launching.
      saveSetup(selected.path, { context, agentName, cwd })
      pushRecentDir(cwd)
      setRecentDirs(getRecentDirs())

      const bundle = await buildBundle(selected.name, promptBody, context)
      const bundlePath = await writeBundle(bundle)
      const args = composeAgentArgs(activeAgent, bundlePath)

      onRun({
        label: activeAgent.name,
        command: activeAgent.command,
        args,
        cwd,
        bundle,
      })
      onClose()
    } catch {
      // Stay open on failure; the terminal isn't shown so nothing is half-live.
    } finally {
      setLaunching(false)
    }
  }, [selected, activeAgent, cwd, context, agentName, promptBody, onRun, onClose])

  // ── Keyboard: ⌘↩ runs, Esc closes ──

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
      if (e.key === 'Escape') {
        e.preventDefault()
        if (picker) setPicker(null)
        else onClose()
        return
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        if (canRun) handleRun()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, picker, canRun, handleRun, onClose])

  if (!open) return null

  // ── Derived ──

  const filteredPrompts = promptQuery
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(promptQuery.toLowerCase()) ||
          p.description.toLowerCase().includes(promptQuery.toLowerCase()),
      )
    : prompts

  const previewBody = stripFrontmatter(promptBody).trim()

  const tally = (['skill', 'memory', 'file'] as ContextKind[])
    .map((k) => {
      const n = context.filter((c) => c.kind === k).length
      const noun =
        k === 'skill' ? (n === 1 ? 'skill' : 'skills') : k === 'memory' ? 'memory' : n === 1 ? 'file' : 'files'
      return n > 0 ? `${n} ${noun}` : null
    })
    .filter(Boolean)
    .join(' · ')

  const noPromptsRoot = settings !== null && !settings.promptsRoot.trim()
  const noAgents = settings !== null && agents.length === 0

  // ── Render ──

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: color.bgApp,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top bar — persists with ← return; center reads "Launch" */}
      <header
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${color.hair}`,
          padding: '0 20px',
          gap: space[5],
          flexShrink: 0,
          background: color.bgApp,
        }}
      >
        <button
          onClick={onClose}
          style={{
            fontFamily: "'Fraunces', 'Georgia', serif",
            fontSize: 15,
            fontWeight: 600,
            color: color.forest,
            letterSpacing: '-0.01em',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            minWidth: 120,
            textAlign: 'left',
          }}
        >
          ← Agent Studio
        </button>
        <div style={{ flex: 1, textAlign: 'center', ...typeRamp.title, color: color.ink }}>
          Launch
        </div>
        <div style={{ minWidth: 120 }} />
      </header>

      {/* Body: three columns */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Column 1 — Prompts ── */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            borderRight: `1px solid ${color.hairSoft}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: space[4], borderBottom: `1px solid ${color.hairSoft}` }}>
            <div style={{ ...sectionLabel, marginBottom: space[2] }}>Prompts</div>
            <input
              placeholder="Search prompts…"
              value={promptQuery}
              onChange={(e) => setPromptQuery(e.target.value)}
              style={fieldStyle}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingPrompts ? (
              <div style={{ padding: space[5], ...typeRamp.meta, color: color.inkSoft }}>Loading…</div>
            ) : noPromptsRoot ? (
              <div style={{ padding: space[5], ...typeRamp.meta, color: color.inkFaint }}>
                Set a prompts root in{' '}
                <button onClick={onOpenSettings} style={linkBtn}>
                  Settings
                </button>
                .
              </div>
            ) : filteredPrompts.length === 0 ? (
              <div style={{ padding: space[5], ...typeRamp.meta, color: color.inkFaint }}>
                {prompts.length === 0 ? 'No prompts here yet.' : 'Nothing matched.'}
              </div>
            ) : (
              filteredPrompts.map((p) => {
                const active = selected?.path === p.path
                return (
                  <button
                    key={p.path}
                    onClick={() => selectPrompt(p, agents)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 16px',
                      background: active ? color.forestWash : 'transparent',
                      borderLeft: active ? `2px solid ${color.forest}` : '2px solid transparent',
                      border: 'none',
                      borderBottom: `1px solid ${color.hairSoft}`,
                      cursor: 'pointer',
                      fontFamily: font.sans,
                    }}
                  >
                    <div style={{ ...typeRamp.body, color: color.ink, fontWeight: 600 }}>{p.name}</div>
                    {p.description && (
                      <div
                        style={{
                          ...typeRamp.meta,
                          color: color.inkFaint,
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.description}
                      </div>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* ── Column 2 — Preview & Context ── */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', position: 'relative' }}>
          {!selected ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                ...typeRamp.body,
                color: color.inkFaint,
              }}
            >
              Pick a prompt to begin.
            </div>
          ) : (
            <div style={{ maxWidth: 760, margin: '0 auto', padding: `${space[8]}px ${space[8]}px` }}>
              {/* Prompt title + restore line */}
              <div style={{ marginBottom: space[5] }}>
                <h1
                  style={{
                    fontFamily: font.serif,
                    fontSize: 26,
                    fontWeight: 600,
                    color: color.ink,
                    margin: 0,
                    lineHeight: 1.25,
                  }}
                >
                  {selected.name}
                </h1>
                {restored && (
                  <div
                    style={{
                      ...typeRamp.meta,
                      color: color.inkFaint,
                      marginTop: space[2],
                      display: 'flex',
                      alignItems: 'center',
                      gap: space[3],
                    }}
                  >
                    Restored your last setup.
                    <button onClick={startFresh} style={linkBtn}>
                      Start fresh
                    </button>
                  </div>
                )}
              </div>

              {/* Serif reading body */}
              {loadingBody ? (
                <div style={{ ...typeRamp.body, color: color.inkSoft }}>Reading…</div>
              ) : previewBody ? (
                <MarkdownContent content={previewBody} />
              ) : (
                <div style={{ ...typeRamp.body, color: color.inkFaint }}>
                  This prompt has no body. Its context still launches.
                </div>
              )}

              {/* ── Context rule ── */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: space[4],
                  margin: `${space[8]}px 0 ${space[5]}px`,
                }}
              >
                <span style={sectionLabel}>Context</span>
                <span style={{ flex: 1, height: 1, background: color.hair }} />
              </div>

              {/* Pickers */}
              <div style={{ display: 'flex', gap: space[3], flexWrap: 'wrap', marginBottom: space[5] }}>
                <PickerButton label="Persona / skills" onClick={() => setPicker(picker === 'skills' ? null : 'skills')} active={picker === 'skills'} />
                <PickerButton label="Memory" onClick={() => setPicker(picker === 'memory' ? null : 'memory')} active={picker === 'memory'} />
                <PickerButton label="Project files" onClick={() => setPicker(picker === 'files' ? null : 'files')} active={picker === 'files'} />
              </div>

              {/* Active picker surface */}
              {picker === 'skills' && (
                <SkillsPicker
                  skillsRoot={settings?.skillsRoot ?? ''}
                  selected={context}
                  onAdd={addContext}
                  onRemove={removeContext}
                />
              )}
              {picker === 'memory' && (
                <MemoryPicker selected={context} onAdd={addContext} onRemove={removeContext} />
              )}
              {picker === 'files' && (
                <FilesPicker cwd={cwd} selected={context} onAdd={addContext} />
              )}

              {/* Chips grouped by kind */}
              {context.length > 0 && (
                <div style={{ marginTop: space[5], display: 'flex', flexDirection: 'column', gap: space[3] }}>
                  {(['skill', 'memory', 'file'] as ContextKind[]).map((kind) => {
                    const items = context.filter((c) => c.kind === kind)
                    if (items.length === 0) return null
                    return (
                      <div key={kind} style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
                        {items.map((item) => (
                          <ContextChip key={item.path} item={item} onRemove={() => removeContext(item.path)} />
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Column 3 — Run console ── */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            borderLeft: `1px solid ${color.hairSoft}`,
            background: color.bgRaised,
            display: 'flex',
            flexDirection: 'column',
            padding: space[5],
            gap: space[5],
            overflowY: 'auto',
          }}
        >
          {/* Agent */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <label style={sectionLabel}>Agent</label>
            {noAgents ? (
              <div
                style={{
                  ...typeRamp.meta,
                  color: color.notice,
                  background: color.tanTint,
                  borderRadius: radius.md,
                  padding: '6px 10px',
                }}
              >
                Add an agent in{' '}
                <button onClick={onOpenSettings} style={{ ...linkBtn, color: color.notice }}>
                  Settings
                </button>{' '}
                to run.
              </div>
            ) : (
              <select
                value={agentName}
                onChange={(e) => {
                  setAgentName(e.target.value)
                  const a = agents.find((x) => x.name === e.target.value)
                  if (a?.cwd && !cwd) setCwd(a.cwd)
                }}
                style={{ ...fieldStyle, cursor: 'pointer' }}
              >
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Working directory */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <label style={sectionLabel}>Working directory</label>
            <button onClick={pickDir} style={{ ...fieldStyle, cursor: 'pointer', textAlign: 'left', ...typeRamp.mono, fontSize: 11, color: cwd ? color.ink : color.inkFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cwd || 'Choose…'}
            </button>
            {recentDirs.filter((d) => d !== cwd).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {recentDirs
                  .filter((d) => d !== cwd)
                  .slice(0, 4)
                  .map((d) => (
                    <button
                      key={d}
                      onClick={() => setCwd(d)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        padding: '2px 4px',
                        ...typeRamp.mono,
                        fontSize: 10,
                        color: color.inkFaint,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {filename(d)}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Context tally */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <label style={sectionLabel}>Context</label>
            <div style={{ ...typeRamp.meta, color: color.inkSoft }}>
              {tally || 'Nothing added yet.'}
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {/* Run — the gravity well */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <button
              onClick={handleRun}
              disabled={!canRun}
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: radius.md,
                border: 'none',
                background: canRun ? color.forest : 'rgba(62,86,65,0.40)',
                color: '#fff',
                fontFamily: font.sans,
                fontSize: 15,
                fontWeight: 600,
                cursor: canRun ? 'pointer' : 'default',
                boxShadow: canRun ? '0 6px 20px rgba(62,86,65,0.30)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space[3],
                transition: 'background 0.15s ease, box-shadow 0.15s ease',
              }}
            >
              {launching ? 'Starting…' : 'Run'}
              <span
                style={{
                  ...typeRamp.mono,
                  fontSize: 11,
                  opacity: 0.8,
                  background: 'rgba(255,255,255,0.15)',
                  borderRadius: radius.sm,
                  padding: '1px 5px',
                }}
              >
                ⌘↩
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────────

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: color.forest,
  textDecoration: 'underline',
  fontFamily: font.sans,
  fontSize: 'inherit',
}

function PickerButton({ label, onClick, active }: { label: string; onClick: () => void; active: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: radius.md,
        border: `1px solid ${active ? color.forestLine : color.line}`,
        background: active ? color.forestWash : color.bgField,
        color: active ? color.forest : color.inkSoft,
        ...typeRamp.body,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

const popoverStyle: React.CSSProperties = {
  border: `1px solid ${color.hair}`,
  borderRadius: radius.card,
  background: color.bgRaised,
  boxShadow: shadow.toast,
  padding: space[3],
  maxHeight: 280,
  overflowY: 'auto',
  marginBottom: space[3],
}

function pickerRowStyle(active: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 10px',
    borderRadius: radius.md,
    border: 'none',
    background: active ? color.forestWash : 'transparent',
    cursor: 'pointer',
    fontFamily: font.sans,
  }
}

function SkillsPicker({
  skillsRoot,
  selected,
  onAdd,
  onRemove,
}: {
  skillsRoot: string
  selected: ContextItem[]
  onAdd: (item: ContextItem) => void
  onRemove: (path: string) => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        setSkills(await listSkills(skillsRoot))
      } catch {
        setSkills([])
      } finally {
        setLoading(false)
      }
    })()
  }, [skillsRoot])

  const filtered = query
    ? skills.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    : skills

  return (
    <div style={popoverStyle}>
      <input
        placeholder="Filter skills…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ ...fieldStyle, marginBottom: space[3] }}
      />
      {loading ? (
        <div style={{ ...typeRamp.meta, color: color.inkSoft, padding: '4px 10px' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...typeRamp.meta, color: color.inkFaint, padding: '4px 10px' }}>
          {skills.length === 0 ? 'No skills in the skills root.' : 'Nothing matched.'}
        </div>
      ) : (
        filtered.map((s) => {
          const isOn = selected.some((c) => c.path === s.path)
          return (
            <button
              key={s.path}
              onClick={() => (isOn ? onRemove(s.path) : onAdd({ kind: 'skill', path: s.path, label: s.name }))}
              style={pickerRowStyle(isOn)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
                <span style={{ ...typeRamp.body, color: color.ink, fontWeight: isOn ? 600 : 400 }}>{s.name}</span>
                {isOn && <span style={{ ...typeRamp.micro, color: color.forest }}>added</span>}
              </div>
              {s.description && (
                <div style={{ ...typeRamp.meta, color: color.inkFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.description}
                </div>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

function MemoryPicker({
  selected,
  onAdd,
  onRemove,
}: {
  selected: ContextItem[]
  onAdd: (item: ContextItem) => void
  onRemove: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const run = useCallback((q: string) => {
    setSearching(true)
    fetchMemorySearch(q).then((r) => {
      setResults(r)
      setSearching(false)
    })
  }, [])

  useEffect(() => {
    run('')
  }, [run])

  const onChange = (q: string) => {
    setQuery(q)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => run(q), 250)
  }

  return (
    <div style={popoverStyle}>
      <input
        placeholder="Search memory…"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...fieldStyle, marginBottom: space[3] }}
      />
      {searching ? (
        <div style={{ ...typeRamp.meta, color: color.inkSoft, padding: '4px 10px' }}>Searching…</div>
      ) : results.length === 0 ? (
        <div style={{ ...typeRamp.meta, color: color.inkFaint, padding: '4px 10px' }}>Nothing matched.</div>
      ) : (
        results.map((r) => {
          const isOn = selected.some((c) => c.path === r.path)
          return (
            <button
              key={r.path}
              onClick={() => (isOn ? onRemove(r.path) : onAdd({ kind: 'memory', path: r.path, label: r.name }))}
              style={pickerRowStyle(isOn)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
                <span style={{ ...typeRamp.body, color: color.ink, fontWeight: isOn ? 600 : 400 }}>{r.name}</span>
                {isOn && <span style={{ ...typeRamp.micro, color: color.tan }}>added</span>}
              </div>
              {r.excerpt && (
                <div style={{ ...typeRamp.meta, color: color.inkFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.excerpt}
                </div>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

function FilesPicker({
  cwd,
  selected,
  onAdd,
}: {
  cwd: string
  selected: ContextItem[]
  onAdd: (item: ContextItem) => void
}) {
  const pick = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        defaultPath: cwd || undefined,
      })
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
      for (const p of paths) {
        if (typeof p === 'string') onAdd({ kind: 'file', path: p, label: filename(p) })
      }
    } catch {
      /* cancelled */
    }
  }, [cwd, onAdd])

  return (
    <div style={popoverStyle}>
      <div style={{ ...typeRamp.meta, color: color.inkSoft, marginBottom: space[3] }}>
        Add files from the working directory or anywhere on disk.
      </div>
      <button onClick={pick} style={{ ...fieldStyle, cursor: 'pointer', textAlign: 'left', color: color.forest }}>
        Browse files…
      </button>
      {selected.filter((c) => c.kind === 'file').length > 0 && (
        <div style={{ ...typeRamp.meta, color: color.inkFaint, marginTop: space[3] }}>
          {selected.filter((c) => c.kind === 'file').length} file(s) added. Remove from the chips below.
        </div>
      )}
    </div>
  )
}
