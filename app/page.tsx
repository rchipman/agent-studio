'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import matter from 'gray-matter'
import LinearPanel from '@/components/LinearPanel'
import TerminalPanel from '@/components/TerminalPanel'
import CommandPalette from '@/components/CommandPalette'
import { MemorySearchResult } from '@/lib/types'

const MarkdownEditor = dynamic(() => import('@/components/MarkdownEditor'), { ssr: false })

const MEMORY_ROOT = '/Users/rob/Projects/tfl/memory'
const RECENTS_KEY = 'agent-studio-recents'
const RECENTS_MAX = 8

// ── Helpers ──────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

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
  const url = new URL('/api/search', window.location.origin)
  if (params.q) url.searchParams.set('q', params.q)
  if (params.type) url.searchParams.set('type', params.type)
  if (params.project) url.searchParams.set('project', params.project)
  if (params.init) url.searchParams.set('init', 'true')
  const res = await fetch(url.toString())
  return res.json() as Promise<SearchApiResponse>
}

async function createFile(body: {
  name: string
  slug: string
  type: string
  projects: string | string[]
  tags?: string[]
}): Promise<{ path?: string; error?: string }> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ path?: string; error?: string }>
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: '12px',
        border: active ? '1.5px solid #3E5641' : '1px solid rgba(38,35,32,0.18)',
        background: active ? '#3E5641' : 'transparent',
        color: active ? '#fff' : '#6B6760',
        fontSize: '11px',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontFamily: 'system-ui, sans-serif',
        transition: 'all 0.12s ease',
      }}
    >
      {label}
    </button>
  )
}

function MetaBar({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        marginBottom: '4px',
      }}
    >
      {result.type && (
        <span
          style={{
            padding: '1px 7px',
            borderRadius: '9px',
            background: 'rgba(62,86,65,0.10)',
            color: '#3E5641',
            fontSize: '10px',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          {result.type}
        </span>
      )}
      {projects.map((p) => (
        <span
          key={p}
          style={{
            padding: '1px 7px',
            borderRadius: '9px',
            background: 'rgba(155,123,90,0.10)',
            color: '#9B7B5A',
            fontSize: '10px',
            fontWeight: 500,
          }}
        >
          {p}
        </span>
      ))}
      {dateStr && (
        <span style={{ fontSize: '10px', color: '#9B9490', marginLeft: 'auto' }}>
          {dateStr}
        </span>
      )}
    </div>
  )
}

function ResultCard({
  result,
  active,
  onClick,
}: {
  result: MemorySearchResult
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '12px 16px',
        background: active ? 'rgba(62,86,65,0.06)' : 'rgba(255,255,255,0.55)',
        border: active ? '1.5px solid rgba(62,86,65,0.30)' : '1px solid rgba(38,35,32,0.08)',
        borderRadius: '8px',
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        marginBottom: '6px',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.85)'
          e.currentTarget.style.borderColor = 'rgba(38,35,32,0.15)'
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.55)'
          e.currentTarget.style.borderColor = 'rgba(38,35,32,0.08)'
        }
      }}
    >
      <MetaBar result={result} />
      <div
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: '#262320',
          marginBottom: '3px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {result.name}
      </div>
      {result.excerpt && (
        <div
          style={{
            fontSize: '11px',
            color: '#6B6760',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: '1.4',
          }}
        >
          {result.excerpt}
        </div>
      )}
    </button>
  )
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
        background: 'rgba(38,35,32,0.45)',
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
          background: '#FCFAF4',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(38,35,32,0.25)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="new-file-modal-title" style={{ fontSize: '15px', fontWeight: 700, color: '#262320' }}>
          New memory file
        </div>

        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ fontSize: '11px', fontWeight: 600, color: '#6B6760', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Name
          </label>
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
            <div style={{ fontSize: '10px', color: '#9B9490', paddingLeft: '2px' }}>
              Slug: {slug}
            </div>
          )}
        </div>

        {/* Type */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={labelStyle}>Type</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={labelStyle}>Project(s)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
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
          <div style={{ fontSize: '12px', color: '#B04040', padding: '6px 10px', background: 'rgba(176,64,64,0.08)', borderRadius: '6px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
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
  border: '1px solid rgba(38,35,32,0.18)',
  borderRadius: '6px',
  background: 'rgba(255,255,255,0.7)',
  color: '#262320',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'system-ui, sans-serif',
}

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: '#6B6760',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const primaryBtnStyle: React.CSSProperties = {
  background: '#3E5641',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  padding: '7px 16px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#6B6760',
  border: '1px solid rgba(38,35,32,0.18)',
  borderRadius: '6px',
  padding: '7px 16px',
  fontSize: '12px',
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
}

// ── Editor metadata bar ───────────────────────────────────────────────────────

function EditorMetaBar({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '8px 0 16px',
        borderBottom: '1px solid rgba(38,35,32,0.08)',
        marginBottom: '24px',
      }}
    >
      {result.type && (
        <span
          style={{
            padding: '2px 9px',
            borderRadius: '10px',
            background: 'rgba(62,86,65,0.10)',
            color: '#3E5641',
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          {result.type}
        </span>
      )}
      {projects.map((p) => (
        <span
          key={p}
          style={{
            padding: '2px 9px',
            borderRadius: '10px',
            background: 'rgba(155,123,90,0.10)',
            color: '#9B7B5A',
            fontSize: '11px',
            fontWeight: 500,
          }}
        >
          {p}
        </span>
      ))}
      {result.tags?.filter(Boolean).map((t) => (
        <span
          key={t}
          style={{
            padding: '2px 9px',
            borderRadius: '10px',
            background: 'rgba(38,35,32,0.06)',
            color: '#6B6760',
            fontSize: '11px',
          }}
        >
          {t}
        </span>
      ))}
      {dateStr && (
        <span style={{ fontSize: '11px', color: '#9B9490', marginLeft: 'auto' }}>
          Updated {dateStr}
        </span>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Home() {
  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [activeType, setActiveType] = useState('')
  const [activeProject, setActiveProject] = useState('')
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([])
  const [knownTypes, setKnownTypes] = useState<string[]>([])
  const [knownProjects, setKnownProjects] = useState<string[]>([])
  const [searching, setSearching] = useState(false)

  // Editor state
  const [activePath, setActivePath] = useState<string | null>(null)
  const [activeFileMeta, setActiveFileMeta] = useState<MemorySearchResult | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [rawContent, setRawContent] = useState<string>('')
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [recentPaths, setRecentPaths] = useState<string[]>([])

  // UI state
  const [showNewModal, setShowNewModal] = useState(false)
  const [activeTicket, setActiveTicket] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const spawnClaudeRef = useRef<((filePath: string | null) => void) | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestMarkdownRef = useRef<string>('')

  // ── Recents ──

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENTS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) setRecentPaths(parsed)
      }
    } catch { /* ignore */ }
  }, [])

  function pushRecent(filePath: string) {
    setRecentPaths((prev) => {
      const next = [filePath, ...prev.filter((p) => p !== filePath)].slice(0, RECENTS_MAX)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }

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

  // Debounced search on query/filter changes
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

  // ── File load / save ──

  const loadFile = useCallback(async (filePath: string, meta?: MemorySearchResult) => {
    setIsLoadingFile(true)
    setActivePath(filePath)
    pushRecent(filePath)
    if (meta) setActiveFileMeta(meta)

    try {
      const { readTextFile } = await getTauriFns()
      const raw = await readTextFile(filePath)
      setRawContent(raw)
      try {
        const parsed = matter(raw)
        setFileContent(parsed.content)
        latestMarkdownRef.current = parsed.content

        // Build meta from frontmatter if not passed in
        if (!meta) {
          const data = parsed.data as Record<string, unknown>
          const projectsRaw = data.projects
          const projects = Array.isArray(projectsRaw)
            ? (projectsRaw as string[])
            : projectsRaw ? [String(projectsRaw)] : []
          const tagsRaw = data.tags
          const tags = Array.isArray(tagsRaw) ? (tagsRaw as string[]) : tagsRaw ? [String(tagsRaw)] : []
          setActiveFileMeta({
            path: filePath,
            name: String(data.name ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? ''),
            type: String(data.type ?? ''),
            projects,
            created: String(data.created ?? ''),
            updated: String(data.updated ?? ''),
            tags,
            status: String(data.status ?? 'active'),
            excerpt: '',
          })
        }
      } catch {
        setFileContent(raw)
        latestMarkdownRef.current = raw
      }
    } catch (err) {
      console.error('[loadFile]', err)
    } finally {
      setIsLoadingFile(false)
    }
  }, [])

  const saveFile = useCallback(async (content: string) => {
    if (!activePath) return
    setIsSaving(true)
    try {
      let toWrite = content
      try {
        const parsed = matter(rawContent)
        if (Object.keys(parsed.data).length > 0) {
          toWrite = matter.stringify(content, parsed.data)
        }
      } catch { /* no frontmatter */ }

      const { writeTextFile } = await getTauriFns()
      await writeTextFile(activePath, toWrite)
      setRawContent(toWrite)
      setFileContent(content)
    } finally {
      setIsSaving(false)
    }
  }, [activePath, rawContent])

  const handleEditorChange = useCallback((markdown: string) => {
    latestMarkdownRef.current = markdown
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveFile(markdown) }, 300)
  }, [saveFile])

  const handleEditorSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveFile(latestMarkdownRef.current)
  }, [saveFile])

  // ── New file modal ──

  const handleFileCreated = useCallback(async (filePath: string) => {
    setShowNewModal(false)
    await loadFile(filePath)
    // Refresh search results
    runSearch(searchQuery, activeType, activeProject)
  }, [loadFile, runSearch, searchQuery, activeType, activeProject])

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

      if (mod && e.key === 'f') {
        e.preventDefault()
        setActivePath(null)
        setActiveFileMeta(null)
        setTimeout(() => searchRef.current?.focus(), 50)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const wordCount = countWords(fileContent)
  const inEditor = activePath !== null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#F2F0ED',
        color: '#262320',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Top bar */}
      <header
        style={{
          height: '44px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid rgba(38,35,32,0.10)',
          padding: '0 20px',
          gap: '16px',
          flexShrink: 0,
          background: '#F2F0ED',
        }}
      >
        {/* Wordmark / back button */}
        <button
          onClick={() => { setActivePath(null); setActiveFileMeta(null) }}
          style={{
            fontFamily: "'Fraunces', 'Georgia', serif",
            fontSize: '15px',
            fontWeight: 600,
            color: '#3E5641',
            letterSpacing: '-0.01em',
            flexShrink: 0,
            minWidth: '120px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textAlign: 'left',
          }}
        >
          {inEditor ? '← Agent Studio' : 'Agent Studio'}
        </button>

        {/* Center: filename when in editor, empty otherwise */}
        <div
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: '12px',
            color: '#6B6760',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {inEditor && activeFileMeta?.name}
        </div>

        {/* Right side */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexShrink: 0,
            minWidth: '160px',
            justifyContent: 'flex-end',
          }}
        >
          {inEditor && (
            <span style={{ fontSize: '12px', color: '#6B6760' }}>
              {isSaving ? 'Saving…' : `${wordCount.toLocaleString()} words`}
            </span>
          )}
          <button
            onClick={() => setShowNewModal(true)}
            title="New memory file (⌘N)"
            style={primaryBtnStyle}
          >
            + New
          </button>
          <button
            onClick={() => alert('Coming soon')}
            style={{
              background: '#3E5641',
              color: '#fff',
              border: 'none',
              borderRadius: '5px',
              padding: '4px 12px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            Spawn Claude
          </button>
        </div>
      </header>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Main content */}
        <main style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {!inEditor ? (
            /* ── Search view ── */
            <div
              style={{
                maxWidth: '680px',
                width: '100%',
                margin: '0 auto',
                padding: '32px 24px 80px',
                boxSizing: 'border-box',
              }}
            >
              {/* Search bar */}
              <div style={{ position: 'relative', marginBottom: '16px' }}>
                <svg
                  style={{
                    position: 'absolute',
                    left: '14px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    opacity: 0.35,
                    pointerEvents: 'none',
                  }}
                  width="16" height="16" viewBox="0 0 16 16" fill="none"
                >
                  <circle cx="6.5" cy="6.5" r="5.5" stroke="#262320" strokeWidth="1.5" />
                  <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="#262320" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search memory…"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px 10px 38px',
                    border: '1.5px solid rgba(38,35,32,0.15)',
                    borderRadius: '10px',
                    background: 'rgba(255,255,255,0.7)',
                    color: '#262320',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'system-ui, sans-serif',
                    boxShadow: '0 1px 4px rgba(38,35,32,0.06)',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = '#3E5641' }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(38,35,32,0.15)' }}
                />
                {searching && (
                  <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '11px', color: '#9B9490' }}>
                    …
                  </div>
                )}
              </div>

              {/* Filter chips */}
              {(knownTypes.length > 0 || knownProjects.length > 0) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '20px' }}>
                  {knownTypes.map((t) => (
                    <TypeChip key={t} label={t} active={activeType === t} onClick={() => handleTypeFilter(t)} />
                  ))}
                  <div style={{ width: '1px', background: 'rgba(38,35,32,0.12)', margin: '0 2px', alignSelf: 'stretch' }} />
                  {knownProjects.map((p) => (
                    <TypeChip key={p} label={p} active={activeProject === p} onClick={() => handleProjectFilter(p)} />
                  ))}
                </div>
              )}

              {/* Results */}
              <div>
                {searchResults.length === 0 && !searching && (
                  <div style={{ textAlign: 'center', color: '#9B9490', fontSize: '13px', paddingTop: '40px' }}>
                    {searchQuery || activeType || activeProject ? 'No results' : 'No files indexed'}
                  </div>
                )}
                {searchResults.map((r) => (
                  <ResultCard
                    key={r.path}
                    result={r}
                    active={activePath === r.path}
                    onClick={() => loadFile(r.path, r)}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* ── Editor view ── */
            <div
              style={{
                maxWidth: '720px',
                width: '100%',
                margin: '0 auto',
                padding: '32px 40px 80px',
                boxSizing: 'border-box',
              }}
            >
              {isLoadingFile ? (
                <div style={{ color: '#6B6760', fontSize: '13px', textAlign: 'center', paddingTop: '60px' }}>
                  Loading…
                </div>
              ) : (
                <>
                  {activeFileMeta && <EditorMetaBar result={activeFileMeta} />}
                  <MarkdownEditor
                    key={activePath ?? ''}
                    initialContent={fileContent}
                    onChange={handleEditorChange}
                    onSave={handleEditorSave}
                  />
                </>
              )}
            </div>
          )}
        </main>
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
        onSelect={(path) => { loadFile(path) }}
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
