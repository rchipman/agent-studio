'use client'

import { useRef } from 'react'
import dynamic from 'next/dynamic'
import { color, radius, space, font, type as typeRamp } from '@/lib/tokens'
import { MemorySearchResult, PanelSide, PanelTab, LoadedFile } from '@/lib/types'
import TypeChip from '@/components/TypeChip'

const MarkdownEditor = dynamic(() => import('@/components/MarkdownEditor'), { ssr: false })

// ── Local formatting helpers ────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

// ── Presentational primitives (search + editor content) ─────────────────────

function MetaBar({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space[3], flexWrap: 'wrap', marginBottom: space[1] }}>
      {result.type && (
        <span style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 10, fontWeight: 600, letterSpacing: '0.02em' }}>
          {result.type}
        </span>
      )}
      {projects.map((p) => (
        <span key={p} style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 10, fontWeight: 500 }}>
          {p}
        </span>
      ))}
      {dateStr && <span style={{ fontSize: 10, color: color.inkFaint, marginLeft: 'auto' }}>{dateStr}</span>}
    </div>
  )
}

function ResultCard({
  result,
  active,
  onActivate,
}: {
  result: MemorySearchResult
  active: boolean
  onActivate: (e: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onActivate}
      title="Click to open here · ⌘-click to open in the other panel"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '12px 16px',
        background: active ? color.forestWash : color.bgCard,
        border: active ? `1.5px solid ${color.forestLine}` : `1px solid ${color.hairSoft}`,
        borderRadius: radius.card,
        cursor: 'pointer',
        transition: 'all 0.1s ease',
        marginBottom: space[2],
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = color.bgFieldStrong
          e.currentTarget.style.borderColor = color.line
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = color.bgCard
          e.currentTarget.style.borderColor = color.hairSoft
        }
      }}
    >
      <MetaBar result={result} />
      <div style={{ fontSize: 13, fontWeight: 600, color: color.ink, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {result.name}
      </div>
      {result.excerpt && (
        <div style={{ fontSize: 11, color: color.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.4 }}>
          {result.excerpt}
        </div>
      )}
    </button>
  )
}

function EditorMetaBar({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space[3], flexWrap: 'wrap', padding: '8px 0 16px', borderBottom: `1px solid ${color.hairSoft}`, marginBottom: space[7] }}>
      {result.type && (
        <span style={{ padding: '2px 9px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 11, fontWeight: 600 }}>
          {result.type}
        </span>
      )}
      {projects.map((p) => (
        <span key={p} style={{ padding: '2px 9px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 11, fontWeight: 500 }}>
          {p}
        </span>
      ))}
      {result.tags?.filter(Boolean).map((t) => (
        <span key={t} style={{ padding: '2px 9px', borderRadius: radius.chip, background: color.neutralTint, color: color.inkSoft, fontSize: 11 }}>
          {t}
        </span>
      ))}
      {dateStr && <span style={{ fontSize: 11, color: color.inkFaint, marginLeft: 'auto' }}>Updated {dateStr}</span>}
    </div>
  )
}

// ── Calm empty state (shared voice) ─────────────────────────────────────────

function CalmEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...typeRamp.body, textAlign: 'center', color: color.inkFaint, paddingTop: 60 }}>
      {children}
    </div>
  )
}

// ── Per-panel tab row ───────────────────────────────────────────────────────

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'links', label: 'Links' },
  { id: 'diff', label: 'Diff' },
]

function TabRow({
  activeTab,
  onSelect,
  showClose,
  onClose,
}: {
  activeTab: PanelTab
  onSelect: (tab: PanelTab) => void
  showClose: boolean
  onClose?: () => void
}) {
  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        gap: space[1],
        padding: `0 ${space[4]}px`,
        borderBottom: `1px solid ${color.hairSoft}`,
      }}
    >
      {TABS.map((t) => {
        const isActive = activeTab === t.id
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: isActive ? `2px solid ${color.forest}` : '2px solid transparent',
              color: isActive ? color.forest : color.inkSoft,
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              fontFamily: font.sans,
              cursor: 'pointer',
              padding: '0 6px',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        )
      })}
      {showClose && (
        <button
          onClick={onClose}
          aria-label="Close right panel"
          title="Close panel (⌘\)"
          style={{
            marginLeft: 'auto',
            alignSelf: 'center',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: color.inkFaint,
            display: 'flex',
            alignItems: 'center',
            padding: 4,
            borderRadius: radius.sm,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface WorkspacePanelProps {
  side: PanelSide
  activeTab: PanelTab
  onSelectTab: (tab: PanelTab) => void
  /** Right panel shows a close affordance in its tab row. */
  showClose?: boolean
  onClose?: () => void

  // What this panel is showing
  activePath: string | null
  loaded: LoadedFile | null

  // Search view (driven by global state; identical across panels)
  searchQuery: string
  searching: boolean
  searchResults: MemorySearchResult[]
  knownTypes: string[]
  knownProjects: string[]
  activeType: string
  activeProject: string
  onSearchChange: (q: string) => void
  onTypeFilter: (t: string) => void
  onProjectFilter: (p: string) => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>

  /** Open a result/file in this panel, or the other panel when ⌘-clicked. */
  onOpenResult: (result: MemorySearchResult, e: React.MouseEvent) => void

  // Editor
  onEditorChange: (markdown: string) => void
  onEditorSave: () => void
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WorkspacePanel(props: WorkspacePanelProps) {
  const {
    activeTab,
    onSelectTab,
    showClose = false,
    onClose,
    activePath,
    loaded,
    searchQuery,
    searching,
    searchResults,
    knownTypes,
    knownProjects,
    activeType,
    activeProject,
    onSearchChange,
    onTypeFilter,
    onProjectFilter,
    searchInputRef,
    onOpenResult,
    onEditorChange,
    onEditorSave,
  } = props

  const fallbackSearchRef = useRef<HTMLInputElement>(null)
  const searchRef = searchInputRef ?? fallbackSearchRef

  const inEditor = activePath !== null

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: color.bgApp,
      }}
    >
      <TabRow activeTab={activeTab} onSelect={onSelectTab} showClose={showClose} onClose={onClose} />

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'content' && (
          <ContentTab
            inEditor={inEditor}
            activePath={activePath}
            loaded={loaded}
            searchQuery={searchQuery}
            searching={searching}
            searchResults={searchResults}
            knownTypes={knownTypes}
            knownProjects={knownProjects}
            activeType={activeType}
            activeProject={activeProject}
            onSearchChange={onSearchChange}
            onTypeFilter={onTypeFilter}
            onProjectFilter={onProjectFilter}
            searchRef={searchRef}
            onOpenResult={onOpenResult}
            onEditorChange={onEditorChange}
            onEditorSave={onEditorSave}
          />
        )}

        {activeTab === 'links' && (
          <CalmEmpty>
            {inEditor ? 'No links yet for this note.' : 'Open a note to see its links.'}
          </CalmEmpty>
        )}

        {activeTab === 'diff' && (
          <CalmEmpty>Nothing changed yet.</CalmEmpty>
        )}
      </div>
    </section>
  )
}

// ── Content tab (the search view OR the editor view) ────────────────────────

function ContentTab(props: {
  inEditor: boolean
  activePath: string | null
  loaded: LoadedFile | null
  searchQuery: string
  searching: boolean
  searchResults: MemorySearchResult[]
  knownTypes: string[]
  knownProjects: string[]
  activeType: string
  activeProject: string
  onSearchChange: (q: string) => void
  onTypeFilter: (t: string) => void
  onProjectFilter: (p: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  onOpenResult: (result: MemorySearchResult, e: React.MouseEvent) => void
  onEditorChange: (markdown: string) => void
  onEditorSave: () => void
}) {
  const {
    inEditor,
    activePath,
    loaded,
    searchQuery,
    searching,
    searchResults,
    knownTypes,
    knownProjects,
    activeType,
    activeProject,
    onSearchChange,
    onTypeFilter,
    onProjectFilter,
    searchRef,
    onOpenResult,
    onEditorChange,
    onEditorSave,
  } = props

  if (!inEditor) {
    // ── Search view (visually identical to today's single-panel search) ──
    return (
      <div style={{ maxWidth: 680, width: '100%', margin: '0 auto', padding: '32px 24px 80px', boxSizing: 'border-box' }}>
        {/* Search bar */}
        <div style={{ position: 'relative', marginBottom: space[5] }}>
          <svg
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', opacity: 0.35, pointerEvents: 'none' }}
            width="16" height="16" viewBox="0 0 16 16" fill="none"
          >
            <circle cx="6.5" cy="6.5" r="5.5" stroke={color.ink} strokeWidth="1.5" />
            <line x1="11" y1="11" x2="14.5" y2="14.5" stroke={color.ink} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search memory…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 14px 10px 38px',
              border: `1.5px solid ${color.line}`,
              borderRadius: radius.field,
              background: color.bgField,
              color: color.ink,
              fontSize: 14,
              outline: 'none',
              boxSizing: 'border-box',
              fontFamily: font.sans,
              boxShadow: '0 1px 4px rgba(38,35,32,0.06)',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = color.forest }}
            onBlur={(e) => { e.currentTarget.style.borderColor = color.line }}
          />
          {searching && (
            <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: color.inkFaint }}>
              …
            </div>
          )}
        </div>

        {/* Filter chips */}
        {(knownTypes.length > 0 || knownProjects.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2], marginBottom: space[6] }}>
            {knownTypes.map((t) => (
              <TypeChip key={t} label={t} active={activeType === t} onClick={() => onTypeFilter(t)} />
            ))}
            <div style={{ width: 1, background: color.hair, margin: '0 2px', alignSelf: 'stretch' }} />
            {knownProjects.map((p) => (
              <TypeChip key={p} label={p} active={activeProject === p} onClick={() => onProjectFilter(p)} />
            ))}
          </div>
        )}

        {/* Results */}
        <div>
          {searchResults.length === 0 && !searching && (
            <div style={{ textAlign: 'center', color: color.inkFaint, fontSize: 13, paddingTop: 40 }}>
              {searchQuery || activeType || activeProject ? 'No results' : 'No files indexed'}
            </div>
          )}
          {searchResults.map((r) => (
            <ResultCard
              key={r.path}
              result={r}
              active={activePath === r.path}
              onActivate={(e) => onOpenResult(r, e)}
            />
          ))}
        </div>
      </div>
    )
  }

  // ── Editor view (visually identical to today's single-panel editor) ──
  return (
    <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '32px 40px 80px', boxSizing: 'border-box' }}>
      {loaded?.loading ? (
        <div style={{ color: color.inkSoft, fontSize: 13, textAlign: 'center', paddingTop: 60 }}>
          Loading…
        </div>
      ) : (
        <>
          {loaded?.meta && <EditorMetaBar result={loaded.meta} />}
          <MarkdownEditor
            key={activePath ?? ''}
            initialContent={loaded?.content ?? ''}
            onChange={onEditorChange}
            onSave={onEditorSave}
          />
        </>
      )}
    </div>
  )
}
