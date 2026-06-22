'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import matter from 'gray-matter'
import LinearPanel from '@/components/LinearPanel'
import TerminalPanel, { RunRequest } from '@/components/TerminalPanel'
import Launcher from '@/components/Launcher'
import TranscriptBrowser from '@/components/TranscriptBrowser'
import CommandPalette from '@/components/CommandPalette'
import WorkspacePanel from '@/components/WorkspacePanel'
import PanelDivider from '@/components/PanelDivider'
import TypeChip from '@/components/TypeChip'
import SettingsModal from '@/components/SettingsModal'
import QuickCapture from '@/components/QuickCapture'
import Toast from '@/components/Toast'
import { getSettings } from '@/lib/settings'
import { slugify } from '@/lib/slug'
import { color, radius, space, font, shadow } from '@/lib/tokens'
import {
  MemorySearchResult,
  OpenDoc,
  PanelSide,
  PanelState,
  PanelTab,
  LegacyPanelState,
  LoadedFile,
} from '@/lib/types'

const MEMORY_ROOT = '/Users/rob/Projects/tfl/memory'
const RECENTS_KEY = 'agent-studio-recents'
const RECENTS_MAX = 8
const LAYOUT_KEY = 'agent-studio-layout'

// ── Helpers ──────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}


const otherSide = (side: PanelSide): PanelSide => (side === 'left' ? 'right' : 'left')

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

async function createFile(body: {
  name: string
  slug: string
  type: string
  projects: string | string[]
  tags?: string[]
}): Promise<{ path?: string; error?: string }> {
  try {
    const path = await invoke<string>('create_file', {
      payload: {
        name: body.name,
        slug: body.slug,
        fileType: body.type,
        projects: Array.isArray(body.projects) ? body.projects : [body.projects],
        tags: body.tags ?? [],
      },
    })
    return { path }
  } catch (err) {
    return { error: String(err) }
  }
}

// ── New-file modal ────────────────────────────────────────────────────────────

interface NewFileModalProps {
  knownTypes: string[]
  knownProjects: string[]
  onClose: () => void
  onCreated: (filePath: string) => void
}

function NewFileModal({ knownTypes, knownProjects, onClose, onCreated }: NewFileModalProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState(knownTypes[0] ?? 'feedback')
  const [projects, setProjects] = useState<string[]>(knownProjects.length > 0 ? [knownProjects[0]] : [])
  const [tags, setTags] = useState('')
  const [customType, setCustomType] = useState('')
  const [customProject, setCustomProject] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const slug = slugify(name)

  const effectiveType = type === '__custom__' ? customType : type
  const allProjects = [
    ...projects.filter((p) => p !== '__custom__'),
    ...(projects.includes('__custom__') && customProject ? [customProject] : []),
  ]

  async function handleCreate() {
    if (!name.trim()) { setError('Name is required'); return }
    if (!effectiveType.trim()) { setError('Type is required'); return }
    if (allProjects.length === 0) { setError('At least one project is required'); return }

    setCreating(true)
    setError('')
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
      const result = await createFile({
        name: name.trim(),
        slug,
        type: effectiveType,
        projects: allProjects,
        tags: tagList,
      })
      if (result.error) {
        setError(result.error)
        setCreating(false)
      } else if (result.path) {
        onCreated(result.path)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file')
      setCreating(false)
    }
  }

  function toggleProject(p: string) {
    setProjects((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    )
  }

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

        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
          <label style={labelStyle}>Name</label>
          <input
            autoFocus
            type="text"
            placeholder="EAS build gate"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
            style={inputStyle}
          />
          {slug && (
            <div style={{ fontSize: 10, color: color.inkFaint, paddingLeft: 2 }}>
              Slug: {slug}
            </div>
          )}
        </div>

        {/* Type */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <label style={labelStyle}>Type</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
            {['feedback', 'project', 'user', 'reference', ...knownTypes.filter((t) => !['feedback','project','user','reference'].includes(t))].map((t) => (
              <TypeChip key={t} label={t} active={type === t} onClick={() => setType(t)} />
            ))}
            <TypeChip label="+ custom" active={type === '__custom__'} onClick={() => setType('__custom__')} />
          </div>
          {type === '__custom__' && (
            <input
              type="text"
              placeholder="custom type"
              value={customType}
              onChange={(e) => setCustomType(e.target.value)}
              style={inputStyle}
            />
          )}
        </div>

        {/* Projects */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <label style={labelStyle}>Project(s)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
            {knownProjects.map((p) => (
              <TypeChip key={p} label={p} active={projects.includes(p)} onClick={() => toggleProject(p)} />
            ))}
            <TypeChip label="+ custom" active={projects.includes('__custom__')} onClick={() => toggleProject('__custom__')} />
          </div>
          {projects.includes('__custom__') && (
            <input
              type="text"
              placeholder="project-name"
              value={customProject}
              onChange={(e) => setCustomProject(e.target.value)}
              style={inputStyle}
            />
          )}
        </div>

        {/* Tags */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
          <label style={labelStyle}>Tags (comma-separated, optional)</label>
          <input
            type="text"
            placeholder="builds, eas, poppy"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            style={inputStyle}
          />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: color.notice, padding: '6px 10px', background: 'rgba(155,123,90,0.08)', borderRadius: radius.md }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end', marginTop: space[1] }}>
          <button onClick={onClose} style={secondaryBtnStyle}>Cancel</button>
          <button onClick={handleCreate} disabled={creating} style={primaryBtnStyle}>
            {creating ? 'Creating…' : 'Create file'}
          </button>
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

const primaryBtnStyle: React.CSSProperties = {
  background: color.forest,
  color: '#fff',
  border: 'none',
  borderRadius: radius.md,
  padding: '7px 16px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: font.sans,
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: color.inkSoft,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  padding: '7px 16px',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: font.sans,
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

  // Legacy shape → migrate.
  const legacy = raw as Partial<LegacyPanelState>
  if (legacy.activePath) {
    const surface: PanelTab = legacy.activeTab ?? 'content'
    return { tabs: [{ path: legacy.activePath, surface }], activeTabId: legacy.activePath }
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
  const [activeWorkingDir, setActiveWorkingDir] = useState('')
  const [activeTicket, setActiveTicket] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [showLauncher, setShowLauncher] = useState(false)
  const [showTranscripts, setShowTranscripts] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
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
        tabs: [...prev.tabs, { path: filePath, surface: 'content' }],
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

  // Set the active document tab's surface (Content / Links / Diff) in a panel.
  const setSurface = useCallback((side: PanelSide, surface: PanelTab) => {
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => {
      if (prev.activeTabId === null) return prev
      return {
        ...prev,
        tabs: prev.tabs.map((t) => (t.path === prev.activeTabId ? { ...t, surface } : t)),
      }
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

  const saveFile = useCallback(async (filePath: string, content: string) => {
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
    saveFile(filePath, latestMarkdownRef.current[filePath] ?? '')
  }, [saveFile])

  // ── Open-result handler (⌘-click routes to the OTHER panel) ──

  const makeOpenResult = useCallback(
    (side: PanelSide) => (result: MemorySearchResult, e: React.MouseEvent) => {
      const target = e.metaKey || e.ctrlKey ? otherSide(side) : side
      openInSide(result.path, target, result)
    },
    [openInSide]
  )

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
          return { tabs: [{ path: last, surface: 'content' }], activeTabId: last }
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
      if (mod && e.key === 'f') {
        e.preventDefault()
        // Select the focused panel's Search tab and focus the field.
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
        e.preventDefault()
        // Show the diff alongside the file: open the right panel and put its
        // active document tab on the Diff surface.
        setRightOpen(true)
        setRightPanel((prev) => {
          if (prev.activeTabId === null) return prev
          return {
            ...prev,
            tabs: prev.tabs.map((t) => (t.path === prev.activeTabId ? { ...t, surface: 'diff' } : t)),
          }
        })
        return
      }
      if (mod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        setShowLauncher(true)
        return
      }
      if (mod && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        setShowTranscripts(true)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleRightPanel, selectSearch, closeDoc, cycleTab])

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

  // Top-bar context follows the most relevant panel: the right when open, else left.
  const focusPanel = rightOpen && rightPanel.activeTabId ? rightPanel : leftPanel
  const focusLoaded = focusPanel.activeTabId ? files[focusPanel.activeTabId] ?? null : null
  const inEditor = focusPanel.activeTabId !== null
  const wordCount = countWords(focusLoaded?.content ?? '')

  const goHome = useCallback(() => {
    selectSearch('left')
  }, [selectSearch])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: color.bgApp,
        color: color.ink,
        fontFamily: font.sans,
        overflow: 'hidden',
      }}
    >
      {/* Top bar */}
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
        {/* Wordmark / back button */}
        <button
          onClick={goHome}
          style={{
            fontFamily: "'Fraunces', 'Georgia', serif",
            fontSize: 15,
            fontWeight: 600,
            color: color.forest,
            letterSpacing: '-0.01em',
            flexShrink: 0,
            minWidth: 120,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textAlign: 'left',
          }}
        >
          {inEditor ? '← Agent Studio' : 'Agent Studio'}
        </button>

        {/* Center: filename when in editor */}
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12, color: color.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {inEditor && focusLoaded?.meta?.name}
        </div>

        {/* Right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: space[4], flexShrink: 0, minWidth: 160, justifyContent: 'flex-end' }}>
          {inEditor && (
            <span style={{ fontSize: 12, color: color.inkSoft }}>
              {isSaving ? 'Saving…' : `${wordCount.toLocaleString()} words`}
            </span>
          )}
          <button
            onClick={toggleRightPanel}
            title="Toggle right panel (⌘\)"
            aria-pressed={rightOpen}
            style={{
              background: rightOpen ? color.forestTint : 'transparent',
              color: rightOpen ? color.forest : color.inkSoft,
              border: `1px solid ${rightOpen ? color.forestLine : color.line}`,
              borderRadius: radius.md,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: font.sans,
            }}
          >
            Split
          </button>
          <button onClick={() => setShowNewModal(true)} title="New memory file (⌘N)" style={primaryBtnStyle}>
            + New
          </button>
          <button
            onClick={() => setShowLauncher(true)}
            title="Launch (⌘R)"
            style={{
              background: color.forest,
              color: '#fff',
              border: 'none',
              borderRadius: radius.md,
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: font.sans,
            }}
          >
            Launch
          </button>
          <button
            onClick={() => setShowTranscripts(true)}
            title="Transcripts (⌘T)"
            aria-label="Transcripts"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              background: 'transparent',
              color: color.inkSoft,
              border: `1px solid ${color.line}`,
              borderRadius: radius.md,
              cursor: 'pointer',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings (⌘,)"
            aria-label="Settings"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              background: 'transparent',
              color: color.inkSoft,
              border: `1px solid ${color.line}`,
              borderRadius: radius.md,
              cursor: 'pointer',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

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
            workingDir={activeWorkingDir}
            tabs={leftPanel.tabs}
            activeTabId={leftPanel.activeTabId}
            onSelectSearch={() => selectSearch('left')}
            onSelectDoc={(p) => selectDoc('left', p)}
            onCloseDoc={(p) => closeDoc('left', p)}
            onAddDoc={() => selectSearch('left')}
            onSelectSurface={(s) => setSurface('left', s)}
            activePath={leftActiveDoc?.path ?? null}
            activeSurface={leftActiveDoc?.surface ?? 'content'}
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
            workingDir={activeWorkingDir}
            tabs={rightPanel.tabs}
            activeTabId={rightPanel.activeTabId}
            onSelectSearch={() => selectSearch('right')}
            onSelectDoc={(p) => selectDoc('right', p)}
            onCloseDoc={(p) => closeDoc('right', p)}
            onAddDoc={() => selectSearch('right')}
            onSelectSurface={(s) => setSurface('right', s)}
            showClose
            onClose={closeRightPanel}
            activePath={rightActiveDoc?.path ?? null}
            activeSurface={rightActiveDoc?.surface ?? 'content'}
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
            onEditorChange={makeEditorChange(rightActiveDoc?.path ?? null)}
            onEditorSave={makeEditorSave(rightActiveDoc?.path ?? null)}
          />
        </div>
      </div>

      {/* Modals / overlays */}
      {showNewModal && (
        <NewFileModal
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onClose={() => setShowNewModal(false)}
          onCreated={handleFileCreated}
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

      {showSettings && (
        <SettingsModal open onClose={() => setShowSettings(false)} />
      )}

      <Launcher
        open={showLauncher}
        onClose={() => setShowLauncher(false)}
        onRun={handleLaunch}
        onOpenSettings={() => { setShowLauncher(false); setShowSettings(true) }}
      />

      {showTranscripts && (
        <TranscriptBrowser onClose={() => setShowTranscripts(false)} />
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
