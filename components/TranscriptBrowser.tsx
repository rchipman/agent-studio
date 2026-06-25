'use client'

/**
 * TranscriptBrowser.tsx
 *
 * Two-pane session transcript browser (TIN-1751 combined Sessions view).
 *
 * Pane 1: Sessions column (~360px). Four stacked regions:
 *   (1) Filter bar — search + project select + "With subagents" toggle.
 *   (2) Calendar — cross-project month heatmap (the date filter).
 *   (3) List header — visible count, or the selected day + a clear button.
 *   (4) List — every session across every project, newest first; the ONLY
 *       scroller in the column.
 * Pane 2: Reader (conversation; human serif + tan rule, assistant serif +
 *   forest rule; tool-use blocks collapsed to "ran <tool>", expandable).
 *
 * The Projects rail and the List/Calendar toggle are retired: the project
 * select and search field absorb the rail's jobs, and the calendar IS the date
 * filter. Filters AND together (project · day · subagents · search hit set).
 *
 * Self-contained — the orchestrator wires cmd+T and view routing; this
 * component does not touch app/page.tsx.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { color, space, radius, type as typeToken } from '@/lib/tokens'
import MarkdownContent from '@/components/MarkdownContent'
import ViewBody from '@/components/ViewBody'
import { useTopBarSlot } from '@/components/TopBarSlot'
import TypeChip from '@/components/TypeChip'
import { disambiguate } from '@/lib/decodeProjectLabel'
import {
  estimateCost,
  formatCost,
  formatTokens,
  totalTokens,
} from '@/lib/sessionMetrics'
import type { UsageRollup } from '@/lib/sessionMetrics'

// ── IPC types (mirror transcript.rs) ─────────────────────────────────────────

interface TranscriptProject {
  project: string
  sessionCount: number
  lastDate: string
  cwd: string
}

interface SessionSummary {
  path: string
  project: string
  date: string
  firstMessage: string
  // TIN-1725 — fields emitted by the Rust backend (camelCase via serde rename_all)
  cwd: string
  subagentCount: number
  turnCount: number
  usage: UsageRollup
  models: string[]
}

interface Turn {
  role: 'human' | 'assistant' | string
  content: string
  hasToolUse: boolean
  toolSummary: string
  images: { mediaType: string; data: string }[]
}

interface TranscriptSearchResult {
  project: string
  sessionPath: string
  snippet: string
}

interface DayCount {
  date: string   // YYYY-MM-DD
  count: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return ''
  // iso = YYYY-MM-DD
  const [, mm, dd] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = parseInt(mm, 10)
  return `${months[m - 1] ?? mm} ${parseInt(dd, 10)}`
}

/** "1 session" / "n sessions". */
function sessionsLabel(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`
}

/** Zero-pad a number to 2 digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Today's date as YYYY-MM-DD in local time. */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** YYYY-MM from a Date. */
function yearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

/** Month label e.g. "Jun 2026". */
function monthLabel(year: number, month: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[month - 1]} ${year}`
}

/** Build the grid of day cells for the month. Week starts Monday.
 *  Returns an array where each element is YYYY-MM-DD (current month) or null
 *  (adjacent month filler). */
function buildMonthGrid(year: number, month: number): (string | null)[] {
  // First day of month (0=Sun..6=Sat), convert to Mon-based (0=Mon..6=Sun)
  const firstDate = new Date(year, month - 1, 1)
  const firstDow = (firstDate.getDay() + 6) % 7 // Monday = 0
  const daysInMonth = new Date(year, month, 0).getDate()

  const cells: (string | null)[] = []
  // leading filler
  for (let i = 0; i < firstDow; i++) cells.push(null)
  // actual days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${pad2(month)}-${pad2(d)}`)
  }
  // trailing filler to complete last row
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/** Intensity band: 0=transparent, 1=forestWash, 2=forestTint, 3=forestLine */
function intensityBg(count: number): string {
  if (count === 0) return 'transparent'
  if (count === 1) return color.forestWash
  if (count <= 3) return color.forestTint
  return color.forestLine
}

/** One step up from the base intensity (for selected day). */
function intensityBgSelected(count: number): string {
  if (count === 0) return color.forestWash
  if (count === 1) return color.forestTint
  return color.forestLine
}

// ── Session metrics (TIN-1725) ────────────────────────────────────────────────

/**
 * Quiet meta line showing token count + approximate cost for a session.
 * Uses inkFaint + typeToken.meta — recessive metadata, not a headline.
 * `compact` = true → single-line chip for the session list row.
 */
interface SessionMetaLineProps {
  usage: UsageRollup
  compact?: boolean
}

function SessionMetaLine({ usage, compact = false }: SessionMetaLineProps) {
  const total = totalTokens(usage)
  if (total === 0) return null

  const tokens = formatTokens(total)
  const cost = formatCost(estimateCost(usage))

  if (compact) {
    return (
      <span
        style={{
          ...typeToken.meta,
          color: color.inkFaint,
          whiteSpace: 'nowrap',
        }}
      >
        {tokens} · {cost}
      </span>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: space[4],
        ...typeToken.meta,
        color: color.inkFaint,
      }}
    >
      <span>{tokens} tokens</span>
      <span>{cost}</span>
    </div>
  )
}

// ── Project badge chip ───────────────────────────────────────────────────────

/** Existing tan project-badge chip (tanTint fill, tan text). Shown on list rows
 *  only when the project filter is All projects. */
function ProjectBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        ...typeToken.micro,
        background: color.tanTint,
        color: color.tan,
        borderRadius: radius.chip,
        padding: `1px ${space[2]}px`,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface ToolBlockProps {
  turn: Turn
}

function ToolBlock({ turn }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false)

  const label = turn.toolSummary
    ? `ran ${turn.toolSummary}`
    : 'ran tool'

  return (
    <div style={{ margin: `${space[3]}px 0` }}>
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: space[2],
          ...typeToken.mono,
          fontSize: 12,
          color: color.inkFaint,
        }}
        aria-expanded={expanded}
      >
        <span style={{ fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: space[2],
            padding: `${space[3]}px ${space[4]}px`,
            background: color.neutralTint,
            borderRadius: radius.md,
            ...typeToken.mono,
            fontSize: 12,
            color: color.inkSoft,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {turn.content || '(no content)'}
        </div>
      )}
    </div>
  )
}

interface ImageBlockProps {
  mediaType: string
  data: string
}

function InlineImage({ mediaType, data }: ImageBlockProps) {
  const [broken, setBroken] = useState(false)
  const src = `data:${mediaType};base64,${data}`
  // Broken/oversized image → a calm, recessive placeholder (matches the meta
  // type used elsewhere in this reader), never a broken-image glyph or alarm.
  if (broken) {
    return (
      <div style={{ margin: `${space[3]}px 0` }}>
        <span style={{ ...typeToken.meta, color: color.inkFaint }}>[image]</span>
      </div>
    )
  }
  return (
    // lineHeight:0 collapses the inline-image baseline gap so the framing is tight.
    <div style={{ margin: `${space[3]}px 0`, lineHeight: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        loading="lazy"
        alt="[attached image]"
        style={{
          maxWidth: '100%',
          maxHeight: 360,
          borderRadius: radius.md,
          border: `1px solid ${color.hair}`,
          display: 'block',
          objectFit: 'contain',
        }}
        onError={() => setBroken(true)}
      />
    </div>
  )
}

interface ConversationTurnProps {
  turn: Turn
  highlight: boolean
}

function ConversationTurn({ turn, highlight }: ConversationTurnProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlight && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlight])

  const isHuman = turn.role === 'human'
  const ruleColor = isHuman ? color.tan : color.forest
  const label = isHuman ? 'you' : 'assistant'

  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        gap: space[5],
        padding: `${space[5]}px 0`,
        transition: 'background 0.4s ease',
        background: highlight ? color.forestWash : 'transparent',
        borderRadius: radius.card,
      }}
    >
      {/* Rule */}
      <div
        style={{
          width: 2,
          flexShrink: 0,
          borderRadius: 1,
          background: ruleColor,
          opacity: 0.5,
          marginTop: 4,
          alignSelf: 'stretch',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Label */}
        <div
          style={{
            ...typeToken.label,
            color: ruleColor,
            marginBottom: space[2],
            opacity: 0.8,
          }}
        >
          {label}
        </div>

        {/* Content */}
        {turn.hasToolUse ? (
          <div>
            {/* Text portion of a mixed turn, if any */}
            {turn.content.trim() && (
              <div style={{ marginBottom: space[3] }}>
                <MarkdownContent content={turn.content} />
              </div>
            )}
            <ToolBlock turn={turn} />
            {(turn.images ?? []).map((img, i) => (
              <InlineImage key={i} mediaType={img.mediaType} data={img.data} />
            ))}
          </div>
        ) : (
          <div>
            <MarkdownContent content={turn.content} />
            {(turn.images ?? []).map((img, i) => (
              <InlineImage key={i} mediaType={img.mediaType} data={img.data} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Calendar (cross-project month heatmap = the date filter) ─────────────────

interface CalendarProps {
  selectedProject: string
  selectedDay: string | null
  onPickDay: (day: string) => void
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function Calendar({ selectedProject, selectedDay, onPickDay }: CalendarProps) {
  const today = todayIso()
  const now = useMemo(() => new Date(), [])
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [dayCountMap, setDayCountMap] = useState<Map<string, number>>(new Map())

  // Reload counts when the project filter changes. An empty project means the
  // all-projects calendar (the backend drops the WHERE project).
  useEffect(() => {
    invoke<DayCount[]>('sessions_by_day', { payload: { project: selectedProject } })
      .then(rows => {
        const m = new Map<string, number>()
        for (const r of rows) m.set(r.date, r.count)
        setDayCountMap(m)
      })
      .catch(() => setDayCountMap(new Map()))
  }, [selectedProject])

  const currentYM = yearMonth(now)
  const viewYM = `${viewYear}-${pad2(viewMonth)}`
  const atCurrentMonth = viewYM >= currentYM

  function stepMonth(delta: number) {
    const d = new Date(viewYear, viewMonth - 1 + delta, 1)
    if (delta > 0 && yearMonth(d) > currentYM) return
    setViewYear(d.getFullYear())
    setViewMonth(d.getMonth() + 1)
  }

  const cells = buildMonthGrid(viewYear, viewMonth)
  const monthHasSessions = cells.some(c => c && (dayCountMap.get(c) ?? 0) > 0)

  return (
    <div style={{ flexShrink: 0, borderBottom: `1px solid ${color.hairSoft}` }}>
      {/* Month stepper */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: space[1],
          padding: `${space[2]}px ${space[3]}px`,
        }}
      >
        {/* Back chevron */}
        <button
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
          style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: radius.sm,
            cursor: 'pointer',
            color: color.inkSoft,
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.forest }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkSoft }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10,3 5,8 10,13" />
          </svg>
        </button>

        {/* Month label */}
        <span style={{ ...typeToken.label, color: color.inkSoft, minWidth: 52, textAlign: 'center' }}>
          {monthLabel(viewYear, viewMonth)}
        </span>

        {/* Forward chevron - disabled at current month */}
        <button
          onClick={() => stepMonth(1)}
          disabled={atCurrentMonth}
          aria-label="Next month"
          style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: radius.sm,
            cursor: atCurrentMonth ? 'default' : 'pointer',
            color: color.inkSoft,
            opacity: atCurrentMonth ? 0.4 : 1,
            padding: 0,
          }}
          onMouseEnter={e => { if (!atCurrentMonth) { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.forest } }}
          onMouseLeave={e => { if (!atCurrentMonth) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkSoft } }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6,3 11,8 6,13" />
          </svg>
        </button>
      </div>

      {/* Calendar grid */}
      <div style={{ padding: `0 ${space[3]}px ${space[2]}px` }}>
        {/* Weekday headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: space[1], marginBottom: space[1] }}>
          {WEEKDAYS.map(d => (
            <div
              key={d}
              style={{
                ...typeToken.micro,
                color: color.inkFaint,
                textAlign: 'center',
                padding: `${space[1]}px 0`,
              }}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: space[1] }}>
          {cells.map((cell, i) => {
            if (!cell) {
              return <div key={`filler-${i}`} style={{ minHeight: 30 }} />
            }
            const count = dayCountMap.get(cell) ?? 0
            const isToday = cell === today
            const isSelected = cell === selectedDay
            const hasSessions = count > 0
            const bg = isSelected ? intensityBgSelected(count) : intensityBg(count)
            const tooltipText = hasSessions ? sessionsLabel(count) : undefined

            return (
              <div
                key={cell}
                title={tooltipText}
                onClick={() => {
                  // Click a day with sessions → set the day filter; click the
                  // selected day again → clear it (the parent toggles).
                  if (!hasSessions) return
                  onPickDay(cell)
                }}
                style={{
                  minHeight: 30,
                  borderRadius: radius.sm,
                  background: bg,
                  border: isSelected
                    ? `1px solid ${color.forest}`
                    : '1px solid transparent',
                  cursor: hasSessions ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: `${space[1]}px`,
                  boxSizing: 'border-box',
                  position: 'relative',
                }}
                onMouseEnter={e => {
                  if (hasSessions && !isSelected) {
                    e.currentTarget.style.border = `1px solid ${color.forestLine}`
                  }
                }}
                onMouseLeave={e => {
                  if (hasSessions && !isSelected) {
                    e.currentTarget.style.border = '1px solid transparent'
                  }
                }}
              >
                {/* Day number */}
                <span
                  style={{
                    ...typeToken.meta,
                    color: isToday ? color.forest : color.ink,
                    fontWeight: isToday ? 600 : 400,
                    lineHeight: 1,
                    fontSize: 11,
                  }}
                >
                  {parseInt(cell.split('-')[2], 10)}
                </span>
                {/* Session count badge */}
                {count > 0 && (
                  <span
                    style={{
                      ...typeToken.micro,
                      color: color.inkSoft,
                      alignSelf: 'flex-end',
                      lineHeight: 1,
                    }}
                  >
                    {count}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        {/* Empty month message */}
        {!monthHasSessions && (
          <div
            style={{
              ...typeToken.body,
              color: color.inkFaint,
              textAlign: 'center',
              padding: `${space[4]}px 0 ${space[2]}px`,
            }}
          >
            No sessions this month.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface TranscriptBrowserProps {
  /** Retained for parity with the other full views; Sessions has no top-bar
   *  right slot and Esc behaviour is unchanged from before. */
  onClose?: () => void
}

export default function TranscriptBrowser({}: TranscriptBrowserProps) {
  // Sessions has an empty top-bar right slot (its search lives in pane 1).
  // Clear any slot the previous view registered. (TIN-1708)
  const { setRight } = useTopBarSlot()
  useEffect(() => {
    setRight(null)
    return () => setRight(null)
  }, [setRight])

  // ── State ──────────────────────────────────────────────────────────────────

  const [projects, setProjects] = useState<TranscriptProject[]>([])
  const [noRoot, setNoRoot] = useState(false)

  // Filter state. selectedProject '' = All projects (a filter value, not a
  // navigation requirement). selectedDay null = no day constraint.
  const [selectedProject, setSelectedProject] = useState('')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [withSubagents, setWithSubagents] = useState(false)

  // The full cross-project session list (loaded once; re-filtered in memory).
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)

  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null)

  const [turns, setTurns] = useState<Turn[]>([])
  const [turnsLoading, setTurnsLoading] = useState(false)

  // FTS search composes as a client-side filter over the in-memory list.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<Map<string, string>>(new Map()) // path → snippet
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)

  // Highlight tracking for the search-hit scroll. We remember the snippet of
  // the session opened from a search hit so the reader scrolls to + washes the
  // first matching turn once its turns load.
  const [highlightTurnIdx, setHighlightTurnIdx] = useState<number | null>(null)
  const [pendingSearchHit, setPendingSearchHit] = useState<string | null>(null)

  // ── Load projects (for the select) + decode labels ─────────────────────────

  useEffect(() => {
    invoke<TranscriptProject[]>('list_transcript_projects')
      .then(p => {
        setProjects(p)
        setNoRoot(false)
      })
      .catch(err => {
        const msg = String(err)
        if (msg.includes('transcripts_root') || msg.includes('No such file')) {
          setNoRoot(true)
        }
      })
  }, [])

  // Decode + disambiguate project labels once when projects load.
  const labelByProject = useMemo(
    () => disambiguate(projects.map(p => ({ project: p.project, cwd: p.cwd }))),
    [projects],
  )
  const labelFor = useCallback(
    (project: string) => labelByProject.get(project) ?? project,
    [labelByProject],
  )

  // ── Load the full cross-project session list once ──────────────────────────

  useEffect(() => {
    if (noRoot) return
    setSessionsLoading(true)
    invoke<SessionSummary[]>('list_sessions', { payload: { project: '' } })
      .then(s => {
        setSessions(s)
        setSessionsLoading(false)
      })
      .catch(() => setSessionsLoading(false))
  }, [noRoot])

  // ── Load turns when a session is selected ──────────────────────────────────

  useEffect(() => {
    if (!selectedSession) return
    setTurnsLoading(true)
    setTurns([])
    setHighlightTurnIdx(null)
    invoke<Turn[]>('get_session', { payload: { path: selectedSession.path } })
      .then(t => {
        setTurns(t)
        setTurnsLoading(false)
      })
      .catch(() => setTurnsLoading(false))
  }, [selectedSession])

  // After a search-hit session loads, scroll to + wash the first matching turn.
  useEffect(() => {
    if (!pendingSearchHit || turnsLoading || turns.length === 0) return
    const needle = pendingSearchHit.toLowerCase()
    const idx = turns.findIndex(t => t.content.toLowerCase().includes(needle))
    setHighlightTurnIdx(idx >= 0 ? idx : null)
    setPendingSearchHit(null)
  }, [pendingSearchHit, turnsLoading, turns])

  // ── FTS search (debounced 300ms; composes as a filter) ─────────────────────

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback((q: string) => {
    if (!q.trim()) {
      setSearchHits(new Map())
      setSearchDone(false)
      setSearching(false)
      return
    }
    setSearching(true)
    setSearchDone(false)
    invoke<TranscriptSearchResult[]>('search_transcripts', { payload: { q } })
      .then(r => {
        const m = new Map<string, string>()
        for (const hit of r) {
          if (!m.has(hit.sessionPath)) m.set(hit.sessionPath, hit.snippet)
        }
        setSearchHits(m)
        setSearching(false)
        setSearchDone(true)
      })
      .catch(() => {
        setSearchHits(new Map())
        setSearching(false)
        setSearchDone(true)
      })
  }, [])

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value
    setSearchQuery(q)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => runSearch(q), 300)
  }

  const isSearchActive = searchQuery.trim().length > 0

  // ── Compose the visible list (project AND day AND subagents AND FTS) ────────

  const visibleSessions = useMemo(() => {
    return sessions.filter(s => {
      if (selectedProject && s.project !== selectedProject) return false
      if (selectedDay && s.date !== selectedDay) return false
      if (withSubagents && s.subagentCount <= 0) return false
      if (isSearchActive && !searchHits.has(s.path)) return false
      return true
    })
  }, [sessions, selectedProject, selectedDay, withSubagents, isSearchActive, searchHits])

  // Per-project session counts for the select options.
  const countByProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of sessions) m.set(s.project, (m.get(s.project) ?? 0) + 1)
    return m
  }, [sessions])

  // ── Selection ──────────────────────────────────────────────────────────────

  function selectSession(s: SessionSummary, snippet?: string) {
    setSelectedSession(s)
    setPendingSearchHit(snippet ?? null)
  }

  function pickDay(day: string) {
    // Click the already-selected day clears it; otherwise set it.
    setSelectedDay(prev => (prev === day ? null : day))
  }

  function clearDay() {
    setSelectedDay(null)
  }

  // ── Shared row style (verbatim sessionRowStyle) ────────────────────────────

  function sessionRowStyle(active: boolean): React.CSSProperties {
    return {
      padding: `${space[3]}px ${space[5]}px`,
      cursor: 'pointer',
      borderRadius: radius.card,
      background: active ? color.forestWash : 'transparent',
      borderLeft: active ? `2px solid ${color.forest}` : '2px solid transparent',
      transition: 'background 0.15s ease',
    }
  }

  // ── Shared chrome for the search + select controls ─────────────────────────

  const fieldChrome: React.CSSProperties = {
    boxSizing: 'border-box',
    background: color.bgField,
    border: `1px solid ${color.line}`,
    borderRadius: radius.md,
    color: color.ink,
    outline: 'none',
  }

  // ── List body (the scroller) ───────────────────────────────────────────────

  const showBadges = selectedProject === '' // hide per-row badge when one project is selected

  let listBody: React.ReactNode
  if (sessionsLoading) {
    listBody = (
      <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
        Reading sessions…
      </div>
    )
  } else if (isSearchActive && searching) {
    listBody = (
      <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
        Reading sessions…
      </div>
    )
  } else if (isSearchActive && searchDone && visibleSessions.length === 0) {
    listBody = (
      <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
        Nothing matched.
      </div>
    )
  } else if (visibleSessions.length === 0) {
    // A selected day with no rows reads differently from a general no-match.
    const msg = selectedDay
      ? 'No sessions on this day.'
      : 'No sessions match your filters.'
    listBody = (
      <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
        {msg}
      </div>
    )
  } else {
    listBody = visibleSessions.map(s => {
      const active = selectedSession?.path === s.path
      const snippet = isSearchActive ? searchHits.get(s.path) : undefined
      const preview = snippet ?? s.firstMessage ?? ''
      return (
        <div
          key={s.path}
          onClick={() => selectSession(s, snippet)}
          style={sessionRowStyle(active)}
          onMouseEnter={e => {
            if (!active) (e.currentTarget as HTMLDivElement).style.background = color.bgFieldStrong
          }}
          onMouseLeave={e => {
            if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
          }}
        >
          {/* Line 1: date · compact metrics */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: space[3], marginBottom: 2 }}>
            <span style={{ ...typeToken.body, color: color.ink }}>
              {formatDate(s.date)}
            </span>
            {s.usage && <SessionMetaLine usage={s.usage} compact />}
          </div>
          {/* Line 2: project badge (only when All projects) + preview */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: space[2], minWidth: 0 }}>
            {showBadges && <ProjectBadge label={labelFor(s.project)} />}
            <span
              style={{
                ...typeToken.meta,
                color: color.inkSoft,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                minWidth: 0,
                flex: 1,
              }}
            >
              {preview || 'This session is empty.'}
            </span>
          </div>
        </div>
      )
    })
  }

  // ── Reader (pane 3 — unchanged) ────────────────────────────────────────────

  let readerBody: React.ReactNode
  if (noRoot) {
    readerBody = (
      <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
        Set a transcripts root in Settings to browse sessions.
      </div>
    )
  } else if (!selectedSession) {
    readerBody = (
      <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
        Select a session to read the transcript.
      </div>
    )
  } else if (turnsLoading) {
    readerBody = (
      <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkSoft }}>
        Reading sessions…
      </div>
    )
  } else if (turns.length === 0) {
    readerBody = (
      <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
        This session is empty.
      </div>
    )
  } else {
    readerBody = (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Session detail header — date + quiet metrics (TIN-1725) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: space[4],
            paddingBottom: space[5],
            marginBottom: space[5],
            borderBottom: `1px solid ${color.hairSoft}`,
          }}
        >
          <span style={{ ...typeToken.meta, color: color.inkSoft }}>
            {formatDate(selectedSession.date)}
            {selectedSession.subagentCount > 0 && (
              <> · {selectedSession.subagentCount} {selectedSession.subagentCount === 1 ? 'subagent' : 'subagents'}</>
            )}
          </span>
          {selectedSession.usage && (
            <SessionMetaLine usage={selectedSession.usage} />
          )}
        </div>
        {turns.map((turn, i) => (
          <div key={i} style={{ borderBottom: `1px solid ${color.hairSoft}` }}>
            <ConversationTurn
              turn={turn}
              highlight={highlightTurnIdx === i}
            />
          </div>
        ))}
      </div>
    )
  }

  // ── List header ────────────────────────────────────────────────────────────

  const listHeader = (
    <div
      style={{
        flexShrink: 0,
        height: 32,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space[2],
        padding: `0 ${space[4]}px`,
        borderBottom: `1px solid ${color.hairSoft}`,
        ...typeToken.meta,
        color: color.inkSoft,
      }}
    >
      {selectedDay ? (
        <>
          <span style={{ color: color.inkSoft, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {formatDate(selectedDay)} · {sessionsLabel(visibleSessions.length)}
          </span>
          <button
            onClick={clearDay}
            aria-label="Clear day filter"
            style={{
              width: 20,
              height: 20,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: radius.sm,
              cursor: 'pointer',
              color: color.inkFaint,
              padding: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.inkSoft }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkFaint }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </>
      ) : (
        <span>All sessions · {visibleSessions.length}</span>
      )}
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  const body = (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ── Sessions column ── */}
      <div
        style={{
          width: 360,
          flexShrink: 0,
          borderRight: `1px solid ${color.hair}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {noRoot ? (
          <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
            Set a transcripts root in Settings to browse sessions.
          </div>
        ) : (
          <>
            {/* (1) Filter bar */}
            <div
              style={{
                flexShrink: 0,
                padding: `${space[3]}px ${space[4]}px`,
                borderBottom: `1px solid ${color.hairSoft}`,
                display: 'flex',
                flexDirection: 'column',
                gap: space[2],
              }}
            >
              {/* Row 1: search */}
              <input
                type="text"
                placeholder="Search sessions…"
                value={searchQuery}
                onChange={handleSearchChange}
                style={{
                  ...fieldChrome,
                  width: '100%',
                  padding: `${space[2]}px ${space[3]}px`,
                  ...typeToken.body,
                  color: color.ink,
                }}
                onFocus={e => { e.target.style.borderColor = color.forest }}
                onBlur={e => { e.target.style.borderColor = color.line }}
              />

              {/* Row 2: project select + subagents chip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
                <select
                  value={selectedProject}
                  onChange={e => setSelectedProject(e.target.value)}
                  style={{
                    ...fieldChrome,
                    flex: 1,
                    minWidth: 0,
                    padding: `${space[2]}px ${space[3]}px`,
                    ...typeToken.body,
                    cursor: 'pointer',
                    appearance: 'none',
                  }}
                  onFocus={e => { e.target.style.borderColor = color.forest }}
                  onBlur={e => { e.target.style.borderColor = color.line }}
                >
                  <option value="">All projects</option>
                  {projects.map(p => (
                    <option key={p.project} value={p.project}>
                      {labelFor(p.project)} ({countByProject.get(p.project) ?? p.sessionCount})
                    </option>
                  ))}
                </select>

                <TypeChip
                  label="With subagents"
                  active={withSubagents}
                  onClick={() => setWithSubagents(v => !v)}
                />
              </div>
            </div>

            {/* (2) Calendar */}
            <Calendar
              selectedProject={selectedProject}
              selectedDay={selectedDay}
              onPickDay={pickDay}
            />

            {/* (3) List header */}
            {listHeader}

            {/* (4) List — the only scroller */}
            <div style={{ flex: 1, overflowY: 'auto', padding: `${space[2]}px ${space[2]}px` }}>
              {listBody}
            </div>
          </>
        )}
      </div>

      {/* ── Reader (pane 3 — unchanged) ── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: color.bgRaised,
        }}
      >
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: `${space[7]}px ${space[8]}px`,
          }}
        >
          {readerBody}
        </div>
      </div>

    </div>
  )

  // The body fills the content area below the one persistent top bar (which now
  // owns the `Sessions` title and the history arrows). TIN-1708.
  return <ViewBody>{body}</ViewBody>
}
