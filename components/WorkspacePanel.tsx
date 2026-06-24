'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { color, radius, space, font, type as typeRamp } from '@/lib/tokens'
import { MemorySearchResult, OpenDoc, PanelSide, LoadedFile } from '@/lib/types'
import { fileLinks, type FileLinks, type LinkedFile, type TicketRef } from '@/lib/links'
import { getMemoryHistory, type AuditEntry } from '@/lib/history'
import TypeChip from '@/components/TypeChip'
import Button from '@/components/Button'

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

/** Relative time label: "just now", "5 m ago", "2 h ago", "3 d ago". */
function relativeTime(iso: string): string {
  if (!iso) return ''
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin} m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH} h ago`
    const diffD = Math.floor(diffH / 24)
    return `${diffD} d ago`
  } catch {
    return ''
  }
}

/** A document tab's label: frontmatter name, falling back to the filename. */
function docLabel(path: string, loaded: LoadedFile | null): string {
  const name = loaded?.meta?.name
  if (name) return name
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path
}

// ── Presentational primitives (search + editor content) ─────────────────────

// Tag overflow cap for the compact MetaBar (search result cards).
// Fixed cap: 3 visible tags to prevent date wrapping at narrow widths.
const META_TAG_CAP = 3

function MetaBar({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  const tags = (result.tags ?? []).filter(Boolean)
  const visibleTags = tags.slice(0, META_TAG_CAP)
  const hiddenCount = tags.length - visibleTags.length
  const isSuperseded = result.status === 'superseded'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space[3], flexWrap: 'nowrap', marginBottom: space[1], minWidth: 0 }}>
      {result.type && (
        <span style={{ flexShrink: 0, padding: '1px 7px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 10, fontWeight: 600, letterSpacing: '0.02em' }}>
          {result.type}
        </span>
      )}
      {isSuperseded && (
        <span style={{ flexShrink: 0, padding: '1px 7px', borderRadius: radius.chip, background: color.neutralTint, color: color.inkSoft, fontSize: 10 }}>
          superseded
        </span>
      )}
      {projects.map((p) => (
        <span key={p} style={{ flexShrink: 0, padding: '1px 7px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 10, fontWeight: 500 }}>
          {p}
        </span>
      ))}
      {visibleTags.map((t) => (
        <span key={t} style={{ flexShrink: 0, padding: '1px 7px', borderRadius: radius.chip, background: color.neutralTint, color: color.inkSoft, fontSize: 10 }}>
          {t}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span
          style={{ flexShrink: 0, ...typeRamp.meta, fontSize: 10, color: color.inkFaint }}
          title={tags.slice(META_TAG_CAP).join(', ')}
        >
          +{hiddenCount} more
        </span>
      )}
      {dateStr && <span style={{ fontSize: 10, color: color.inkFaint, marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}>{dateStr}</span>}
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

// Approximate chip width (px) for tag overflow estimation in EditorMetaBar.
// Each tag chip is ~(chars * 6.5 + 18)px. We degrade to a fixed cap of 4 tags
// when the container width is not yet measured (first paint).
const EDITOR_TAG_CAP_DEFAULT = 4

function EditorMetaBar({
  result,
  onOpenFile,
}: {
  result: MemorySearchResult
  onOpenFile?: (path: string, e: React.MouseEvent) => void
}) {
  const projects = result.projects.filter(Boolean)
  const dateStr = formatDate(result.updated || result.created)
  const tags = (result.tags ?? []).filter(Boolean)
  const isSuperseded = result.status === 'superseded'
  const metaExt = result as MemorySearchResult & { supersedes?: string; superseded_by?: string }
  const supersedes = metaExt.supersedes
  const supersededBy = metaExt.superseded_by

  // Tag overflow: measure available width via ResizeObserver.
  // Fixed chips (type, superseded, projects, date) consume a reserved portion;
  // tags fill what remains. Degrade to EDITOR_TAG_CAP_DEFAULT on first render.
  const rowRef = useRef<HTMLDivElement>(null)
  const [visibleTagCount, setVisibleTagCount] = useState(EDITOR_TAG_CAP_DEFAULT)

  const recalcTagCount = useCallback(() => {
    if (!rowRef.current || tags.length === 0) {
      setVisibleTagCount(EDITOR_TAG_CAP_DEFAULT)
      return
    }
    const rowWidth = rowRef.current.offsetWidth
    // Fixed elements: type chip ~80px, superseded chip ~90px, each project chip
    // ~(name.length * 6.5 + 22)px, date ~130px, gaps at space[3]=8px each.
    let reserved = 0
    if (result.type) reserved += Math.max(80, result.type.length * 6.5 + 22) + space[3]
    if (isSuperseded) reserved += 90 + space[3]
    projects.forEach(p => { reserved += Math.max(70, p.length * 6.5 + 22) + space[3] })
    reserved += 130 + space[3] // date
    const available = rowWidth - reserved
    if (available <= 0) {
      setVisibleTagCount(0)
      return
    }
    let used = 0
    let count = 0
    for (const t of tags) {
      const chipW = Math.max(50, t.length * 6.5 + 22) + space[3]
      // Reserve space for a "+n more" affordance (~52px) if there will be overflow
      const overflowReserve = count < tags.length - 1 ? 52 : 0
      if (used + chipW + overflowReserve > available) break
      used += chipW
      count++
    }
    setVisibleTagCount(Math.max(0, count))
  }, [tags, result.type, isSuperseded, projects])

  useEffect(() => {
    recalcTagCount()
    if (!rowRef.current) return
    const observer = new ResizeObserver(recalcTagCount)
    observer.observe(rowRef.current)
    return () => observer.disconnect()
  }, [recalcTagCount])

  const visibleTags = tags.slice(0, visibleTagCount)
  const hiddenCount = tags.length - visibleTags.length

  return (
    <>
      <div
        ref={rowRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[3],
          flexWrap: 'nowrap',
          padding: '8px 0 16px',
          borderBottom: `1px solid ${color.hairSoft}`,
          marginBottom: space[7],
          minWidth: 0,
        }}
      >
        {result.type && (
          <span style={{ flexShrink: 0, padding: '2px 9px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 11, fontWeight: 600 }}>
            {result.type}
          </span>
        )}
        {isSuperseded && (
          <span style={{ flexShrink: 0, padding: '2px 9px', borderRadius: radius.chip, background: color.neutralTint, color: color.inkSoft, fontSize: 11 }}>
            superseded
          </span>
        )}
        {projects.map((p) => (
          <span key={p} style={{ flexShrink: 0, padding: '2px 9px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 11, fontWeight: 500 }}>
            {p}
          </span>
        ))}
        {visibleTags.map((t) => (
          <span key={t} style={{ flexShrink: 0, padding: '2px 9px', borderRadius: radius.chip, background: color.neutralTint, color: color.inkSoft, fontSize: 11 }}>
            {t}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span
            style={{ flexShrink: 0, ...typeRamp.meta, color: color.inkFaint }}
            title={tags.slice(visibleTagCount).join(', ')}
          >
            +{hiddenCount} more
          </span>
        )}
        {dateStr && (
          <span style={{ flexShrink: 0, fontSize: 11, color: color.inkFaint, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            Updated {dateStr}
          </span>
        )}
      </div>
      {isSuperseded && supersedes && onOpenFile && (
        <div style={{ ...typeRamp.body, color: color.inkSoft, marginTop: `-${space[6]}px`, marginBottom: space[6], lineHeight: 1.5 }}>
          {'Supersedes '}
          <NotePillInline name={supersedes} filePath={supersedes} onOpenFile={onOpenFile} />
          {'.'}
        </div>
      )}
      {isSuperseded && supersededBy && onOpenFile && (
        <div style={{ ...typeRamp.body, color: color.inkSoft, marginTop: supersedes ? 0 : `-${space[6]}px`, marginBottom: space[6], lineHeight: 1.5 }}>
          {'Superseded by '}
          <NotePillInline name={supersededBy} filePath={supersededBy} onOpenFile={onOpenFile} />
          {'.'}
        </div>
      )}
    </>
  )
}

// ── Note pill (reuse of ConsistencyView NotePill pattern) ───────────────────

/** Inline note pill — reuses the ConsistencyView NotePill styling.
 *  Used for "Supersedes {name}." and "Superseded by {name}." lines. */
function NotePillInline({
  name,
  filePath,
  onOpenFile,
}: {
  name: string
  filePath: string
  onOpenFile: (path: string, e: React.MouseEvent) => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title={`Open here · ⌘-click to open in the other panel\n${filePath}`}
      onClick={(e) => onOpenFile(filePath, e)}
      style={{
        display: 'inline',
        padding: '3px 10px',
        borderRadius: radius.chip,
        border: `1px solid ${hovered ? color.forestLine : color.line}`,
        background: hovered ? color.forestWash : 'transparent',
        color: hovered ? color.ink : color.inkSoft,
        fontFamily: font.sans,
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.12s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {name}
    </button>
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

// ── Links tab (TIN-1639) ─────────────────────────────────────────────────────

/** A section label with a trailing count, e.g. `LINKS OUT  3`. */
function LinkSectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ ...typeRamp.label, color: color.inkSoft, marginBottom: space[3] }}>
      {label} <span style={{ color: color.inkFaint }}>{count}</span>
    </div>
  )
}

/** A Linear ticket mention chip. Mono ID, optional cached title; opens Linear. */
function TicketChip({ ticket, onOpen }: { ticket: TicketRef; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(ticket.id)}
      title="Open in Linear"
      style={{
        padding: '3px 10px',
        borderRadius: radius.chip,
        border: `1px solid ${color.line}`,
        background: 'transparent',
        color: color.inkSoft,
        fontFamily: font.mono,
        fontSize: 11,
        cursor: 'pointer',
        transition: 'all 0.12s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = color.forestWash
        e.currentTarget.style.borderColor = color.forestLine
        e.currentTarget.style.color = color.ink
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = color.line
        e.currentTarget.style.color = color.inkSoft
      }}
    >
      {ticket.id}
      {ticket.title && (
        <span style={{ ...typeRamp.meta, color: color.inkSoft }}> · {ticket.title}</span>
      )}
    </button>
  )
}

/** Adapt a LinkedFile to the MemorySearchResult shape ResultCard renders. The
 *  absent date/tags/status fields are empty (MetaBar guards on empty date). */
function linkedToResult(f: LinkedFile): MemorySearchResult {
  return {
    path: f.path,
    name: f.name,
    type: f.type,
    projects: f.projects,
    excerpt: f.excerpt,
    created: '',
    updated: '',
    tags: [],
    status: '',
  }
}

/** The Links tab body for one open file: mentions, outbound links, backlinks. */
function LinksTab({
  path,
  onOpenResult,
  onOpenTicket,
  footer = false,
}: {
  path: string
  onOpenResult: (result: MemorySearchResult, e: React.MouseEvent) => void
  onOpenTicket: (id: string) => void
  /** Footer mode: render beneath the note, hidden entirely while loading,
   *  on error, or when the note has no links (no noisy empty state). */
  footer?: boolean
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [links, setLinks] = useState<FileLinks | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setLinks(null)
    fileLinks(path)
      .then((res) => {
        if (cancelled) return
        setLinks(res)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const column = {
    maxWidth: 680,
    width: '100%',
    margin: '0 auto',
    padding: `${space[8]}px ${space[7]}px 80px`,
    boxSizing: 'border-box' as const,
  }

  if (status === 'loading') {
    if (footer) return null
    return (
      <div style={column}>
        <div style={{ ...typeRamp.body, textAlign: 'center', color: color.inkSoft, paddingTop: 60 }}>
          Reading links…
        </div>
      </div>
    )
  }

  if (status === 'error' || !links) {
    if (footer) return null
    return (
      <div style={column}>
        <div
          style={{
            ...typeRamp.body,
            color: color.notice,
            background: 'rgba(155,123,90,0.08)',
            borderRadius: radius.md,
            padding: `${space[3]}px ${space[4]}px`,
            textAlign: 'center',
          }}
        >
          Could not read links for this note.
        </div>
      </div>
    )
  }

  const isEmpty =
    links.tickets.length === 0 && links.outbound.length === 0 && links.backlinks.length === 0
  if (isEmpty) {
    if (footer) return null
    return (
      <CalmEmpty>
        Nothing links here yet. Mention a note with [[ or a ticket like TIN-1639, and it shows up here.
      </CalmEmpty>
    )
  }

  // Footer: a calm "Linked" section under the note, with a top divider.
  const footerColumn = {
    maxWidth: 720,
    width: '100%',
    margin: '0 auto',
    padding: `${space[6]}px 40px 60px`,
    borderTop: `1px solid ${color.hairSoft}`,
    boxSizing: 'border-box' as const,
  }

  // Present sections in order, each carrying its own top margin for the section
  // rhythm (the first present section gets no top margin).
  const sections: React.ReactNode[] = []
  const sectionWrap = (key: string, node: React.ReactNode) => (
    <div key={key} style={{ marginTop: sections.length === 0 ? 0 : space[7] }}>
      {node}
    </div>
  )

  if (links.tickets.length > 0) {
    sections.push(
      sectionWrap(
        'mentions',
        <>
          <LinkSectionHeader label="MENTIONS" count={links.tickets.length} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
            {links.tickets.map((t) => (
              <TicketChip key={t.id} ticket={t} onOpen={onOpenTicket} />
            ))}
          </div>
        </>,
      ),
    )
  }

  if (links.outbound.length > 0) {
    sections.push(
      sectionWrap(
        'outbound',
        <>
          <LinkSectionHeader label="LINKS OUT" count={links.outbound.length} />
          {links.outbound.map((f) => (
            <ResultCard
              key={f.path}
              result={linkedToResult(f)}
              active={false}
              onActivate={(e) => onOpenResult(linkedToResult(f), e)}
            />
          ))}
        </>,
      ),
    )
  }

  if (links.backlinks.length > 0) {
    sections.push(
      sectionWrap(
        'backlinks',
        <>
          <LinkSectionHeader label="LINKED FROM" count={links.backlinks.length} />
          {links.backlinks.map((f) => (
            <ResultCard
              key={f.path}
              result={linkedToResult(f)}
              active={false}
              onActivate={(e) => onOpenResult(linkedToResult(f), e)}
            />
          ))}
        </>,
      ),
    )
  }

  if (footer) {
    return (
      <div style={footerColumn}>
        <div style={{ ...typeRamp.label, color: color.inkFaint, marginBottom: space[4] }}>Linked</div>
        {sections}
      </div>
    )
  }

  return <div style={column}>{sections}</div>
}

// ── History footer (TIN-1728) ────────────────────────────────────────────────

/** A single audit-history row: tan (human) or forest (agent) left rule + actor
 *  label + relative time + change summary. Reuses the TranscriptBrowser's
 *  tan/forest left-rule grammar exactly (color, width, opacity). */
function HistoryRow({ entry }: { entry: AuditEntry }) {
  const isHuman = entry.actorType === 'human'
  const ruleColor = isHuman ? color.tan : color.forest
  const actorLabel = isHuman ? 'you' : entry.actorId
  return (
    <div
      style={{
        display: 'flex',
        gap: space[4],
        paddingLeft: space[4],
        paddingTop: space[2],
        paddingBottom: space[2],
        borderLeft: `2px solid ${ruleColor}`,
        marginBottom: space[2],
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: space[3], marginBottom: 2 }}>
          <span style={{ ...typeRamp.meta, color: color.inkSoft, fontWeight: 500 }}>
            {actorLabel}
          </span>
          <span style={{ ...typeRamp.meta, color: color.inkFaint }}>
            {relativeTime(entry.ts)}
          </span>
        </div>
        <div style={{ ...typeRamp.body, color: color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.changeSummary}
        </div>
      </div>
    </div>
  )
}

const HISTORY_INITIAL_ROWS = 5

/** The audit history footer section. Renders beneath Links in footer mode.
 *  Collapsed by default; expands in place. Empty = omitted entirely. */
function HistoryFooter({ path }: { path: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setEntries([])
    setExpanded(false)
    setShowAll(false)
    getMemoryHistory(path)
      .then((res) => {
        if (cancelled) return
        setEntries(res)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => { cancelled = true }
  }, [path])

  // Loading: render nothing (silent, like empty Links)
  if (status === 'loading') return null

  // Error: calm faint notice
  if (status === 'error') {
    return (
      <div style={{ marginTop: space[7] }}>
        <div style={{ ...typeRamp.body, color: color.inkFaint }}>
          Could not read this note&apos;s history.
        </div>
      </div>
    )
  }

  // Empty: omit entirely (like empty Links section)
  if (entries.length === 0) return null

  const visibleEntries = showAll ? entries : entries.slice(0, HISTORY_INITIAL_ROWS)
  const hasMore = entries.length > HISTORY_INITIAL_ROWS

  return (
    <div style={{ marginTop: space[7] }}>
      {/* Collapsed header row: HISTORY {n} — reuses LinkSectionHeader style */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v) }}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        aria-expanded={expanded}
      >
        <LinkSectionHeader label="HISTORY" count={entries.length} />
      </div>

      {expanded && (
        <div style={{ marginTop: space[3] }}>
          {visibleEntries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
          {hasMore && !showAll && (
            <div style={{ marginTop: space[3] }}>
              <Button variant="tertiary" onClick={() => setShowAll(true)}>
                Show full history
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Wraps HistoryFooter in the same column geometry as the Links footer column. */
function HistoryFooterWrapper({ path }: { path: string }) {
  return (
    <div
      style={{
        maxWidth: 720,
        width: '100%',
        margin: '0 auto',
        padding: `0 40px 60px`,
        boxSizing: 'border-box' as const,
      }}
    >
      <HistoryFooter path={path} />
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
        alignSelf: 'flex-end',
        gap: space[1],
        height: 30,
        padding: `0 ${space[3]}px`,
        // Folder tab: the active tab takes the body's raised surface and fuses
        // with it (forest top seam, hairline sides, square bottom, -1 overlap),
        // so it reads as a tab belonging to the panel below, not a flat label.
        background: active ? color.bgRaised : 'transparent',
        border: active ? `1px solid ${color.hair}` : '1px solid transparent',
        borderBottom: 'none',
        borderTop: active ? `2px solid ${color.forest}` : '2px solid transparent',
        borderTopLeftRadius: radius.md,
        borderTopRightRadius: radius.md,
        marginBottom: -1,
        cursor: 'pointer',
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
  wordCount,
  onToggleSplit,
  splitOpen,
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
  /** Active document's word count, shown right-aligned; null when not in a doc. */
  wordCount?: number | null
  /** Toggle the second panel; rendered as a dual-panel icon at the strip's right
   *  (the left panel only). `splitOpen` drives the active/pressed state. */
  onToggleSplit?: () => void
  splitOpen?: boolean
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

      {/* Document tabs — size to content, grouped with the + at the left, and
          scroll horizontally (shrinking) only when they overflow the strip. */}
      <div
        ref={scrollRef}
        style={{
          flexShrink: 1,
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

      {/* Spacer pushes the panel controls to the far right; tabs + ＋ stay left. */}
      <div style={{ flex: 1, minWidth: space[3] }} />

      {/* Active document word count — calm, right of the tabs (TIN nav phase 3). */}
      {typeof wordCount === 'number' && (
        <span style={{ ...typeRamp.meta, color: color.inkFaint, paddingLeft: space[3], paddingRight: space[1], flexShrink: 0 }}>
          {wordCount.toLocaleString()} w
        </span>
      )}

      {/* Split toggle — dual-panel icon, far right of the (left) strip. */}
      {onToggleSplit && (
        <button
          onClick={onToggleSplit}
          aria-label="Toggle the second panel"
          aria-pressed={splitOpen}
          title="Toggle split (⌘\)"
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            background: splitOpen ? color.forestTint : 'transparent',
            border: 'none',
            borderRadius: radius.sm,
            cursor: 'pointer',
            color: splitOpen ? color.forest : color.inkFaint,
            transition: 'all 0.1s ease',
          }}
          onMouseEnter={(e) => { if (!splitOpen) { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.ink } }}
          onMouseLeave={(e) => { if (!splitOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkFaint } }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <line x1="8" y1="2.5" x2="8" y2="13.5" />
          </svg>
        </button>
      )}

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

  /** Right panel shows a close affordance in its tab strip. */
  showClose?: boolean
  onClose?: () => void

  /** Toggle the second panel (passed to the left panel only); drives the strip's
   *  dual-panel split icon. */
  onToggleSplit?: () => void
  splitOpen?: boolean

  // What the active document tab is showing (null when Search is active)
  activePath: string | null
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

  /** Open a Linear ticket (by id) in the in-app Linear browser. Used by the
   *  Links tab ticket chips and the editor's TIN-XXXX links (TIN-1639). */
  onOpenTicket: (id: string) => void

  /** Open a `[[slug]]` wiki-link target (resolved to a file by the orchestrator)
   *  in this panel. Used by the editor's rendered wiki-links (TIN-1639). */
  onOpenWikiLink: (slug: string) => void

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
    showClose = false,
    onClose,
    onToggleSplit,
    splitOpen,
    activePath,
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
    onOpenTicket,
    onOpenWikiLink,
    onEditorChange,
    onEditorSave,
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
        onToggleSplit={onToggleSplit}
        splitOpen={splitOpen}
        wordCount={inEditor && loaded?.content ? loaded.content.trim().split(/\s+/).filter(Boolean).length : null}
      />

      {/* Body sits on the raised surface so the active doc tab fuses with it. */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', background: color.bgRaised }}>
        {/* Search when no doc is active; otherwise the note plus its links footer. */}
        {!inEditor ? (
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
        ) : (
          <>
            <EditorView
              activePath={activePath}
              loaded={loaded}
              onEditorChange={onEditorChange}
              onEditorSave={onEditorSave}
              onOpenWikiLink={onOpenWikiLink}
              onOpenTicket={onOpenTicket}
            />
            {activePath && (
              <>
                <LinksTab
                  path={activePath}
                  onOpenResult={onOpenResult}
                  onOpenTicket={onOpenTicket}
                  footer
                />
                <HistoryFooterWrapper path={activePath} />
              </>
            )}
          </>
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
  onOpenWikiLink: (slug: string) => void
  onOpenTicket: (id: string) => void
}) {
  const { activePath, loaded, onEditorChange, onEditorSave, onOpenWikiLink, onOpenTicket } = props

  // Adapt onOpenWikiLink to the (path, MouseEvent) signature NotePillInline needs.
  const handleOpenFile = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (path: string, _e: React.MouseEvent) => onOpenWikiLink(path),
    [onOpenWikiLink],
  )

  return (
    <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '32px 40px 80px', boxSizing: 'border-box' }}>
      {loaded?.loading ? (
        <div style={{ color: color.inkSoft, fontSize: 13, textAlign: 'center', paddingTop: 60 }}>
          Loading…
        </div>
      ) : (
        <>
          {loaded?.meta && (
            <EditorMetaBar result={loaded.meta} onOpenFile={handleOpenFile} />
          )}
          <MarkdownEditor
            key={activePath ?? ''}
            initialContent={loaded?.content ?? ''}
            onChange={onEditorChange}
            onSave={onEditorSave}
            onOpenWikiLink={onOpenWikiLink}
            onOpenTicket={onOpenTicket}
          />
        </>
      )}
    </div>
  )
}
