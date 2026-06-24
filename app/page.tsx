'use client'

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { invoke } from '@tauri-apps/api/core'
import matter from 'gray-matter'
import LinearPanel from '@/components/LinearPanel'
import TerminalPanel, { RunRequest } from '@/components/TerminalPanel'
import Launcher from '@/components/Launcher'
import TranscriptBrowser from '@/components/TranscriptBrowser'
import CommandPalette from '@/components/CommandPalette'
import WorkspacePanel from '@/components/WorkspacePanel'
import NavRail, { type RailDest } from '@/components/NavRail'
import TopBar from '@/components/TopBar'
import { TopBarSlotProvider } from '@/components/TopBarSlot'
import PanelDivider from '@/components/PanelDivider'
import SettingsModal from '@/components/SettingsModal'
import QuickCapture from '@/components/QuickCapture'
import Toast from '@/components/Toast'
import FrontmatterForm from '@/components/FrontmatterForm'
import { NotePill } from '@/components/ConsistencyView'
import Button from '@/components/Button'
import { linkSuggest } from '@/lib/links'
import { suggestFrontmatter, summarizeNote, importMarkdown, type Suggestion } from '@/lib/frontmatter'
import { scoreMemory, recordMemoryChange, bodyHash, type Conflict } from '@/lib/continuity'
import { initTheme } from '@/lib/theme'
import { getSettings, rebuildIndex } from '@/lib/settings'

// Import flow + audit view (TIN-1638), loaded lazily / client-only.
const ImportModal = dynamic(() => import('@/components/ImportModal'), { ssr: false })
const AuditView = dynamic(() => import('@/components/AuditView'), { ssr: false })

// The graph view pulls in d3-force; load it lazily and client-only so it stays
// out of the initial bundle and the static-export SSR pass.
const GraphView = dynamic(() => import('@/components/GraphView'), { ssr: false })
const ConsistencyView = dynamic(() => import('@/components/ConsistencyView'), { ssr: false })
const ChangesView = dynamic(() => import('@/components/ChangesView'), { ssr: false })
import { color, radius, space, font, shadow } from '@/lib/tokens'
import {
  MemorySearchResult,
  OpenDoc,
  PanelSide,
  PanelState,
  LegacyPanelState,
  LoadedFile,
} from '@/lib/types'

const MEMORY_ROOT = '/Users/rob/Projects/tfl/memory'
const RECENTS_KEY = 'agent-studio-recents'
const RECENTS_MAX = 8
const LAYOUT_KEY = 'agent-studio-layout'

// ── Helpers ──────────────────────────────────────────────────────────────────


const otherSide = (side: PanelSide): PanelSide => (side === 'left' ? 'right' : 'left')

/** The app's top-level destinations — the workspace, or one of the full views
 *  reached from the nav rail. */
type AppView = 'workspace' | 'graph' | 'frontmatter' | 'consistency' | 'launch' | 'transcripts' | 'changes'

/** The room name shown in the persistent top bar's title slot (TIN-1708), per
 *  full view. The workspace uses the serif wordmark instead of a title. */
const ROOM_TITLE: Record<Exclude<AppView, 'workspace'>, string> = {
  graph: 'Graph',
  frontmatter: 'Fields',
  consistency: 'Check',
  launch: 'Launch',
  transcripts: 'Sessions',
  changes: 'Changes',
}

/** One entry in the global back/forward trail (TIN-1705): a destination view
 *  plus, in the workspace, the focused panel's active document (null = Search). */
type NavLoc = { view: AppView; doc: string | null }

// ── Tauri fs helpers ──────────────────────────────────────────────────────────

type TauriReadTextFile = (path: string) => Promise<string>
type TauriWriteTextFile = (path: string, content: string) => Promise<void>

async function getTauriFns(): Promise<{
  readTextFile: TauriReadTextFile
  writeTextFile: TauriWriteTextFile
}> {
  const mod = await import('@tauri-apps/plugin-fs')
  return {
    readTextFile: mod.readTextFile,
    writeTextFile: mod.writeTextFile,
  }
}

// ── Search API client ─────────────────────────────────────────────────────────

interface SearchApiResponse {
  results: MemorySearchResult[]
  types: string[]
  projects: string[]
  error?: string
}

async function fetchSearch(params: {
  q?: string
  type?: string
  project?: string
  init?: boolean
}): Promise<SearchApiResponse> {
  return invoke<SearchApiResponse>('search', {
    payload: {
      q: params.q ?? '',
      typeFilter: params.type ?? '',
      projectFilter: params.project ?? '',
      rebuild: params.init ?? false,
    },
  })
}

// ── New-file modal ────────────────────────────────────────────────────────────

interface NewFileModalProps {
  knownTypes: string[]
  knownProjects: string[]
  onClose: () => void
  onCreated: (filePath: string) => void
  /** Open a conflicting note (from the continuity notice) into a panel. */
  onOpenConflict: (path: string) => void
}

function NewFileModal({ knownTypes, knownProjects, onClose, onCreated, onOpenConflict }: NewFileModalProps) {
  const [content, setContent] = useState('')
  const [fm, setFm] = useState<Suggestion>({
    name: '',
    title: '',
    type: knownTypes[0] ?? 'feedback',
    projects: knownProjects.length > 0 ? [knownProjects[0]] : [],
    tags: [],
    created: '',
    status: 'active',
  })
  // Fields the user has hand-edited stay sacrosanct on re-describe.
  const editedRef = useRef<Set<keyof Suggestion>>(new Set())
  const [hasEdits, setHasEdits] = useState(false)
  const [describing, setDescribing] = useState(false)
  const [described, setDescribed] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Conflicts the note seems to update (TIN-1730), shown as a quiet notice, plus
  // the continuity score recorded onto the ledger at create time (TIN-1728).
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const continuityScoreRef = useRef<number | undefined>(undefined)
  // The body hash the current summary was generated from, so we can flag a stale
  // summary when the note has been written further since (TIN-1727).
  const [summaryHash, setSummaryHash] = useState<string | null>(null)

  const describe = useCallback(async (text: string) => {
    if (!text.trim()) return
    setDescribing(true)
    try {
      const s = await suggestFrontmatter(text)
      setFm((prev) => {
        const ed = editedRef.current
        return {
          name: ed.has('name') ? prev.name : s.name,
          title: ed.has('title') ? prev.title : s.title,
          type: ed.has('type') ? prev.type : s.type,
          projects: ed.has('projects') ? prev.projects : s.projects,
          tags: ed.has('tags') ? prev.tags : s.tags,
          created: s.created || prev.created,
          status: ed.has('status') ? prev.status : s.status || prev.status,
          summary: prev.summary,
        }
      })
      setDescribed(true)
      // Generate the one-to-two sentence summary (fire-and-forget safe): if the
      // user has hand-edited it, or the model is degraded, leave the field be.
      summarizeNote(text)
        .then((r) => {
          if (r.degraded || !r.summary || editedRef.current.has('summary')) return
          setFm((prev) => ({ ...prev, summary: r.summary }))
          setSummaryHash(bodyHash(text))
        })
        .catch(() => { /* fire-and-forget */ })
      // Look for notes this one seems to update (continuity feedback, TIN-1730).
      scoreMemory(text)
        .then((r) => {
          setConflicts(r.conflicts)
          continuityScoreRef.current = r.degraded ? undefined : r.continuityScore
        })
        .catch(() => { /* calm: no notice on failure */ })
    } catch {
      /* keep the user's manual values */
    } finally {
      setDescribing(false)
    }
  }, [])

  // The summary is stale when the note body has changed since it was generated.
  const summaryStale =
    !!fm.summary && summaryHash !== null && bodyHash(content) !== summaryHash

  // Debounced auto-describe as the note is written or pasted.
  useEffect(() => {
    if (!content.trim()) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => describe(content), 600)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [content, describe])

  const handleFormChange = (next: Suggestion) => {
    const ed = editedRef.current
    ;(Object.keys(next) as (keyof Suggestion)[]).forEach((k) => {
      if (JSON.stringify(next[k]) !== JSON.stringify(fm[k])) ed.add(k)
    })
    setHasEdits(ed.size > 0)
    setFm(next)
  }

  const regenerate = () => {
    // Re-describe from the note, but a hand-edited name stays the user's.
    const keepName = editedRef.current.has('name')
    editedRef.current = new Set(keepName ? (['name'] as (keyof Suggestion)[]) : [])
    setHasEdits(keepName)
    describe(content)
  }

  async function handleCreate() {
    if (!fm.name.trim()) { setError('A name is needed.'); return }
    if (!fm.type.trim()) { setError('A type is needed.'); return }
    if (fm.projects.length === 0) { setError('At least one project is needed.'); return }

    setCreating(true)
    setError('')
    try {
      const today = new Date().toISOString().slice(0, 10)
      const body = content.trim() ? content : `# ${fm.title || fm.name}\n`
      const path = await importMarkdown(body, { ...fm, created: fm.created || today })
      // Record this creation on the memory ledger (TIN-1728, human attribution).
      recordMemoryChange({
        path,
        actorType: 'human',
        actorId: 'studio',
        continuityScore: continuityScoreRef.current,
        changeSummary: 'Created this note.',
        contentHash: bodyHash(body),
      }).catch(() => { /* the file is written; the ledger is best-effort */ })
      onCreated(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the file. Your work is still here.')
      setCreating(false)
    }
  }

  const sourceLabel = describing
    ? 'Describing…'
    : described
      ? hasEdits
        ? 'Described, with your edits.'
        : 'Described from your note.'
      : undefined

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: color.scrim,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-file-modal-title"
        style={{
          width: 480,
          maxHeight: '86vh',
          overflowY: 'auto',
          background: color.bgRaised,
          borderRadius: radius.lg,
          boxShadow: shadow.modal,
          padding: space[7],
          display: 'flex',
          flexDirection: 'column',
          gap: space[5],
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="new-file-modal-title" style={{ fontSize: 15, fontWeight: 700, color: color.ink }}>
          New memory file
        </div>

        {/* The note itself — described into frontmatter as you write. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
          <label style={labelStyle}>Note</label>
          <textarea
            autoFocus
            placeholder="Paste or write the note. We’ll describe it for you."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            style={{
              width: '100%',
              minHeight: 120,
              resize: 'vertical',
              border: 'none',
              background: 'transparent',
              color: color.ink,
              fontFamily: font.serif,
              fontSize: 15,
              lineHeight: 1.6,
              outline: 'none',
              padding: 0,
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Continuity feedback (TIN-1730): a calm note this seems to update. No
            score, no red — an invitation to look, mirroring ImportModal. */}
        {conflicts.length > 0 && (
          <div style={continuityNoticeStyle}>
            <span style={{ marginRight: space[2] }}>This seems to update</span>
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: space[2], alignItems: 'center' }}>
              {conflicts.slice(0, 2).map((c) => (
                <NotePill
                  key={c.path}
                  name={c.name}
                  filePath={c.path}
                  onOpenFile={(path) => onOpenConflict(path)}
                />
              ))}
              {conflicts.length > 2 && (
                <span style={{ color: color.inkFaint }}>and {conflicts.length - 2} more</span>
              )}
            </span>
          </div>
        )}

        <FrontmatterForm
          value={fm}
          onChange={handleFormChange}
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onRegenerate={content.trim() ? regenerate : undefined}
          regenerating={describing}
          sourceLabel={sourceLabel}
          summaryStale={summaryStale}
        />

        {error && (
          <div style={{ fontSize: 12, color: color.notice, padding: '6px 10px', background: 'rgba(155,123,90,0.08)', borderRadius: radius.md }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end', marginTop: space[1] }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating…' : 'Create file'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Inline style constants ────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
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

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: color.inkSoft,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

// Continuity notice — tan notice on a tan tint, mirroring ImportModal's
// `noticeStyle` (TIN-1730). Calm, never red.
const continuityNoticeStyle: React.CSSProperties = {
  fontFamily: font.sans,
  fontSize: 13,
  fontWeight: 400,
  color: color.notice,
  background: color.tanTint,
  borderRadius: radius.md,
  padding: `${space[3]}px ${space[4]}px`,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: space[1],
}

// ── Persisted layout ──────────────────────────────────────────────────────────

interface PersistedLayout {
  left: PanelState
  right: PanelState
  rightOpen: boolean
  leftWidth: number
}

const emptyPanel = (): PanelState => ({ tabs: [], activeTabId: null })

/** Normalize a persisted panel into the current {@link PanelState}, migrating
 *  the legacy `{ activePath, activeTab }` shape (TIN-1640) in place:
 *  a set `activePath` becomes a single open tab carrying its old surface;
 *  a null `activePath` becomes an empty tab list with Search active. */
function migratePanel(raw: unknown): PanelState {
  if (!raw || typeof raw !== 'object') return emptyPanel()

  // Already the new shape?
  if (Array.isArray((raw as PanelState).tabs)) {
    const p = raw as PanelState
    const tabs = p.tabs.filter((t): t is OpenDoc => !!t && typeof t.path === 'string')
    const activeTabId =
      p.activeTabId && tabs.some((t) => t.path === p.activeTabId) ? p.activeTabId : null
    return { tabs, activeTabId }
  }

  // Legacy shape → migrate (the old per-doc surface is dropped).
  const legacy = raw as Partial<LegacyPanelState>
  if (legacy.activePath) {
    return { tabs: [{ path: legacy.activePath }], activeTabId: legacy.activePath }
  }
  return emptyPanel()
}

function loadLayout(): PersistedLayout {
  const fallback: PersistedLayout = {
    left: emptyPanel(),
    right: emptyPanel(),
    rightOpen: false,
    leftWidth: 50,
  }
  try {
    const stored = localStorage.getItem(LAYOUT_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Partial<PersistedLayout>
    return {
      left: migratePanel(parsed.left),
      right: migratePanel(parsed.right),
      rightOpen: parsed.rightOpen ?? false,
      leftWidth:
        typeof parsed.leftWidth === 'number' && parsed.leftWidth >= 20 && parsed.leftWidth <= 80
          ? parsed.leftWidth
          : 50,
    }
  } catch {
    return fallback
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Home() {
  // Search state (global — shared by both panels)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeType, setActiveType] = useState('')
  const [activeProject, setActiveProject] = useState('')
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([])
  const [knownTypes, setKnownTypes] = useState<string[]>([])
  const [knownProjects, setKnownProjects] = useState<string[]>([])
  const [searching, setSearching] = useState(false)

  // Per-path loaded-file cache (shared so a file open in both panels stays in sync)
  const [files, setFiles] = useState<Record<string, LoadedFile>>({})

  // Panel layout
  const [leftPanel, setLeftPanel] = useState<PanelState>(emptyPanel)
  const [rightPanel, setRightPanel] = useState<PanelState>(emptyPanel)
  const [rightOpen, setRightOpen] = useState(false)
  const [leftWidth, setLeftWidth] = useState(50)
  const [layoutReady, setLayoutReady] = useState(false)
  // Which panel the keyboard acts on (⌘W / ⌃Tab). Follows the last interaction;
  // falls back to the right panel when it's open, else the left.
  const [focusedSide, setFocusedSide] = useState<PanelSide>('left')

  const [recentPaths, setRecentPaths] = useState<string[]>([])

  // UI state
  const [showNewModal, setShowNewModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showQuickCapture, setShowQuickCapture] = useState(false)
  const [toast, setToast] = useState<{ message: string; path: string } | null>(null)
  // Working directory the Diff tab inspects — defaults to the first registered
  // agent's cwd from settings (the launcher updates this when a session starts).
  // Recorded on launch so it lands in recent dirs (the Changes view seeds from
  // there); the workspace itself no longer needs the value.
  const [, setActiveWorkingDir] = useState('')
  const [activeTicket, setActiveTicket] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The full-view destinations live behind one `activeView` (the nav rail makes
  // them visible). 'workspace' is the two-panel home.
  const [activeView, setActiveView] = useState<AppView>('workspace')
  // Frontmatter manager (TIN-1638): import queue + drag affordance.
  const [importFiles, setImportFiles] = useState<{ path: string; content: string }[] | null>(null)
  const [draggingImport, setDraggingImport] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [, setIsSaving] = useState(false)
  // The active full view's top-bar right-slot content, registered by the view via
  // the TopBarSlot context (TIN-1708). The workspace supplies its own slot inline.
  const [viewRight, setViewRight] = useState<ReactNode>(null)
  const spawnClaudeRef = useRef<((filePath: string | null) => void) | null>(null)
  const runRef = useRef<((req: RunRequest) => void) | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  // One debounce timer per edited path, so editing two panels never drops a save.
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest in-flight markdown, keyed by the path being edited
  const latestMarkdownRef = useRef<Record<string, string>>({})
  const lastOpenedPathRef = useRef<string | null>(null)

  // ── Hydrate persisted state (recents + layout) ──

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENTS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) setRecentPaths(parsed)
      }
    } catch { /* ignore */ }

    const layout = loadLayout()
    setLeftPanel(layout.left)
    setRightPanel(layout.right)
    setRightOpen(layout.rightOpen)
    setLeftWidth(layout.leftWidth)
    lastOpenedPathRef.current = layout.right.activeTabId ?? layout.left.activeTabId

    // Restore file contents for every open tab across both panels.
    const toRestore = new Set<string>()
    layout.left.tabs.forEach((t) => toRestore.add(t.path))
    layout.right.tabs.forEach((t) => toRestore.add(t.path))
    toRestore.forEach((p) => loadFile(p))

    setLayoutReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function pushRecent(filePath: string) {
    setRecentPaths((prev) => {
      const next = [filePath, ...prev.filter((p) => p !== filePath)].slice(0, RECENTS_MAX)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }

  // ── Persist layout whenever it changes (after hydration) ──

  useEffect(() => {
    if (!layoutReady) return
    const payload: PersistedLayout = { left: leftPanel, right: rightPanel, rightOpen, leftWidth }
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(payload))
    } catch { /* ignore */ }
  }, [layoutReady, leftPanel, rightPanel, rightOpen, leftWidth])

  // ── Search ──

  const runSearch = useCallback(async (q: string, type: string, project: string, init = false) => {
    setSearching(true)
    try {
      const data = await fetchSearch({ q: q || undefined, type: type || undefined, project: project || undefined, init })
      setSearchResults(data.results ?? [])
      if (data.types?.length) setKnownTypes(data.types)
      if (data.projects?.length) setKnownProjects(data.projects)
    } catch (err) {
      console.error('[search]', err)
    } finally {
      setSearching(false)
    }
  }, [])

  // Initial load: build index and fetch default results
  useEffect(() => {
    runSearch('', '', '', true)
  }, [runSearch])

  // Apply the saved theme and follow OS changes while in 'system' (TIN-1673).
  // The early <head> script set the initial value; this wires the live listener.
  useEffect(() => {
    initTheme()
  }, [])

  // Latest search args, so the file watcher can refresh the *current* view.
  const searchArgsRef = useRef({ q: '', type: '', project: '' })
  useEffect(() => {
    searchArgsRef.current = { q: searchQuery, type: activeType, project: activeProject }
  }, [searchQuery, activeType, activeProject])

  // Auto-reindex when memory files change on disk: watch the memory root, and on
  // any .md create/modify/delete (debounced) rebuild the index and refresh the
  // current search. Lets files added or edited outside Studio appear without a
  // manual reindex or relaunch.
  useEffect(() => {
    let unwatch: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    ;(async () => {
      let root = MEMORY_ROOT
      try {
        const s = await getSettings()
        if (s.memoryRoot) root = s.memoryRoot
      } catch { /* fall back to default root */ }
      try {
        const { watchImmediate } = await import('@tauri-apps/plugin-fs')
        const stop = await watchImmediate(
          root,
          (event) => {
            const paths = Array.isArray(event.paths) ? event.paths : []
            // Ignore the index db's own writes (they aren't .md) and non-markdown.
            const touchedMd = paths.some((p) => p.endsWith('.md') && !p.includes('.studio-index'))
            if (!touchedMd) return
            if (timer) clearTimeout(timer)
            timer = setTimeout(async () => {
              try {
                await rebuildIndex()
                const a = searchArgsRef.current
                runSearch(a.q, a.type, a.project)
              } catch (err) {
                console.error('[watch] reindex failed', err)
              }
            }, 800)
          },
          { recursive: true },
        )
        if (cancelled) stop()
        else unwatch = stop
      } catch (err) {
        console.error('[watch] setup failed', err)
      }
    })()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (unwatch) unwatch()
    }
  }, [runSearch])

  const handleSearchChange = useCallback(
    (q: string) => {
      setSearchQuery(q)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(() => {
        runSearch(q, activeType, activeProject)
      }, 250)
    },
    [activeType, activeProject, runSearch]
  )

  const handleTypeFilter = useCallback(
    (t: string) => {
      const next = activeType === t ? '' : t
      setActiveType(next)
      runSearch(searchQuery, next, activeProject)
    },
    [activeType, activeProject, searchQuery, runSearch]
  )

  const handleProjectFilter = useCallback(
    (p: string) => {
      const next = activeProject === p ? '' : p
      setActiveProject(next)
      runSearch(searchQuery, activeType, next)
    },
    [activeType, activeProject, searchQuery, runSearch]
  )

  // ── File load into the cache ──

  const loadFile = useCallback((filePath: string, meta?: MemorySearchResult) => {
    pushRecent(filePath)
    lastOpenedPathRef.current = filePath

    // Seed a loading entry (or refresh meta if already cached)
    setFiles((prev) => {
      const existing = prev[filePath]
      return {
        ...prev,
        [filePath]: {
          content: existing?.content ?? '',
          raw: existing?.raw ?? '',
          meta: meta ?? existing?.meta ?? null,
          loading: true,
        },
      }
    })

    ;(async () => {
      try {
        const { readTextFile } = await getTauriFns()
        const raw = await readTextFile(filePath)
        let content = raw
        let derivedMeta: MemorySearchResult | null = meta ?? null
        try {
          const parsed = matter(raw)
          content = parsed.content
          if (!meta) {
            const data = parsed.data as Record<string, unknown>
            const projectsRaw = data.projects
            const projects = Array.isArray(projectsRaw)
              ? (projectsRaw as string[])
              : projectsRaw ? [String(projectsRaw)] : []
            const tagsRaw = data.tags
            const tags = Array.isArray(tagsRaw) ? (tagsRaw as string[]) : tagsRaw ? [String(tagsRaw)] : []
            derivedMeta = {
              path: filePath,
              name: String(data.name ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''),
              type: String(data.type ?? ''),
              projects,
              created: String(data.created ?? ''),
              updated: String(data.updated ?? ''),
              tags,
              status: String(data.status ?? 'active'),
              excerpt: '',
            }
          }
        } catch {
          content = raw
        }
        latestMarkdownRef.current[filePath] = content
        setFiles((prev) => ({
          ...prev,
          [filePath]: { content, raw, meta: derivedMeta ?? prev[filePath]?.meta ?? null, loading: false },
        }))
      } catch (err) {
        console.error('[loadFile]', err)
        setFiles((prev) => ({
          ...prev,
          [filePath]: { ...(prev[filePath] ?? { content: '', raw: '', meta: meta ?? null }), loading: false },
        }))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open a file into a specific panel side as a document tab. Appends a new tab
  // and selects it, or re-selects the existing tab if the path is already open.
  // Opening into the right panel reveals it. Never replaces.
  const openInSide = useCallback((filePath: string, side: PanelSide, meta?: MemorySearchResult) => {
    if (side === 'right') setRightOpen(true)
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => {
      if (prev.tabs.some((t) => t.path === filePath)) {
        return { ...prev, activeTabId: filePath }
      }
      return {
        tabs: [...prev.tabs, { path: filePath }],
        activeTabId: filePath,
      }
    })
    loadFile(filePath, meta)
  }, [loadFile])

  // Select an already-open document tab in a panel.
  const selectDoc = useCallback((side: PanelSide, filePath: string) => {
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => ({ ...prev, activeTabId: filePath }))
  }, [])

  // Select the implicit Search tab in a panel (and focus its field).
  const selectSearch = useCallback((side: PanelSide) => {
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => ({ ...prev, activeTabId: null }))
    if (side === 'left') setTimeout(() => searchRef.current?.focus(), 50)
  }, [])

  // Close a document tab. The next active tab is the right neighbour, then the
  // left, falling back to Search (null) when no documents remain. Only changes
  // the active selection when the closed tab was the active one.
  const closeDoc = useCallback((side: PanelSide, filePath: string) => {
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => {
      const idx = prev.tabs.findIndex((t) => t.path === filePath)
      if (idx === -1) return prev
      const tabs = prev.tabs.filter((t) => t.path !== filePath)
      let activeTabId = prev.activeTabId
      if (prev.activeTabId === filePath) {
        const neighbour = tabs[idx] ?? tabs[idx - 1] ?? null
        activeTabId = neighbour?.path ?? null
      }
      return { tabs, activeTabId }
    })
  }, [])

  // Cycle to the next / previous tab in a panel, wrapping, Search included.
  // The cycle order is [Search, ...tabs]; null represents Search.
  const cycleTab = useCallback((side: PanelSide, dir: 1 | -1) => {
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => {
      const order: (string | null)[] = [null, ...prev.tabs.map((t) => t.path)]
      const cur = order.indexOf(prev.activeTabId)
      const next = order[(cur + dir + order.length) % order.length]
      return { ...prev, activeTabId: next }
    })
  }, [])

  // ── Save (routes by path) ──

  const saveFile = useCallback(async (filePath: string, content: string, opts?: { record?: boolean }) => {
    setIsSaving(true)
    try {
      const rawContent = files[filePath]?.raw ?? ''
      let toWrite = content
      try {
        const parsed = matter(rawContent)
        if (Object.keys(parsed.data).length > 0) {
          toWrite = matter.stringify(content, parsed.data)
        }
      } catch { /* no frontmatter */ }

      const { writeTextFile } = await getTauriFns()
      await writeTextFile(filePath, toWrite)
      setFiles((prev) => ({
        ...prev,
        [filePath]: { ...(prev[filePath] ?? { meta: null, loading: false }), content, raw: toWrite },
      }))

      // On an explicit save of an existing note, score the body for continuity
      // and record the edit on the ledger (TIN-1730 + TIN-1728). The frequent
      // autosave path skips this so the reasoning model is not hammered.
      if (opts?.record) {
        let score: number | undefined
        try {
          const r = await scoreMemory(content, filePath)
          score = r.degraded ? undefined : r.continuityScore
          if (r.conflicts.length > 0) {
            const c = r.conflicts[0]
            setToast({ message: `This seems to update ${c.name}.`, path: c.path })
          }
        } catch { /* calm: no notice on failure */ }
        recordMemoryChange({
          path: filePath,
          actorType: 'human',
          actorId: 'studio',
          continuityScore: score,
          changeSummary: 'Edited the body.',
          contentHash: bodyHash(content),
        }).catch(() => { /* the file is written; the ledger is best-effort */ })
      }
    } finally {
      setIsSaving(false)
    }
  }, [files])

  const makeEditorChange = useCallback((filePath: string | null) => (markdown: string) => {
    if (!filePath) return
    latestMarkdownRef.current[filePath] = markdown
    const timers = saveTimersRef.current
    if (timers[filePath]) clearTimeout(timers[filePath])
    timers[filePath] = setTimeout(() => { saveFile(filePath, markdown) }, 300)
  }, [saveFile])

  const makeEditorSave = useCallback((filePath: string | null) => () => {
    if (!filePath) return
    const timers = saveTimersRef.current
    if (timers[filePath]) clearTimeout(timers[filePath])
    saveFile(filePath, latestMarkdownRef.current[filePath] ?? '', { record: true })
  }, [saveFile])

  // ── Open-result handler (⌘-click routes to the OTHER panel) ──

  const makeOpenResult = useCallback(
    (side: PanelSide) => (result: MemorySearchResult, e: React.MouseEvent) => {
      const target = e.metaKey || e.ctrlKey ? otherSide(side) : side
      openInSide(result.path, target, result)
    },
    [openInSide]
  )

  // ── Wiki-link open (resolve [[slug]] → path, open in the same panel) ──
  // The editor only knows the slug text; resolve it to a file via link_suggest
  // (exact slug match preferred, else the closest name match), then open.
  const makeOpenWikiLink = useCallback(
    (side: PanelSide) => async (slug: string) => {
      try {
        const matches = await linkSuggest(slug, 8)
        const lower = slug.trim().toLowerCase()
        const hit = matches.find((m) => m.slug.toLowerCase() === lower) ?? matches[0]
        if (hit) openInSide(hit.path, side)
      } catch {
        /* unresolved link: no-op (the editor renders it as a calm dangling link) */
      }
    },
    [openInSide]
  )

  // ── Frontmatter import (⌘O + drag-drop) ──

  /** Read a set of paths into {path, content}, keeping only `.md` files. */
  const readImportFiles = useCallback(async (paths: string[]) => {
    const md = paths.filter((p) => p.endsWith('.md'))
    if (md.length === 0) return
    const { readTextFile } = await getTauriFns()
    const files = await Promise.all(
      md.map(async (p) => ({ path: p, content: await readTextFile(p).catch(() => '') })),
    )
    setImportFiles(files)
  }, [])

  const openImportPicker = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (!selected) return
    await readImportFiles(Array.isArray(selected) ? selected : [selected])
  }, [readImportFiles])

  // Drag-and-drop `.md` files onto the window opens the import flow. The veil
  // (draggingImport) is shown only while markdown files are over the window.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      const u = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter') {
          setDraggingImport(p.paths.some((x) => x.endsWith('.md')))
        } else if (p.type === 'leave') {
          setDraggingImport(false)
        } else if (p.type === 'drop') {
          setDraggingImport(false)
          readImportFiles(p.paths)
        }
      })
      if (cancelled) u()
      else unlisten = u
    })()
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [readImportFiles])

  // ── New file modal ──

  const handleFileCreated = useCallback((filePath: string) => {
    setShowNewModal(false)
    openInSide(filePath, 'left')
    runSearch(searchQuery, activeType, activeProject)
  }, [openInSide, runSearch, searchQuery, activeType, activeProject])

  // ── Right-panel toggle ──

  const toggleRightPanel = useCallback(() => {
    setRightOpen((open) => {
      if (open) return false
      // Opening: if the right panel has no tabs, seed it with the last-used file
      // as its first document tab so the split opens on something useful.
      setRightPanel((prev) => {
        if (prev.tabs.length > 0) return prev
        const last = lastOpenedPathRef.current ?? leftPanel.activeTabId
        if (last) {
          loadFile(last)
          return { tabs: [{ path: last }], activeTabId: last }
        }
        return prev
      })
      return true
    })
  }, [leftPanel.activeTabId, loadFile])

  const closeRightPanel = useCallback(() => setRightOpen(false), [])

  // The panel the keyboard currently targets. Kept in a ref so the keydown
  // listener (bound once) always reads the latest value without re-binding.
  const focusedSideRef = useRef<PanelSide>('left')
  useEffect(() => {
    // A closed right panel can never hold focus; fall back to the left.
    focusedSideRef.current = rightOpen ? focusedSide : 'left'
  }, [focusedSide, rightOpen])

  // Latest panel state, mirrored into refs so the keydown listener (bound once)
  // can read tab state without being a dependency.
  const leftPanelRef = useRef(leftPanel)
  const rightPanelRef = useRef(rightPanel)
  useEffect(() => { leftPanelRef.current = leftPanel }, [leftPanel])
  useEffect(() => { rightPanelRef.current = rightPanel }, [rightPanel])

  // ── Global history navigation (TIN-1705) ──
  // A single back/forward trail across the whole app, VS Code style: each visited
  // location is a destination (a full view) plus, in the workspace, the focused
  // panel's active document. ⌘[ / ⌘] (and the top-bar arrows) retrace it.

  // The location the focused panel currently shows: in the workspace it's the
  // focused side's active document (null = Search); other views are the location.
  const focusedActiveTab =
    (focusedSide === 'right' && rightOpen ? rightPanel : leftPanel).activeTabId

  const navHistoryRef = useRef<{ stack: NavLoc[]; index: number }>({ stack: [], index: -1 })
  // Set while a back/forward is being applied so the recording effect doesn't
  // capture the programmatic navigation as a new location.
  const navApplyingRef = useRef(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  // Apply a recorded location: switch the view and, in the workspace, re-select
  // the focused side's document (or Search). Suppresses re-recording.
  const applyNavLoc = useCallback((loc: NavLoc) => {
    navApplyingRef.current = true
    setActiveView(loc.view)
    if (loc.view === 'workspace') {
      const side = focusedSideRef.current
      if (loc.doc) openInSide(loc.doc, side)
      else selectSearch(side)
    }
  }, [openInSide, selectSearch])

  // Record each new location as it's reached (dedupe consecutive duplicates,
  // truncate any forward trail). While applying a back/forward, wait until the
  // state settles onto the target, then resume recording.
  useEffect(() => {
    const loc: NavLoc = { view: activeView, doc: activeView === 'workspace' ? focusedActiveTab : null }
    const h = navHistoryRef.current
    if (navApplyingRef.current) {
      const target = h.stack[h.index]
      if (target && target.view === loc.view && target.doc === loc.doc) {
        navApplyingRef.current = false
      }
      return
    }
    const current = h.stack[h.index]
    if (current && current.view === loc.view && current.doc === loc.doc) return
    const stack = h.stack.slice(0, h.index + 1)
    stack.push(loc)
    h.stack = stack
    h.index = stack.length - 1
    setCanBack(h.index > 0)
    setCanForward(false)
  }, [activeView, focusedActiveTab])

  const goBack = useCallback(() => {
    const h = navHistoryRef.current
    if (h.index <= 0) return
    h.index -= 1
    setCanBack(h.index > 0)
    setCanForward(h.index < h.stack.length - 1)
    applyNavLoc(h.stack[h.index])
  }, [applyNavLoc])

  const goForward = useCallback(() => {
    const h = navHistoryRef.current
    if (h.index >= h.stack.length - 1) return
    h.index += 1
    setCanBack(h.index > 0)
    setCanForward(h.index < h.stack.length - 1)
    applyNavLoc(h.stack[h.index])
  }, [applyNavLoc])

  // ── Keyboard shortcuts ──

  // Load the Diff tab's working directory from settings (first agent's cwd).
  useEffect(() => {
    getSettings()
      .then((s) => {
        const cwd = s.agents?.[0]?.cwd
        if (cwd) setActiveWorkingDir(cwd)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey

      if (mod && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (mod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        if (e.shiftKey) setShowQuickCapture(true)
        else setShowNewModal(true)
        return
      }
      if (mod && e.key === '\\') {
        e.preventDefault()
        toggleRightPanel()
        return
      }
      if (mod && e.key === '[') {
        // Global history: step back through visited locations (TIN-1705).
        e.preventDefault()
        goBack()
        return
      }
      if (mod && e.key === ']') {
        // Global history: step forward.
        e.preventDefault()
        goForward()
        return
      }
      if (mod && e.key === 'f') {
        e.preventDefault()
        // Return to the workspace and focus the focused panel's Search tab.
        setActiveView('workspace')
        selectSearch(focusedSideRef.current)
        return
      }
      if (mod && (e.key === 'w' || e.key === 'W')) {
        // Close the focused panel's active document tab. No-op on Search.
        const side = focusedSideRef.current
        const panel = side === 'left' ? leftPanelRef.current : rightPanelRef.current
        if (panel.activeTabId) {
          e.preventDefault()
          closeDoc(side, panel.activeTabId)
        }
        return
      }
      if (e.ctrlKey && (e.key === 'Tab' || e.code === 'Tab')) {
        // ⌃Tab / ⌃⇧Tab cycle tabs in the focused panel (wrap, Search included).
        e.preventDefault()
        cycleTab(focusedSideRef.current, e.shiftKey ? -1 : 1)
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      if (mod && e.key === 'd') {
        // Open the Changes view (working-directory diffs).
        e.preventDefault()
        setActiveView((v) => (v === 'changes' ? 'workspace' : 'changes'))
        return
      }
      if (mod && (e.key === 'r' || e.key === 'R')) {
        // Launch is a rail destination now (TIN-1707): ⌘R toggles the Launch view,
        // mirroring ⌘G / ⌘T, not a modal open.
        e.preventDefault()
        setActiveView((v) => (v === 'launch' ? 'workspace' : 'launch'))
        return
      }
      if (mod && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        setActiveView((v) => (v === 'transcripts' ? 'workspace' : 'transcripts'))
        return
      }
      if (mod && (e.key === 'g' || e.key === 'G')) {
        // Toggle the knowledge graph view (TIN-1639).
        e.preventDefault()
        setActiveView((v) => (v === 'graph' ? 'workspace' : 'graph'))
        return
      }
      if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        // Frontmatter audit view (TIN-1638).
        e.preventDefault()
        setActiveView((v) => (v === 'frontmatter' ? 'workspace' : 'frontmatter'))
        return
      }
      if (mod && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        // Import markdown files (TIN-1638).
        e.preventDefault()
        openImportPicker()
        return
      }
      if (mod && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        // Consistency audit (TIN-1695).
        e.preventDefault()
        setActiveView((v) => (v === 'consistency' ? 'workspace' : 'consistency'))
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleRightPanel, selectSearch, closeDoc, cycleTab, goBack, goForward])

  // The launcher hands a composed run to the terminal: slide it up, then spawn.
  const handleLaunch = useCallback((req: RunRequest) => {
    setTerminalOpen(true)
    // Let the terminal mount/init before invoking its run handler.
    setTimeout(() => runRef.current?.(req), 60)
  }, [])

  // ── Derived ──

  // The active document for a panel = the tab whose path is activeTabId.
  const leftActiveDoc = leftPanel.tabs.find((t) => t.path === leftPanel.activeTabId) ?? null
  const rightActiveDoc = rightPanel.tabs.find((t) => t.path === rightPanel.activeTabId) ?? null

  const leftLoaded = leftActiveDoc ? files[leftActiveDoc.path] ?? null : null
  const rightLoaded = rightActiveDoc ? files[rightActiveDoc.path] ?? null : null

  const lookupLoaded = useCallback((path: string): LoadedFile | null => files[path] ?? null, [files])


  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: '100vh',
        background: color.bgApp,
        color: color.ink,
        fontFamily: font.sans,
        overflow: 'hidden',
      }}
    >
      {/* Persistent nav rail — destinations (rooms); the top bar holds verbs. */}
      <NavRail
        active={activeView === 'workspace' ? 'search' : (activeView as RailDest)}
        onSelect={(d) => {
          if (d === 'search') { setActiveView('workspace'); selectSearch(focusedSideRef.current) }
          else setActiveView(d)
        }}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main column — workspace, or the active full view, right of the rail. The
          one persistent, context-aware top bar (TIN-1708) is always the first
          child, above whatever view is active. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative' }}>
        <TopBar
          variant={activeView === 'workspace' ? 'wordmark' : 'title'}
          title={activeView === 'workspace' ? undefined : ROOM_TITLE[activeView]}
          canBack={canBack}
          canForward={canForward}
          onBack={goBack}
          onForward={goForward}
          right={
            activeView === 'workspace' ? (
              <Button variant="primary" size="sm" onClick={() => setShowNewModal(true)} title="New memory file (⌘N)">
                + New memory
              </Button>
            ) : (
              viewRight
            )
          }
        />

        <TopBarSlotProvider value={{ setRight: setViewRight }}>
        {activeView === 'workspace' && (
          <>
      {/* Body: one or two panels */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* LEFT panel — always present, flexes to leftWidth when split is open */}
        <div
          onMouseDownCapture={() => setFocusedSide('left')}
          onFocusCapture={() => setFocusedSide('left')}
          style={{
            display: 'flex',
            flexBasis: rightOpen ? `${leftWidth}%` : '100%',
            flexGrow: rightOpen ? 0 : 1,
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <WorkspacePanel
            side="left"
            tabs={leftPanel.tabs}
            activeTabId={leftPanel.activeTabId}
            onSelectSearch={() => selectSearch('left')}
            onSelectDoc={(p) => selectDoc('left', p)}
            onCloseDoc={(p) => closeDoc('left', p)}
            onAddDoc={() => selectSearch('left')}
            onToggleSplit={toggleRightPanel}
            splitOpen={rightOpen}
            activePath={leftActiveDoc?.path ?? null}
            loaded={leftLoaded}
            loadedByPath={lookupLoaded}
            searchQuery={searchQuery}
            searching={searching}
            searchResults={searchResults}
            knownTypes={knownTypes}
            knownProjects={knownProjects}
            activeType={activeType}
            activeProject={activeProject}
            onSearchChange={handleSearchChange}
            onTypeFilter={handleTypeFilter}
            onProjectFilter={handleProjectFilter}
            searchInputRef={searchRef}
            onOpenResult={makeOpenResult('left')}
            onOpenTicket={setActiveTicket}
            onOpenWikiLink={makeOpenWikiLink('left')}
            onEditorChange={makeEditorChange(leftActiveDoc?.path ?? null)}
            onEditorSave={makeEditorSave(leftActiveDoc?.path ?? null)}
          />
        </div>

        {/* Divider — only when split is open */}
        {rightOpen && (
          <PanelDivider
            onResize={(pct) => setLeftWidth(pct)}
            onSnap={() => setLeftWidth(50)}
          />
        )}

        {/* RIGHT panel — kept mounted (display:none) when closed to preserve state */}
        <div
          onMouseDownCapture={() => setFocusedSide('right')}
          onFocusCapture={() => setFocusedSide('right')}
          style={{
            display: rightOpen ? 'flex' : 'none',
            flexBasis: `${100 - leftWidth}%`,
            flexGrow: 0,
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            borderLeft: `1px solid ${color.hairSoft}`,
          }}
        >
          <WorkspacePanel
            side="right"
            tabs={rightPanel.tabs}
            activeTabId={rightPanel.activeTabId}
            onSelectSearch={() => selectSearch('right')}
            onSelectDoc={(p) => selectDoc('right', p)}
            onCloseDoc={(p) => closeDoc('right', p)}
            onAddDoc={() => selectSearch('right')}
            showClose
            onClose={closeRightPanel}
            activePath={rightActiveDoc?.path ?? null}
            loaded={rightLoaded}
            loadedByPath={lookupLoaded}
            searchQuery={searchQuery}
            searching={searching}
            searchResults={searchResults}
            knownTypes={knownTypes}
            knownProjects={knownProjects}
            activeType={activeType}
            activeProject={activeProject}
            onSearchChange={handleSearchChange}
            onTypeFilter={handleTypeFilter}
            onProjectFilter={handleProjectFilter}
            onOpenResult={makeOpenResult('right')}
            onOpenTicket={setActiveTicket}
            onOpenWikiLink={makeOpenWikiLink('right')}
            onEditorChange={makeEditorChange(rightActiveDoc?.path ?? null)}
            onEditorSave={makeEditorSave(rightActiveDoc?.path ?? null)}
          />
        </div>
      </div>
          </>
        )}

        {activeView === 'graph' && (
          <GraphView
            onOpenFile={(path) => { setActiveView('workspace'); openInSide(path, focusedSideRef.current) }}
            onOpenTicket={(id) => { setActiveTicket(id) }}
            onClose={() => setActiveView('workspace')}
          />
        )}
        {activeView === 'frontmatter' && (
          <AuditView
            onClose={() => setActiveView('workspace')}
            onOpenFile={(path) => { setActiveView('workspace'); openInSide(path, focusedSideRef.current) }}
            knownTypes={knownTypes}
            knownProjects={knownProjects}
          />
        )}
        {activeView === 'consistency' && (
          <ConsistencyView
            onOpenFile={(path, e) => {
              const side = e.metaKey || e.ctrlKey ? otherSide(focusedSideRef.current) : focusedSideRef.current
              setActiveView('workspace')
              openInSide(path, side)
            }}
            onClose={() => setActiveView('workspace')}
          />
        )}
        {activeView === 'launch' && (
          <Launcher
            asView
            open
            onClose={() => setActiveView('workspace')}
            onRun={handleLaunch}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
        {activeView === 'transcripts' && (
          <TranscriptBrowser onClose={() => setActiveView('workspace')} />
        )}
        {activeView === 'changes' && (
          <ChangesView onClose={() => setActiveView('workspace')} />
        )}
        </TopBarSlotProvider>
      </div>

      {/* Modals / overlays */}
      {showNewModal && (
        <NewFileModal
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onClose={() => setShowNewModal(false)}
          onCreated={handleFileCreated}
          onOpenConflict={(path) => openInSide(path, focusedSideRef.current)}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(path) => { openInSide(path, 'left') }}
        memoryRoot={MEMORY_ROOT}
      />

      {/* Terminal and Linear panels (unchanged) */}
      <TerminalPanel
        isOpen={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        spawnRef={spawnClaudeRef}
        runRef={runRef}
      />
      <LinearPanel
        ticketId={activeTicket}
        onClose={() => setActiveTicket(null)}
      />

      {/* Frontmatter import flow (⌘O / drag-drop) — TIN-1638 */}
      {importFiles && importFiles.length > 0 && (
        <ImportModal
          files={importFiles}
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onClose={() => setImportFiles(null)}
          onImported={(paths) => {
            setImportFiles(null)
            runSearch(searchQuery, activeType, activeProject)
            if (paths.length === 1) openInSide(paths[0], focusedSideRef.current)
          }}
        />
      )}

      {/* Calm drag-to-import veil — shown only while .md files are over the window */}
      {draggingImport && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: color.neutralTint,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              border: `2px dashed ${color.forestLine}`,
              borderRadius: radius.lg,
              padding: `${space[7]}px ${space[8]}px`,
              background: color.bgRaised,
              boxShadow: shadow.modal,
              textAlign: 'center',
            }}
          >
            <div style={{ fontFamily: font.serif, fontSize: 18, color: color.ink, marginBottom: space[2] }}>
              Drop Markdown files to import.
            </div>
            <div style={{ fontFamily: font.sans, fontSize: 11, color: color.inkFaint }}>
              We’ll describe each one before anything is saved.
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal open onClose={() => setShowSettings(false)} />
      )}

      {showQuickCapture && (
        <QuickCapture
          open
          onClose={() => setShowQuickCapture(false)}
          onSaved={(path, project) => {
            setShowQuickCapture(false)
            setToast({ message: `Saved to ${project}.`, path })
          }}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          actionLabel="Open"
          onAction={() => { openInSide(toast.path, 'left'); setToast(null) }}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}
