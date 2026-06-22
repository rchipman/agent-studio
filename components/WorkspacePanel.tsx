'use client'

import { useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { color, radius, space, font, type as typeRamp } from '@/lib/tokens'
import { MemorySearchResult, OpenDoc, PanelSide, PanelTab, LoadedFile } from '@/lib/types'
import TypeChip from '@/components/TypeChip'
import DiffView from '@/components/DiffView'

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

/** A document tab's label: frontmatter name, falling back to the filename. */
function docLabel(path: string, loaded: LoadedFile | null): string {
  const name = loaded?.meta?.name
  if (name) return name
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path
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

// ── Shared close glyph (panel-close ✕, reused on doc tabs) ───────────────────

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// ── Document tab strip ───────────────────────────────────────────────────────
//
//   [ ⌕ Search ] [ doc-a ] [ doc-b … ] [ + ]                          [ ✕ ]
//
// Search is leftmost, permanent, unclosable. Each doc tab carries a hover/active
// close. `+` selects Search and focuses the field. The panel-close ✕ (right
// panel only) is pinned to the far right. Document tabs scroll horizontally
// while Search / + / ✕ stay pinned, with edge fades signalling overflow.

const DOC_TAB_MAX = 140 // px — truncate the doc name with ellipsis past this

function DocTab({
  label,
  title,
  active,
  closable,
  onSelect,
  onClose,
}: {
  label: React.ReactNode
  title?: string
  active: boolean
  closable: boolean
  onSelect: () => void
  onClose?: () => void
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onSelect}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: space[1],
        height: 28,
        padding: `0 ${space[3]}px`,
        borderRadius: radius.md,
        cursor: 'pointer',
        background: 'transparent',
        borderBottom: active ? `2px solid ${color.forest}` : '2px solid transparent',
        color: active ? color.ink : color.inkSoft,
        fontFamily: font.sans,
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        transition: 'background 0.1s ease, color 0.1s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = color.bgFieldStrong
          e.currentTarget.style.color = color.ink
        }
        const x = e.currentTarget.querySelector<HTMLElement>('[data-close]')
        if (x && closable) x.style.visibility = 'visible'
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = color.inkSoft
        }
        const x = e.currentTarget.querySelector<HTMLElement>('[data-close]')
        if (x && !active) x.style.visibility = 'hidden'
      }}
    >
      <span style={{ maxWidth: DOC_TAB_MAX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {closable && (
        <span
          data-close
          role="button"
          aria-label="Close tab"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          style={{
            display: 'flex',
            alignItems: 'center',
            color: color.inkFaint,
            // Active tab always shows the ✕; inactive reveals it on hover.
            visibility: active ? 'visible' : 'hidden',
          }}
        >
          <CloseGlyph />
        </span>
      )}
    </div>
  )
}

function DocStrip({
  tabs,
  activeTabId,
  loadedByPath,
  onSelectSearch,
  onSelectDoc,
  onCloseDoc,
  onAddDoc,
  showClose,
  onClosePanel,
}: {
  tabs: OpenDoc[]
  activeTabId: string | null
  loadedByPath: (path: string) => LoadedFile | null
  onSelectSearch: () => void
  onSelectDoc: (path: string) => void
  onCloseDoc: (path: string) => void
  onAddDoc: () => void
  showClose: boolean
  onClosePanel?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  // Scroll the active doc tab into view when it changes (e.g. ⌃Tab cycling).
  useEffect(() => {
    if (activeTabId && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeTabId])

  const searchActive = activeTabId === null

  return (
    <div
      role="tablist"
      aria-label="Open documents"
      style={{
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: space[1],
        padding: `0 ${space[4]}px`,
        borderBottom: `1px solid ${color.hairSoft}`,
        background: color.bgApp,
      }}
    >
      {/* Search tab — pinned left, permanent, unclosable */}
      <DocTab
        label={
          <span style={{ display: 'flex', alignItems: 'center', gap: space[1] }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6 }}>
              <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Search
          </span>
        }
        title="Search"
        active={searchActive}
        closable={false}
        onSelect={onSelectSearch}
      />

      {/* Document tabs — scroll horizontally under the pinned ends, edge fades */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: space[1],
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          WebkitMaskImage: `linear-gradient(to right, transparent 0, ${color.bgApp} 12px, ${color.bgApp} calc(100% - 12px), transparent 100%)`,
          maskImage: `linear-gradient(to right, transparent 0, ${color.bgApp} 12px, ${color.bgApp} calc(100% - 12px), transparent 100%)`,
        }}
      >
        {tabs.map((doc) => {
          const isActive = activeTabId === doc.path
          const loaded = loadedByPath(doc.path)
          const name = docLabel(doc.path, loaded)
          return (
            <div key={doc.path} ref={isActive ? activeRef : undefined} style={{ flexShrink: 0 }}>
              <DocTab
                label={name}
                title={name}
                active={isActive}
                closable
                onSelect={() => onSelectDoc(doc.path)}
                onClose={() => onCloseDoc(doc.path)}
              />
            </div>
          )
        })}
      </div>

      {/* + add-doc affordance — pinned right of the scrolling region */}
      <button
        onClick={onAddDoc}
        aria-label="Open a document"
        title="Open a document"
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          background: 'transparent',
          border: 'none',
          borderRadius: radius.sm,
          cursor: 'pointer',
          color: color.inkFaint,
          fontSize: 16,
          lineHeight: 1,
          fontFamily: font.sans,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.ink }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkFaint }}
      >
        +
      </button>

      {/* Panel-close ✕ — far right, right panel only (unchanged behaviour) */}
      {showClose && (
        <button
          onClick={onClosePanel}
          aria-label="Close right panel"
          title="Close panel (⌘\)"
          style={{
            flexShrink: 0,
            marginLeft: space[1],
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
          <CloseGlyph />
        </button>
      )}
    </div>
  )
}

// ── Surface strip (Content / Links / Diff) — scoped to the active document ───

const SURFACES: { id: PanelTab; label: string }[] = [
  { id: 'content', label: 'Content' },
  { id: 'links', label: 'Links' },
  { id: 'diff', label: 'Diff' },
]

function SurfaceStrip({
  surface,
  onSelect,
}: {
  surface: PanelTab
  onSelect: (s: PanelTab) => void
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
      {SURFACES.map((t) => {
        const isActive = surface === t.id
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
    </div>
  )
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface WorkspacePanelProps {
  side: PanelSide

  /** The open document tabs (left→right) and which is active (null = Search). */
  tabs: OpenDoc[]
  activeTabId: string | null

  /** Select the implicit Search tab (and focus the field). */
  onSelectSearch: () => void
  /** Select an already-open document tab by path. */
  onSelectDoc: (path: string) => void
  /** Close a document tab by path. */
  onCloseDoc: (path: string) => void
  /** The + affordance: go find a document (select Search + focus the field). */
  onAddDoc: () => void
  /** Change the active document's surface (Content / Links / Diff). */
  onSelectSurface: (surface: PanelTab) => void

  /** Right panel shows a close affordance in its tab strip. */
  showClose?: boolean
  onClose?: () => void

  // What the active document tab is showing (null when Search is active)
  activePath: string | null
  activeSurface: PanelTab
  loaded: LoadedFile | null
  /** Look up any open doc's loaded contents (for tab labels). */
  loadedByPath: (path: string) => LoadedFile | null

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

  /**
   * Working directory for the Diff tab. The orchestrator (app/page.tsx) passes
   * this from settings / agent cwd. Defaults to empty string (DiffView will
   * surface "not-a-repo" in that case).
   */
  workingDir?: string

  // Editor
  onEditorChange: (markdown: string) => void
  onEditorSave: () => void
}

// ── Component ───────────────────────────────────────────────────────────────

export default function WorkspacePanel(props: WorkspacePanelProps) {
  const {
    tabs,
    activeTabId,
    onSelectSearch,
    onSelectDoc,
    onCloseDoc,
    onAddDoc,
    onSelectSurface,
    showClose = false,
    onClose,
    activePath,
    activeSurface,
    loaded,
    loadedByPath,
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
    workingDir = '',
  } = props

  const fallbackSearchRef = useRef<HTMLInputElement>(null)
  const searchRef = searchInputRef ?? fallbackSearchRef

  const inEditor = activeTabId !== null

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
      <DocStrip
        tabs={tabs}
        activeTabId={activeTabId}
        loadedByPath={loadedByPath}
        onSelectSearch={onSelectSearch}
        onSelectDoc={onSelectDoc}
        onCloseDoc={onCloseDoc}
        onAddDoc={onAddDoc}
        showClose={showClose}
        onClosePanel={onClose}
      />

      {/* Surface strip renders only when a document tab is active. */}
      {inEditor && <SurfaceStrip surface={activeSurface} onSelect={onSelectSurface} />}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Search view when no doc is active, else the active document's surface. */}
        {!inEditor && (
          <SearchView
            activePath={activePath}
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
          />
        )}

        {inEditor && activeSurface === 'content' && (
          <EditorView
            activePath={activePath}
            loaded={loaded}
            onEditorChange={onEditorChange}
            onEditorSave={onEditorSave}
          />
        )}

        {inEditor && activeSurface === 'links' && (
          <CalmEmpty>No links yet for this note.</CalmEmpty>
        )}

        {inEditor && activeSurface === 'diff' && (
          <DiffView workingDir={workingDir} />
        )}
      </div>
    </section>
  )
}

// ── Search view (visually identical to today's single-panel search) ─────────

function SearchView(props: {
  activePath: string | null
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
}) {
  const {
    activePath,
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
  } = props

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

// ── Editor view (visually identical to today's single-panel editor) ─────────

function EditorView(props: {
  activePath: string | null
  loaded: LoadedFile | null
  onEditorChange: (markdown: string) => void
  onEditorSave: () => void
}) {
  const { activePath, loaded, onEditorChange, onEditorSave } = props
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
