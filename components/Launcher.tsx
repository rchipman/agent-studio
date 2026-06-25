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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import MarkdownContent from './MarkdownContent'
import Button from '@/components/Button'
import { color, radius, space, font, type as typeRamp, shadow } from '@/lib/tokens'
import { slugify } from '@/lib/slug'
import { getSettings, type Settings, type Agent } from '@/lib/settings'
import {
  listPrompts,
  listSkills,
  readPrompt,
  writePrompt,
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
  parseFrontmatterContext,
  parseFrontmatterSystemFacts,
  resolveContextRef,
  contextItemToRef,
  resolveFacts,
  defaultSystemFacts,
  systemFactsToList,
  systemFactsFromList,
  SYSTEM_FACT_ORDER,
  type PromptEntry,
  type SkillEntry,
  type ContextItem,
  type ContextKind,
  type SystemFacts,
} from '@/lib/launcher'
import type { MemorySearchResult } from '@/lib/types'
import type { RunRequest } from './TerminalPanel'

// Lazy-mount the real editor (Milkdown/Crepe) only when compose-mode opens it.
const MarkdownEditor = dynamic(() => import('@/components/MarkdownEditor'), { ssr: false })

// ── Props ──────────────────────────────────────────────────────────────────────

interface LauncherProps {
  open: boolean
  onClose: () => void
  /** Spawn the composed launch in the terminal (wired to TerminalPanel.runRef). */
  onRun: (req: RunRequest) => void
  /** Open Settings (for the "Settings" links in empty states). */
  onOpenSettings: () => void
  /** Render as a full view inside the content column (no fixed scrim, no own
   *  header — the persistent top bar owns the `Launch` title). TIN-1707. */
  asView?: boolean
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

function ContextChip({
  item,
  onRemove,
  onToggleSystem,
}: {
  item: ContextItem
  onRemove: () => void
  /** Move this chip between the user tier and the system tier (TIN-1764). */
  onToggleSystem: () => void
}) {
  const [hover, setHover] = useState(false)
  const isSystem = !!item.system
  // System-tier chips render in the neutral treatment regardless of kind.
  const tint = isSystem ? { bg: color.neutralTint, fg: color.inkSoft } : KIND_TINT[item.kind]
  const toggleGlyph = isSystem ? '↥' : '↧'
  const toggleTitle = isSystem ? 'return to prompt' : 'send to system'

  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
      {/* Leading tier toggle — appears on hover/focus. */}
      <button
        onClick={onToggleSystem}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        title={toggleTitle}
        aria-label={`${toggleTitle}: ${item.label}`}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: tint.fg,
          opacity: hover ? 0.6 : isSystem ? 0.45 : 0,
          padding: 0,
          display: 'flex',
          fontSize: 11,
          lineHeight: 1,
          transition: 'opacity 0.12s ease',
        }}
      >
        {toggleGlyph}
      </button>
      {isSystem && (
        <span style={{ ...typeRamp.micro, color: tint.fg, opacity: 0.8, textTransform: 'lowercase' }}>sys</span>
      )}
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

export default function Launcher({ open, onClose, onRun, onOpenSettings, asView = false }: LauncherProps) {
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
  /** Restore-line copy: which source seeded the current context, if any. */
  const [restoreLine, setRestoreLine] = useState<string>('Restored your last setup.')

  // ── Compose-mode (TIN-1764 in-app authoring) ──
  const [composing, setComposing] = useState<{ mode: 'new' | 'edit'; seedPath?: string } | null>(null)
  const [composeName, setComposeName] = useState('')
  const [composeDesc, setComposeDesc] = useState('')
  const [composeBody, setComposeBody] = useState('')
  /** Default-context refs to write to frontmatter on a "Save as prompt…" flow. */
  const [composeContext, setComposeContext] = useState<ContextItem[]>([])
  const [saving, setSaving] = useState(false)

  // ── System tier (TIN-1764) ──
  const [systemFacts, setSystemFacts] = useState<SystemFacts>(defaultSystemFacts())
  const [autoFactsOpen, setAutoFactsOpen] = useState(false)
  const [systemPreviewOpen, setSystemPreviewOpen] = useState(false)
  /** Bodies of system-tier items, loaded lazily when the preview opens. */
  const [systemBodies, setSystemBodies] = useState<Record<string, string>>({})
  /** A stable "now" for the preview stamp, refreshed when the preview opens. */
  const [previewNow, setPreviewNow] = useState(() => new Date())

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
    async (p: PromptEntry, agents: Agent[], roots: { skillsRoot: string; memoryRoot: string }) => {
      setSelected(p)
      setPicker(null)
      setComposing(null)
      setLoadingBody(true)

      const first = agents[0]

      // Read the body first so frontmatter is available for default-context seeding.
      let raw = ''
      try {
        const cached = bodyByPathRef.current[p.path]
        raw = cached ?? (await readPrompt(p.path))
        bodyByPathRef.current[p.path] = raw
        setPromptBody(raw)
      } catch {
        setPromptBody('')
      } finally {
        setLoadingBody(false)
      }

      // Precedence: a session override (localStorage) WINS; else the prompt's
      // frontmatter `context:` default; else nothing.
      const setup = getSetup(p.path)
      if (setup) {
        setContext(setup.context)
        setAgentName(setup.agentName)
        setCwd(setup.cwd)
        setSystemFacts(setup.systemFacts ?? defaultSystemFacts())
        setRestoreLine('Restored your last setup.')
        setRestored(true)
      } else {
        setAgentName(first?.name ?? '')
        setCwd(first?.cwd ?? '')
        // A `system_facts:` key (even empty) is honored; its absence defaults time on.
        const hasFactsKey = /\bsystem_facts\s*:/.test(raw.slice(0, raw.indexOf('\n---', 3) + 1 || raw.length))
        setSystemFacts(hasFactsKey ? systemFactsFromList(parseFrontmatterSystemFacts(raw)) : defaultSystemFacts())

        const refs = parseFrontmatterContext(raw)
        if (refs.length > 0) {
          const resolved = (
            await Promise.all(refs.map((r) => resolveContextRef(r, roots)))
          ).filter((x): x is ContextItem => x !== null)
          setContext(resolved)
          if (resolved.length > 0) {
            setRestoreLine("Loaded this prompt’s default context.")
            setRestored(true)
          } else {
            setRestored(false)
          }
        } else {
          setContext([])
          setRestored(false)
        }
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

  /** Move a chip between the user tier and the system tier (TIN-1764). */
  const toggleSystem = useCallback((path: string) => {
    setRestored(false)
    setContext((prev) => prev.map((c) => (c.path === path ? { ...c, system: !c.system } : c)))
  }, [])

  const startFresh = useCallback(() => {
    if (selected) clearSetup(selected.path)
    setContext([])
    setRestored(false)
    setSystemFacts(defaultSystemFacts())
    const first = settings?.agents[0]
    setAgentName(first?.name ?? '')
    setCwd(first?.cwd ?? '')
  }, [selected, settings])

  // ── Compose-mode handlers (TIN-1764) ──

  const promptsRoot = settings?.promptsRoot ?? ''
  const roots = useMemo(
    () => ({ skillsRoot: settings?.skillsRoot ?? '', memoryRoot: settings?.memoryRoot ?? '' }),
    [settings?.skillsRoot, settings?.memoryRoot],
  )

  const startNew = useCallback(() => {
    setComposing({ mode: 'new' })
    setComposeName('')
    setComposeDesc('')
    setComposeBody('')
    setComposeContext([])
    setSelected(null)
    setPicker(null)
  }, [])

  const startEdit = useCallback(() => {
    if (!selected) return
    const raw = bodyByPathRef.current[selected.path] ?? promptBody
    setComposing({ mode: 'edit', seedPath: selected.path })
    setComposeName(selected.name)
    setComposeDesc(selected.description)
    setComposeBody(stripFrontmatter(raw).trim())
    setComposeContext([])
    setPicker(null)
  }, [selected, promptBody])

  /** "Save as prompt…": new prompt pre-seeded from the current body + chips. */
  const startSaveAs = useCallback(() => {
    setComposing({ mode: 'new' })
    setComposeName(selected?.name ?? '')
    setComposeDesc('')
    setComposeBody(stripFrontmatter(promptBody).trim())
    setComposeContext(context)
    setPicker(null)
  }, [selected, promptBody, context])

  const cancelCompose = useCallback(() => {
    setComposing(null)
  }, [])

  const saveCompose = useCallback(async () => {
    if (!composing || !composeName.trim() || !promptsRoot) return
    setSaving(true)
    try {
      const isEdit = composing.mode === 'edit'
      const baseSlug = slugify(composeName) || 'prompt'
      const ctxRefs = composeContext.map((c) => contextItemToRef(c, roots))
      // Carry the current auto-facts into frontmatter only when seeding from a
      // live setup ("Save as prompt…" pre-seeds chips); a blank New leaves none.
      const factsList = composeContext.length > 0 ? systemFactsToList(systemFacts) : []

      let savedPath: string
      if (isEdit && composing.seedPath) {
        const seedSlug = filename(composing.seedPath).replace(/\.md$/, '')
        savedPath = await writePrompt({
          dir: promptsRoot,
          slug: seedSlug,
          name: composeName.trim(),
          description: composeDesc.trim(),
          body: composeBody,
          overwrite: true,
          context: ctxRefs.length ? ctxRefs : undefined,
          systemFacts: factsList.length ? factsList : undefined,
        })
      } else {
        // NEW: suffix -2, -3… on collision; never overwrite, never dialog.
        let slug = baseSlug
        let n = 1
        // Loop until write succeeds (backend refuses to clobber an existing slug).
        // Bounded so a pathological collision storm cannot hang the UI.
        let written: string | null = null
        while (n < 100) {
          try {
            written = await writePrompt({
              dir: promptsRoot,
              slug,
              name: composeName.trim(),
              description: composeDesc.trim(),
              body: composeBody,
              overwrite: false,
              context: ctxRefs.length ? ctxRefs : undefined,
              systemFacts: factsList.length ? factsList : undefined,
            })
            break
          } catch {
            n += 1
            slug = `${baseSlug}-${n}`
          }
        }
        if (!written) throw new Error('Could not find a free slug.')
        savedPath = written
      }

      // Re-list, select the saved prompt, return to preview-mode.
      bodyByPathRef.current[savedPath] = ''
      delete bodyByPathRef.current[savedPath]
      const list = await listPrompts(promptsRoot)
      setPrompts(list)
      setComposing(null)
      const saved = list.find((p) => p.path === savedPath)
      if (saved) await selectPrompt(saved, settings?.agents ?? [], roots)
    } catch {
      /* leave compose open on failure; nothing is half-written by the backend */
    } finally {
      setSaving(false)
    }
  }, [composing, composeName, composeDesc, composeBody, composeContext, systemFacts, promptsRoot, roots, selectPrompt, settings])

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
  // Run is inert while composing — column 3 shows "Save this prompt to run it."
  const canRun = !!selected && !!activeAgent && !!cwd && !launching && !composing

  const handleRun = useCallback(async () => {
    if (!selected || !activeAgent || !cwd) return
    setLaunching(true)
    try {
      // Remember this setup for the prompt before launching.
      saveSetup(selected.path, { context, agentName, cwd, systemFacts })
      pushRecentDir(cwd)
      setRecentDirs(getRecentDirs())

      // Stamp time-of-input + the other on auto-facts at the moment Run fires.
      const facts = resolveFacts(systemFacts, { cwd, agentName }, new Date())
      const bundle = await buildBundle(selected.name, promptBody, context, facts)
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
  }, [selected, activeAgent, cwd, context, agentName, systemFacts, promptBody, onRun, onClose])

  // ── Keyboard: ⌘↩ runs, Esc cancels compose → closes picker → closes launcher ──

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
      if (e.key === 'Escape') {
        e.preventDefault()
        if (composing) cancelCompose()
        else if (picker) setPicker(null)
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
  }, [open, picker, composing, cancelCompose, canRun, handleRun, onClose])

  // ── Load system-item bodies (and refresh the stamp) when the preview opens ──

  const systemPaths = context.filter((c) => c.system).map((c) => c.path).join('|')
  useEffect(() => {
    if (!systemPreviewOpen) return
    const paths = systemPaths ? systemPaths.split('|') : []
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        paths.map(async (p) => {
          let body = ''
          try {
            body = await readPrompt(p)
          } catch {
            body = ''
          }
          return [p, body] as const
        }),
      )
      if (!cancelled) setSystemBodies(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [systemPreviewOpen, systemPaths])

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

  const userContext = context.filter((c) => !c.system)
  const systemContext = context.filter((c) => c.system)

  const tally = (['skill', 'memory', 'file'] as ContextKind[])
    .map((k) => {
      const n = userContext.filter((c) => c.kind === k).length
      const noun =
        k === 'skill' ? (n === 1 ? 'skill' : 'skills') : k === 'memory' ? 'memory' : n === 1 ? 'file' : 'files'
      return n > 0 ? `${n} ${noun}` : null
    })
    .filter(Boolean)
    .join(' · ')

  // Second faint tally line: the on auto-facts (e.g. "System: time of input").
  const onFactLabels = SYSTEM_FACT_ORDER.filter((f) => systemFacts[f.id]).map((f) => f.label.toLowerCase())
  const systemTally = onFactLabels.length > 0 ? `System: ${onFactLabels.join(', ')}` : ''
  // Count for the human-hideable preview disclosure: system chips + on auto-facts.
  const systemPreviewCount = systemContext.length + onFactLabels.length

  // The mono preview text: resolved auto-facts as plain lines, then each system
  // item as `## SYSTEM — <Kind>: <label>` + body (long files summarized).
  const previewFacts = resolveFacts(systemFacts, { cwd, agentName }, previewNow)
  const systemPreviewText = [
    ...previewFacts.map((f) => `${f.label}: ${f.value}`),
    ...systemContext.map((item) => {
      const body = systemBodies[item.path]
      const head = `## SYSTEM — ${item.kind.charAt(0).toUpperCase() + item.kind.slice(1)}: ${item.label}`
      if (body == null) return `${head}\n(loading…)`
      const lines = body.split('\n').length
      const summary = item.kind === 'file' && lines > 40 ? `<file body, ${lines} lines>` : stripFrontmatter(body).trim()
      return `${head}\n${summary}`
    }),
  ].join('\n\n')

  const noPromptsRoot = settings !== null && !settings.promptsRoot.trim()
  const noAgents = settings !== null && agents.length === 0

  // ── Render ──

  // As a full view (TIN-1707) the launcher fills the content column with no scrim
  // and no header — the one persistent top bar owns the `Launch` title and the
  // history arrows. As a modal it keeps its fixed overlay + its own header.
  const outerStyle: React.CSSProperties = asView
    ? {
        height: '100%',
        width: '100%',
        minHeight: 0,
        background: color.bgApp,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }
    : {
        position: 'fixed',
        inset: 0,
        zIndex: 1500,
        background: color.bgApp,
        display: 'flex',
        flexDirection: 'column',
      }

  return (
    <div style={outerStyle}>
      {/* Modal-only top bar — persists with ← return; center reads "Launch". As a
          view this is supplied by the app's one persistent top bar instead. */}
      {!asView && (
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
      )}

      {/* Body: three columns */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
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
            {!noPromptsRoot && (
              <Button
                variant="tertiary"
                tone="forest"
                onClick={startNew}
                style={{ width: '100%', marginTop: space[2], textAlign: 'left', justifyContent: 'flex-start' }}
              >
                + New prompt
              </Button>
            )}
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
                    onClick={() => selectPrompt(p, agents, roots)}
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

        {/* ── Column 2 — Preview & Context (swaps to Compose in place) ── */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', position: 'relative' }}>
          {composing ? (
            <ComposePane
              mode={composing.mode}
              name={composeName}
              description={composeDesc}
              body={composeBody}
              seedPath={composing.seedPath}
              saving={saving}
              onName={setComposeName}
              onDescription={setComposeDesc}
              onBody={setComposeBody}
              onCancel={cancelCompose}
              onSave={saveCompose}
            />
          ) : !selected ? (
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
              {/* Prompt title + Edit + restore line */}
              <div style={{ marginBottom: space[5] }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: space[4] }}>
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
                  <Button variant="tertiary" padding="none" onClick={startEdit} style={{ fontWeight: 400 }}>
                    Edit
                  </Button>
                </div>
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
                    {restoreLine}
                    <Button variant="tertiary" padding="none" onClick={startFresh} style={{ fontSize: 'inherit', fontWeight: 400 }}>
                      Start fresh
                    </Button>
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

              {/* User-tier chips grouped by kind */}
              {userContext.length > 0 && (
                <div style={{ marginTop: space[5], display: 'flex', flexDirection: 'column', gap: space[3] }}>
                  {(['skill', 'memory', 'file'] as ContextKind[]).map((kind) => {
                    const items = userContext.filter((c) => c.kind === kind)
                    if (items.length === 0) return null
                    return (
                      <div key={kind} style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
                        {items.map((item) => (
                          <ContextChip
                            key={item.path}
                            item={item}
                            onRemove={() => removeContext(item.path)}
                            onToggleSystem={() => toggleSystem(item.path)}
                          />
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* System-tier chips, under a hair separator + SYSTEM header */}
              {systemContext.length > 0 && (
                <div style={{ marginTop: space[5] }}>
                  <div style={{ height: 1, background: color.hair, marginBottom: space[4] }} />
                  <div style={{ ...typeRamp.label, color: color.inkFaint, marginBottom: space[3] }}>SYSTEM</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
                    {systemContext.map((item) => (
                      <ContextChip
                        key={item.path}
                        item={item}
                        onRemove={() => removeContext(item.path)}
                        onToggleSystem={() => toggleSystem(item.path)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* "Save as prompt…" — appears once there's a body or ≥1 chip */}
              {(previewBody || context.length > 0) && promptsRoot && (
                <div style={{ marginTop: space[5] }}>
                  <Button variant="tertiary" tone="forest" padding="none" onClick={startSaveAs}>
                    Save as prompt…
                  </Button>
                </div>
              )}

              {/* Human-hideable system-context preview disclosure */}
              {systemPreviewCount > 0 && (
                <div style={{ marginTop: space[6] }}>
                  <button
                    onClick={() => {
                      if (!systemPreviewOpen) setPreviewNow(new Date())
                      setSystemPreviewOpen((v) => !v)
                    }}
                    aria-expanded={systemPreviewOpen}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: space[2],
                      ...typeRamp.meta,
                      color: color.inkFaint,
                    }}
                  >
                    <span style={{ fontSize: 10 }}>{systemPreviewOpen ? '▾' : '▸'}</span>
                    <span>System context the agent will also receive ({systemPreviewCount})</span>
                  </button>
                  {systemPreviewOpen && (
                    <pre
                      style={{
                        marginTop: space[3],
                        background: color.neutralTint,
                        borderRadius: radius.md,
                        padding: space[4],
                        ...typeRamp.mono,
                        color: color.inkSoft,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {systemPreviewText}
                    </pre>
                  )}
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
            {systemTally && (
              <div style={{ ...typeRamp.meta, color: color.inkFaint }}>{systemTally}</div>
            )}

            {/* Auto system messages — a quiet disclosure of the four facts */}
            <div style={{ marginTop: space[2] }}>
              <button
                onClick={() => setAutoFactsOpen((v) => !v)}
                aria-expanded={autoFactsOpen}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: space[2],
                  ...typeRamp.label,
                  color: color.inkFaint,
                }}
              >
                <span>SYSTEM</span>
                <span style={{ ...typeRamp.meta, fontWeight: 400 }}>{onFactLabels.length}</span>
                <span style={{ fontSize: 9 }}>{autoFactsOpen ? '▾' : '▸'}</span>
              </button>
              {autoFactsOpen && (
                <div style={{ marginTop: space[3], display: 'flex', flexDirection: 'column', gap: space[2] }}>
                  {SYSTEM_FACT_ORDER.map((f) => (
                    <label
                      key={f.id}
                      style={{ display: 'flex', alignItems: 'center', gap: space[2], cursor: 'pointer', ...typeRamp.meta, color: color.inkSoft }}
                    >
                      <input
                        type="checkbox"
                        checked={systemFacts[f.id]}
                        onChange={() =>
                          setSystemFacts((prev) => ({ ...prev, [f.id]: !prev[f.id] }))
                        }
                        style={{ accentColor: color.forest }}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {/* Run — the gravity well */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <Button
              variant="primary"
              glow
              onClick={handleRun}
              disabled={!canRun}
              style={{
                width: '100%',
                padding: '14px 16px',
                fontSize: 15,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space[3],
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
            </Button>
            {composing && (
              <div style={{ ...typeRamp.meta, color: color.inkFaint, textAlign: 'center' }}>
                Save this prompt to run it.
              </div>
            )}
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

// ── Compose pane (TIN-1764 in-app authoring) ────────────────────────────────────

/**
 * Column 2's compose surface — swapped in place of the preview. Name (serif
 * title), one-line Description, and the real MarkdownEditor for the body. The
 * editor is lazy-mounted (this whole pane only renders in compose-mode).
 */
function ComposePane({
  mode,
  name,
  description,
  body,
  seedPath,
  saving,
  onName,
  onDescription,
  onBody,
  onCancel,
  onSave,
}: {
  mode: 'new' | 'edit'
  name: string
  description: string
  body: string
  seedPath?: string
  saving: boolean
  onName: (v: string) => void
  onDescription: (v: string) => void
  onBody: (v: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  // Stable mount key so the editor seeds once per compose session (seedPath for
  // edit; a constant for new). Matches the WorkspacePanel key={activePath} pattern.
  const editorKey = mode === 'edit' && seedPath ? `edit:${seedPath}` : 'new'
  const canSave = !!name.trim() && !saving

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: `${space[8]}px ${space[8]}px` }}>
      {/* Compose header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[4] }}>
        <span style={{ ...typeRamp.label, color: color.inkSoft }}>
          {mode === 'new' ? 'NEW PROMPT' : 'EDITING'}
        </span>
        <div style={{ display: 'flex', gap: space[3] }}>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save prompt'}
          </Button>
        </div>
      </div>
      <div style={{ height: 1, background: color.hair, margin: `${space[4]}px 0 ${space[6]}px` }} />

      {/* Name — serif title-size field */}
      <input
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Name this prompt"
        autoFocus
        style={{
          ...fieldStyle,
          fontFamily: font.serif,
          fontSize: 26,
          fontWeight: 600,
          padding: '8px 12px',
          marginBottom: space[3],
        }}
      />

      {/* Description — one-line meta field */}
      <input
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        placeholder="One line, so you can find it later"
        style={{ ...fieldStyle, ...typeRamp.meta, marginBottom: space[6] }}
      />

      {/* Body — the real editor */}
      <MarkdownEditor key={editorKey} initialContent={body} onChange={onBody} onSave={onSave} />
    </div>
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
