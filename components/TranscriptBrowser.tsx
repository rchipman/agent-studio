'use client'

/**
 * TranscriptBrowser.tsx
 *
 * Three-pane session transcript browser (TIN-1636).
 * Pane 1: Projects rail (project list + session counts; FTS search switches to
 *          flat result rows).
 * Pane 2: Sessions list (newest first, forest-wash selection) with a
 *          List / Calendar toggle at the top (TIN-1751).
 * Pane 3: Conversation (human serif + tan rule, assistant serif + forest rule;
 *          tool-use blocks collapsed to "ran <tool>", expandable).
 *
 * Self-contained — the orchestrator wires cmd+T and view routing; this
 * component does not touch app/page.tsx.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { color, space, radius, font, type as typeToken } from '@/lib/tokens'
import MarkdownContent from '@/components/MarkdownContent'
import ViewBody from '@/components/ViewBody'
import { useTopBarSlot } from '@/components/TopBarSlot'

// ── IPC types (mirror transcript.rs) ─────────────────────────────────────────

interface TranscriptProject {
  project: string
  sessionCount: number
  lastDate: string
}

interface SessionSummary {
  path: string
  date: string
  firstMessage: string
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
            background: 'rgba(38,35,32,0.04)',
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
  const src = `data:${mediaType};base64,${data}`
  return (
    <div
      style={{
        margin: `${space[3]}px 0`,
        lineHeight: 0,
      }}
    >
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
        onError={e => {
          const el = e.currentTarget
          el.style.display = 'none'
          const ph = document.createElement('span')
          ph.textContent = '[image]'
          ph.style.cssText = `font-family: ${font.mono}; font-size: 12px; color: ${color.inkFaint};`
          el.parentElement?.appendChild(ph)
        }}
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

// ── Calendar pane body ────────────────────────────────────────────────────────

interface CalendarPaneProps {
  selectedProject: string | null
  sessions: SessionSummary[]
  sessionsLoading: boolean
  selectedSession: SessionSummary | null
  onSelectSession: (s: SessionSummary) => void
  sessionRowStyle: (active: boolean) => React.CSSProperties
}

function CalendarPane({
  selectedProject,
  sessions,
  sessionsLoading,
  selectedSession,
  onSelectSession,
  sessionRowStyle,
}: CalendarPaneProps) {
  const today = todayIso()
  const now = new Date()
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [dayCountMap, setDayCountMap] = useState<Map<string, number>>(new Map())
  const [countsLoading, setCountsLoading] = useState(false)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Reload counts when project changes
  useEffect(() => {
    if (!selectedProject) {
      setDayCountMap(new Map())
      return
    }
    setCountsLoading(true)
    invoke<DayCount[]>('sessions_by_day', { payload: { project: selectedProject } })
      .then(rows => {
        const m = new Map<string, number>()
        for (const r of rows) m.set(r.date, r.count)
        setDayCountMap(m)
        setCountsLoading(false)
      })
      .catch(() => setCountsLoading(false))
  }, [selectedProject])

  // Reset selected day when project or month changes
  useEffect(() => {
    setSelectedDay(null)
  }, [selectedProject, viewYear, viewMonth])

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

  // Sessions for selected day
  const dayPrefix = selectedDay ? selectedDay : null
  const daySessions = dayPrefix
    ? sessions.filter(s => s.date === dayPrefix)
    : []

  // Month has any sessions
  const monthHasSessions = cells.some(c => c && (dayCountMap.get(c) ?? 0) > 0)

  if (!selectedProject) {
    return null // Pane 2 shows the "select a project" message; this is a no-op path
  }

  if (countsLoading || sessionsLoading) {
    return (
      <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
        Reading sessions...
      </div>
    )
  }

  const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Month stepper */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: space[1],
          padding: `${space[2]}px ${space[3]}px`,
          borderBottom: `1px solid ${color.hairSoft}`,
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
      <div style={{ padding: `${space[3]}px ${space[3]}px ${space[2]}px`, flex: '0 0 auto' }}>
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
              return <div key={`filler-${i}`} style={{ minHeight: 36 }} />
            }
            const count = dayCountMap.get(cell) ?? 0
            const isToday = cell === today
            const isSelected = cell === selectedDay
            const hasSessions = count > 0
            const bg = isSelected ? intensityBgSelected(count) : intensityBg(count)
            const tooltipText = count === 1 ? '1 session' : count > 1 ? `${count} sessions` : undefined

            return (
              <div
                key={cell}
                title={tooltipText}
                onClick={() => {
                  if (!hasSessions) return
                  if (count === 1 && daySessions.length === 0) {
                    // Will be set below; first set the day so daySessions populates
                    setSelectedDay(cell)
                    // find the single session and open it directly
                    const single = sessions.find(s => s.date === cell)
                    if (single) onSelectSession(single)
                  } else if (count === 1) {
                    setSelectedDay(cell)
                    const single = sessions.find(s => s.date === cell)
                    if (single) onSelectSession(single)
                  } else {
                    setSelectedDay(isSelected ? null : cell)
                  }
                }}
                style={{
                  minHeight: 36,
                  borderRadius: radius.sm,
                  background: bg,
                  border: isSelected
                    ? `1px solid ${color.forest}`
                    : hasSessions
                    ? `1px solid transparent`
                    : `1px solid transparent`,
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

      {/* Day session list */}
      {selectedDay && daySessions.length > 0 && (
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            borderTop: `1px solid ${color.hairSoft}`,
            padding: `${space[2]}px ${space[2]}px`,
          }}
        >
          {daySessions.map(s => {
            const active = selectedSession?.path === s.path
            return (
              <div
                key={s.path}
                onClick={() => onSelectSession(s)}
                style={sessionRowStyle(active)}
                onMouseEnter={e => {
                  if (!active)
                    (e.currentTarget as HTMLDivElement).style.background = color.bgFieldStrong
                }}
                onMouseLeave={e => {
                  if (!active)
                    (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: space[3], marginBottom: 2 }}>
                  <span style={{ ...typeToken.body, color: color.ink }}>
                    {formatDate(s.date)}
                  </span>
                </div>
                <div
                  style={{
                    ...typeToken.meta,
                    color: color.inkSoft,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {s.firstMessage || 'Empty session'}
                </div>
              </div>
            )
          })}
        </div>
      )}
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
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const [selectedProject, setSelectedProject] = useState<string | null>(null)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null)

  const [turns, setTurns] = useState<Turn[]>([])
  const [turnsLoading, setTurnsLoading] = useState(false)

  // FTS search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TranscriptSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)

  // Highlight tracking for search hit scroll
  const [highlightTurnIdx, setHighlightTurnIdx] = useState<number | null>(null)

  // No transcripts root configured
  const [noRoot, setNoRoot] = useState(false)

  // Pane 2 toggle: 'list' | 'calendar'
  const [pane2Mode, setPane2Mode] = useState<'list' | 'calendar'>('list')

  // ── Load projects ──────────────────────────────────────────────────────────

  useEffect(() => {
    setProjectsLoading(true)
    invoke<TranscriptProject[]>('list_transcript_projects')
      .then(p => {
        setProjects(p)
        setProjectsLoading(false)
        setNoRoot(false)
      })
      .catch(err => {
        const msg = String(err)
        if (msg.includes('transcripts_root') || msg.includes('No such file')) {
          setNoRoot(true)
        } else {
          setProjectsError(msg)
        }
        setProjectsLoading(false)
      })
  }, [])

  // ── Load sessions when project selected ───────────────────────────────────

  useEffect(() => {
    if (!selectedProject) return
    setSessionsLoading(true)
    setSessions([])
    setSelectedSession(null)
    setTurns([])
    invoke<SessionSummary[]>('list_sessions', { payload: { project: selectedProject } })
      .then(s => {
        setSessions(s)
        setSessionsLoading(false)
      })
      .catch(() => setSessionsLoading(false))
  }, [selectedProject])

  // ── Load turns when session selected ─────────────────────────────────────

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

  // ── FTS search ─────────────────────────────────────────────────────────────

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback((q: string) => {
    if (!q.trim()) {
      setSearchResults([])
      setSearchDone(false)
      return
    }
    setSearching(true)
    setSearchDone(false)
    invoke<TranscriptSearchResult[]>('search_transcripts', { payload: { q } })
      .then(r => {
        setSearchResults(r)
        setSearching(false)
        setSearchDone(true)
      })
      .catch(() => {
        setSearchResults([])
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

  function handleSearchResultClick(result: TranscriptSearchResult) {
    // Select the project and session.
    setSearchQuery('')
    setSearchResults([])
    setSearchDone(false)
    setSelectedProject(result.project)
    // Load the session directly.
    const fake: SessionSummary = {
      path: result.sessionPath,
      date: '',
      firstMessage: result.snippet,
    }
    setSelectedSession(fake)
  }

  const isSearchActive = searchQuery.trim().length > 0

  // ── Shared list row styles ─────────────────────────────────────────────────

  function projectRowStyle(active: boolean): React.CSSProperties {
    return {
      padding: `${space[3]}px ${space[5]}px`,
      cursor: 'pointer',
      borderRadius: radius.card,
      background: active ? color.forestWash : 'transparent',
      borderLeft: active ? `2px solid ${color.forest}` : '2px solid transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space[3],
      transition: 'background 0.15s ease',
    }
  }

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

  // ── Render ─────────────────────────────────────────────────────────────────

  // Three-pane browse layout (shared by both the full-view and embedded forms).
  const body = (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Pane 1: Projects rail ── */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: `1px solid ${color.hair}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Search field */}
          <div style={{ padding: `${space[3]}px ${space[4]}px`, borderBottom: `1px solid ${color.hairSoft}` }}>
            <input
              type="text"
              placeholder="Search transcripts..."
              value={searchQuery}
              onChange={handleSearchChange}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: color.bgField,
                border: `1px solid ${color.line}`,
                borderRadius: radius.md,
                padding: `${space[2]}px ${space[3]}px`,
                ...typeToken.body,
                color: color.ink,
                outline: 'none',
              }}
              onFocus={e => { e.target.style.borderColor = color.forest }}
              onBlur={e => { e.target.style.borderColor = color.line }}
            />
          </div>

          {/* List area */}
          <div style={{ flex: 1, overflowY: 'auto', padding: `${space[2]}px ${space[2]}px` }}>

            {isSearchActive ? (
              // Search results mode
              searching ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
                  Loading...
                </div>
              ) : searchDone && searchResults.length === 0 ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  Nothing matched.
                </div>
              ) : (
                searchResults.map((r, i) => (
                  <div
                    key={i}
                    onClick={() => handleSearchResultClick(r)}
                    style={{
                      padding: `${space[3]}px ${space[4]}px`,
                      cursor: 'pointer',
                      borderRadius: radius.card,
                      marginBottom: space[1],
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = color.bgFieldStrong }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[2], marginBottom: 2 }}>
                      <span
                        style={{
                          ...typeToken.micro,
                          background: color.forestTint,
                          color: color.forest,
                          borderRadius: radius.chip,
                          padding: `1px ${space[2]}px`,
                        }}
                      >
                        {r.project}
                      </span>
                    </div>
                    <div
                      style={{
                        ...typeToken.meta,
                        color: color.inkSoft,
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {r.snippet}
                    </div>
                  </div>
                ))
              )
            ) : (
              // Project list mode
              projectsLoading ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
                  Loading...
                </div>
              ) : projectsError ? (
                <div
                  style={{
                    margin: space[4],
                    padding: `${space[3]}px ${space[4]}px`,
                    background: 'rgba(155,123,90,0.08)',
                    borderRadius: radius.md,
                    ...typeToken.body,
                    color: color.notice,
                  }}
                >
                  {projectsError}
                </div>
              ) : noRoot ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  Set a transcripts root in Settings to browse sessions.
                </div>
              ) : projects.length === 0 ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  No projects found.
                </div>
              ) : (
                projects.map(p => (
                  <div
                    key={p.project}
                    onClick={() => setSelectedProject(p.project)}
                    style={projectRowStyle(selectedProject === p.project)}
                    onMouseEnter={e => {
                      if (selectedProject !== p.project)
                        (e.currentTarget as HTMLDivElement).style.background = color.bgFieldStrong
                    }}
                    onMouseLeave={e => {
                      if (selectedProject !== p.project)
                        (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                    }}
                  >
                    <span style={{ ...typeToken.body, color: color.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.project}
                    </span>
                    <span style={{ ...typeToken.meta, color: color.inkFaint, flexShrink: 0 }}>
                      {p.sessionCount}
                    </span>
                  </div>
                ))
              )
            )}
          </div>
        </div>

        {/* ── Pane 2: Sessions ── */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            borderRight: `1px solid ${color.hair}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* List / Calendar toggle strip */}
          <div
            style={{
              borderBottom: `1px solid ${color.hairSoft}`,
              padding: `${space[2]}px ${space[3]}px`,
              display: 'flex',
              alignItems: 'flex-end',
              flexShrink: 0,
            }}
          >
            {(['list', 'calendar'] as const).map(id => {
              const active = pane2Mode === id
              const label = id === 'list' ? 'List' : 'Calendar'
              return (
                <button
                  key={id}
                  onClick={() => setPane2Mode(id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    borderBottom: active ? `1.5px solid ${color.forest}` : '1.5px solid transparent',
                    padding: `0 0 ${space[2]}px`,
                    marginRight: space[4],
                    cursor: 'pointer',
                    ...typeToken.meta,
                    color: active ? color.forest : color.inkSoft,
                    fontWeight: active ? 600 : 400,
                    transition: 'color 0.1s ease, border-color 0.1s ease',
                    lineHeight: 1,
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.color = color.ink }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.color = color.inkSoft }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* Body */}
          {pane2Mode === 'list' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: `${space[2]}px ${space[2]}px` }}>
              {noRoot ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  Set a transcripts root in Settings to browse sessions.
                </div>
              ) : !selectedProject ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  Select a project to see sessions.
                </div>
              ) : sessionsLoading ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkSoft, textAlign: 'center' }}>
                  Loading...
                </div>
              ) : sessions.length === 0 ? (
                <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                  No sessions in this project yet.
                </div>
              ) : (
                sessions.map(s => {
                  const active = selectedSession?.path === s.path
                  return (
                    <div
                      key={s.path}
                      onClick={() => setSelectedSession(s)}
                      style={sessionRowStyle(active)}
                      onMouseEnter={e => {
                        if (!active)
                          (e.currentTarget as HTMLDivElement).style.background = color.bgFieldStrong
                      }}
                      onMouseLeave={e => {
                        if (!active)
                          (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: space[3], marginBottom: 2 }}>
                        <span style={{ ...typeToken.body, color: color.ink }}>
                          {formatDate(s.date)}
                        </span>
                      </div>
                      <div
                        style={{
                          ...typeToken.meta,
                          color: color.inkSoft,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {s.firstMessage || 'Empty session'}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            // Calendar mode
            noRoot ? (
              <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                Set a transcripts root in Settings to browse sessions.
              </div>
            ) : !selectedProject ? (
              <div style={{ padding: space[5], ...typeToken.body, color: color.inkFaint, textAlign: 'center' }}>
                Select a project to see sessions.
              </div>
            ) : (
              <CalendarPane
                selectedProject={selectedProject}
                sessions={sessions}
                sessionsLoading={sessionsLoading}
                selectedSession={selectedSession}
                onSelectSession={setSelectedSession}
                sessionRowStyle={sessionRowStyle}
              />
            )
          )}
        </div>

        {/* ── Pane 3: Conversation ── */}
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
            {noRoot ? (
              <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
                Set a transcripts root in Settings to browse sessions.
              </div>
            ) : !selectedSession ? (
              <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
                Select a session to read the transcript.
              </div>
            ) : turnsLoading ? (
              <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkSoft }}>
                Loading...
              </div>
            ) : turns.length === 0 ? (
              <div style={{ textAlign: 'center', paddingTop: 80, ...typeToken.body, color: color.inkFaint }}>
                This session is empty.
              </div>
            ) : (
              <div style={{ maxWidth: 720, margin: '0 auto' }}>
                {turns.map((turn, i) => (
                  <div key={i} style={{ borderBottom: `1px solid ${color.hairSoft}` }}>
                    <ConversationTurn
                      turn={turn}
                      highlight={highlightTurnIdx === i}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

    </div>
  )

  // The body fills the content area below the one persistent top bar (which now
  // owns the `Sessions` title and the history arrows). TIN-1708.
  return <ViewBody>{body}</ViewBody>
}
