'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import matter from 'gray-matter'
import LinearPanel from '@/components/LinearPanel'
import TerminalPanel from '@/components/TerminalPanel'
import CommandPalette from '@/components/CommandPalette'
import WorkspacePanel from '@/components/WorkspacePanel'
import PanelDivider from '@/components/PanelDivider'
import TypeChip from '@/components/TypeChip'
import { color, radius, space, font, shadow } from '@/lib/tokens'
import {
  MemorySearchResult,
  PanelSide,
  PanelState,
  PanelTab,
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
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

const DEFAULT_PANEL: PanelState = { activePath: null, activeTab: 'content' }

function loadLayout(): PersistedLayout {
  const fallback: PersistedLayout = {
    left: { ...DEFAULT_PANEL },
    right: { ...DEFAULT_PANEL },
    rightOpen: false,
    leftWidth: 50,
  }
  try {
    const stored = localStorage.getItem(LAYOUT_KEY)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Partial<PersistedLayout>
    return {
      left: parsed.left ?? fallback.left,
      right: parsed.right ?? fallback.right,
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
  const [leftPanel, setLeftPanel] = useState<PanelState>(DEFAULT_PANEL)
  const [rightPanel, setRightPanel] = useState<PanelState>(DEFAULT_PANEL)
  const [rightOpen, setRightOpen] = useState(false)
  const [leftWidth, setLeftWidth] = useState(50)
  const [layoutReady, setLayoutReady] = useState(false)

  const [recentPaths, setRecentPaths] = useState<string[]>([])

  // UI state
  const [showNewModal, setShowNewModal] = useState(false)
  const [activeTicket, setActiveTicket] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const spawnClaudeRef = useRef<((filePath: string | null) => void) | null>(null)

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
    lastOpenedPathRef.current = layout.right.activePath ?? layout.left.activePath

    // Restore file contents for whatever was open in each panel
    const toRestore = new Set<string>()
    if (layout.left.activePath) toRestore.add(layout.left.activePath)
    if (layout.right.activePath) toRestore.add(layout.right.activePath)
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

  // Open a file into a specific panel side. Opening into the right panel reveals it.
  const openInSide = useCallback((filePath: string, side: PanelSide, meta?: MemorySearchResult) => {
    if (side === 'right') setRightOpen(true)
    const setter = side === 'left' ? setLeftPanel : setRightPanel
    setter((prev) => ({ ...prev, activePath: filePath }))
    loadFile(filePath, meta)
  }, [loadFile])

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
      // Opening: restore the last-used file into the right panel if it's empty.
      setRightPanel((prev) => {
        if (prev.activePath) return prev
        const last = lastOpenedPathRef.current ?? leftPanel.activePath
        if (last) {
          loadFile(last)
          return { ...prev, activePath: last }
        }
        return prev
      })
      return true
    })
  }, [leftPanel.activePath, loadFile])

  const closeRightPanel = useCallback(() => setRightOpen(false), [])

  // ── Keyboard shortcuts ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey

      if (mod && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (mod && e.key === 'n') {
        e.preventDefault()
        setShowNewModal(true)
        return
      }
      if (mod && e.key === '\\') {
        e.preventDefault()
        toggleRightPanel()
        return
      }
      if (mod && e.key === 'f') {
        e.preventDefault()
        setLeftPanel((prev) => ({ ...prev, activePath: null }))
        setTimeout(() => searchRef.current?.focus(), 50)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleRightPanel])

  // ── Derived ──

  const leftLoaded = leftPanel.activePath ? files[leftPanel.activePath] ?? null : null
  const rightLoaded = rightPanel.activePath ? files[rightPanel.activePath] ?? null : null

  // Top-bar context follows the most relevant panel: the right when open, else left.
  const focusPanel = rightOpen && rightPanel.activePath ? rightPanel : leftPanel
  const focusLoaded = focusPanel.activePath ? files[focusPanel.activePath] ?? null : null
  const inEditor = focusPanel.activePath !== null
  const wordCount = countWords(focusLoaded?.content ?? '')

  const setLeftTab = useCallback((tab: PanelTab) => setLeftPanel((p) => ({ ...p, activeTab: tab })), [])
  const setRightTab = useCallback((tab: PanelTab) => setRightPanel((p) => ({ ...p, activeTab: tab })), [])

  const goHome = useCallback(() => {
    setLeftPanel((p) => ({ ...p, activePath: null }))
  }, [])

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
            onClick={() => alert('Coming soon')}
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
            Spawn Claude
          </button>
        </div>
      </header>

      {/* Body: one or two panels */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* LEFT panel — always present, flexes to leftWidth when split is open */}
        <div
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
            activeTab={leftPanel.activeTab}
            onSelectTab={setLeftTab}
            activePath={leftPanel.activePath}
            loaded={leftLoaded}
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
            onEditorChange={makeEditorChange(leftPanel.activePath)}
            onEditorSave={makeEditorSave(leftPanel.activePath)}
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
            activeTab={rightPanel.activeTab}
            onSelectTab={setRightTab}
            showClose
            onClose={closeRightPanel}
            activePath={rightPanel.activePath}
            loaded={rightLoaded}
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
            onEditorChange={makeEditorChange(rightPanel.activePath)}
            onEditorSave={makeEditorSave(rightPanel.activePath)}
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
      />
      <LinearPanel
        ticketId={activeTicket}
        onClose={() => setActiveTicket(null)}
      />
    </div>
  )
}
