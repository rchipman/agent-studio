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
import { listen } from '@tauri-apps/api/event'
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
  sumUsage,
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
  // ── Threading (TIN-1721) — present on every turn; drives spine vs Work split ──
  isSidechain: boolean
  agentId: string | null
  agentLabel: string | null
  spawnedBy: string | null
}

/** A produced artifact (TIN-1771). kind: pr | ticket | memory | file | image | commit. */
interface Outcome {
  kind: string
  label: string
  address: string
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

// ── Session detail: segments, outcomes ribbon, work list (TIN-1771) ───────────

/** Per-kind display metadata for the Outcomes ribbon. Calm tints only. */
const OUTCOME_META: Record<string, { singular: string; plural: string; bg: string; fg: string }> = {
  pr: { singular: 'PR', plural: 'PRs', bg: color.forestTint, fg: color.forest },
  ticket: { singular: 'ticket', plural: 'tickets', bg: color.forestTint, fg: color.forest },
  memory: { singular: 'memory', plural: 'memories', bg: color.tanTint, fg: color.tan },
  file: { singular: 'file', plural: 'files', bg: color.neutralTint, fg: color.inkSoft },
  image: { singular: 'image', plural: 'images', bg: color.neutralTint, fg: color.inkSoft },
  commit: { singular: 'commit', plural: 'commits', bg: color.neutralTint, fg: color.inkSoft },
}
const OUTCOME_ORDER = ['pr', 'ticket', 'memory', 'file', 'image', 'commit']

/** Two views of one session: the transcript spine, or the subagent work. */
function SegmentBar({
  view, workCount, onSelect,
}: {
  view: 'transcript' | 'work'
  workCount: number
  onSelect: (v: 'transcript' | 'work') => void
}) {
  const seg = (v: 'transcript' | 'work', label: string) => {
    const active = view === v
    return (
      <button
        onClick={() => onSelect(v)}
        style={{
          background: active ? color.bgApp : 'transparent',
          color: active ? color.ink : color.inkSoft,
          border: 'none',
          cursor: 'pointer',
          ...typeToken.meta,
          fontWeight: active ? 600 : 400,
          padding: `${space[1]}px ${space[3]}px`,
          borderRadius: radius.sm,
        }}
      >
        {label}
      </button>
    )
  }
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: color.bgFieldStrong,
        borderRadius: radius.md,
        marginBottom: space[5],
      }}
    >
      {seg('transcript', 'Transcript')}
      {seg('work', `Work (${workCount})`)}
    </div>
  )
}

/** The masthead of the spine: grouped outcome chips that expand to a list and
 *  index back into the transcript. Never shown when there are no outcomes. */
function OutcomesRibbon({
  outcomes, openGroup, onToggleGroup, onActivate, onOpenExternal,
}: {
  outcomes: Outcome[]
  openGroup: string | null
  onToggleGroup: (kind: string) => void
  onActivate: (o: Outcome) => void
  onOpenExternal: (o: Outcome) => void
}) {
  const groups = OUTCOME_ORDER
    .map(kind => ({ kind, items: outcomes.filter(o => o.kind === kind) }))
    .filter(g => g.items.length > 0)
  const openItems = groups.find(g => g.kind === openGroup)?.items ?? []

  return (
    <div style={{ marginBottom: space[5], paddingBottom: space[4], borderBottom: `1px solid ${color.hairSoft}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
        {groups.map(g => {
          const meta = OUTCOME_META[g.kind]
          const n = g.items.length
          const open = openGroup === g.kind
          return (
            <button
              key={g.kind}
              onClick={() => onToggleGroup(g.kind)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: space[1],
                background: meta.bg,
                color: meta.fg,
                border: 'none',
                cursor: 'pointer',
                borderRadius: radius.chip,
                padding: `2px ${space[2]}px`,
                ...typeToken.micro,
              }}
            >
              <span>{n} {n === 1 ? meta.singular : meta.plural}</span>
              <span style={{ opacity: 0.55, fontSize: 8 }}>{open ? '▾' : '▸'}</span>
            </button>
          )
        })}
      </div>

      {openItems.length > 0 && (
        <div style={{ marginTop: space[3], display: 'flex', flexDirection: 'column', gap: space[1] }}>
          {openItems.map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
              <button
                onClick={() => onActivate(o)}
                title="Jump to where this happened"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  ...typeToken.meta,
                  color: color.ink,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {o.label}
              </button>
              {o.address.startsWith('http') && (
                <button
                  onClick={() => onOpenExternal(o)}
                  aria-label="Open in browser"
                  title="Open in browser"
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: color.inkFaint, fontSize: 12, flexShrink: 0 }}
                >
                  ↗
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface WorkThreadInfo {
  agentId: string
  label: string
  turns: Turn[]
  spawnedBy: string | null
}

/** The Work segment's thread list — one row per subagent conversation. */
function WorkList({ threads, onOpen }: { threads: WorkThreadInfo[]; onOpen: (agentId: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
      {threads.map(t => (
        <button
          key={t.agentId}
          onClick={() => onOpen(t.agentId)}
          style={{
            textAlign: 'left',
            background: color.bgRaised,
            border: `1px solid ${color.hairSoft}`,
            borderRadius: radius.card,
            padding: `${space[3]}px ${space[4]}px`,
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ ...typeToken.body, color: color.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.label}
          </span>
          <span style={{ ...typeToken.meta, color: color.inkFaint }}>
            {t.turns.length} {t.turns.length === 1 ? 'turn' : 'turns'}
          </span>
        </button>
      ))}
    </div>
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
  /** Bumped when a background reindex lands, so the day counts refetch. */
  dataVersion: number
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function Calendar({ selectedProject, selectedDay, onPickDay, dataVersion }: CalendarProps) {
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
  }, [selectedProject, dataVersion])

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

// ── Virtualized session list ────────────────────────────────────────────────
//
// The list can hold many hundreds of sessions (857 in a single 30-day window is
// routine), and it re-renders on every selection / filter change. Rendering all
// rows synchronously blocks the main thread; the rows are fixed-height (two
// single-line rows, both ellipsis-clamped), so a simple fixed-height window —
// render only the visible slice plus an overscan buffer — keeps it instant at
// any size, with no dependency. (TIN-1768)

/** Fixed row height in px — must match the height baked into `sessionRowStyle`. */
const ROW_HEIGHT = 56

function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  overscan = 8,
}: {
  items: T[]
  rowHeight: number
  renderRow: (item: T, index: number) => React.ReactNode
  overscan?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  // Track the scroller's own height so the window covers exactly the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const total = items.length * rowHeight
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const windowCount = (height > 0 ? Math.ceil(height / rowHeight) : 0) + overscan * 2
  const end = Math.min(items.length, start + windowCount)

  const slice: React.ReactNode[] = []
  for (let i = start; i < end; i++) slice.push(renderRow(items[i], i))

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ flex: 1, overflowY: 'auto', padding: `${space[2]}px ${space[2]}px` }}
    >
      {/* Spacer sized to the full list so the scrollbar reflects the true extent;
          the rendered window is offset into place with a transform. */}
      <div style={{ height: total, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${start * rowHeight}px)`,
          }}
        >
          {slice}
        </div>
      </div>
    </div>
  )
}

/** Skeleton placeholder rows shown while the session list loads, so the view
 *  swaps in immediately instead of blocking on a "Reading…" message. */
function SkeletonList({ rows = 9 }: { rows?: number }) {
  return (
    <div style={{ flex: 1, overflow: 'hidden', padding: `${space[2]}px ${space[2]}px` }} aria-hidden>
      <style>{`@keyframes sess-shimmer { 0% { opacity: 0.55 } 50% { opacity: 1 } 100% { opacity: 0.55 } }`}</style>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height: ROW_HEIGHT, boxSizing: 'border-box', padding: `${space[3]}px ${space[5]}px` }}>
          <div
            style={{
              height: 11,
              width: '38%',
              borderRadius: radius.sm,
              background: color.bgFieldStrong,
              marginBottom: space[2],
              animation: 'sess-shimmer 1.4s ease-in-out infinite',
            }}
          />
          <div
            style={{
              height: 10,
              width: `${70 - (i % 4) * 9}%`,
              borderRadius: radius.sm,
              background: color.bgField,
              animation: 'sess-shimmer 1.4s ease-in-out infinite',
            }}
          />
        </div>
      ))}
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

  // Session detail (TIN-1771): outcomes ribbon + the Transcript/Work segments.
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [readerView, setReaderView] = useState<'transcript' | 'work'>('transcript')
  /** The open Work thread (subagent agentId), or null = the thread list. */
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  /** Which outcome group is expanded in the ribbon (kind), or null = all collapsed. */
  const [openOutcomeGroup, setOpenOutcomeGroup] = useState<string | null>(null)

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

  // Bumped when a background reindex finishes (`transcripts://indexed`), so the
  // cached reads refetch with fresh data without ever blocking the UI. (TIN-1769)
  const [dataVersion, setDataVersion] = useState(0)
  const hasLoadedSessions = useRef(false)

  // Kick a background reindex on mount (the reads below are instant from cache),
  // and refetch when it lands. Indexing never runs inline on a read anymore, so
  // opening Sessions is immediate even with an active multi-MB session file.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    invoke('refresh_transcripts').catch(() => {})
    listen('transcripts://indexed', () => {
      if (!cancelled) setDataVersion(v => v + 1)
    }).then(un => {
      if (cancelled) un()
      else unlisten = un
    })
    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [])

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
  }, [dataVersion])

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
    let cancelled = false
    // Skeleton only on the first load; a background refresh swaps in silently.
    if (!hasLoadedSessions.current) setSessionsLoading(true)
    invoke<SessionSummary[]>('list_sessions', { payload: { project: '' } })
      .then(s => {
        if (cancelled) return
        setSessions(s)
        setSessionsLoading(false)
        hasLoadedSessions.current = true
      })
      .catch(() => { if (!cancelled) setSessionsLoading(false) })
    return () => { cancelled = true }
  }, [noRoot, dataVersion])

  // ── Load turns when a session is selected ──────────────────────────────────

  useEffect(() => {
    if (!selectedSession) return
    setTurnsLoading(true)
    setTurns([])
    setHighlightTurnIdx(null)
    // Reset the detail view to the spine for each newly opened session.
    setReaderView('transcript')
    setActiveAgentId(null)
    setOpenOutcomeGroup(null)
    setOutcomes([])
    const path = selectedSession.path
    invoke<Turn[]>('get_session', { payload: { path } })
      .then(t => {
        setTurns(t)
        setTurnsLoading(false)
      })
      .catch(() => setTurnsLoading(false))
    // Outcomes load independently (and never block the transcript).
    invoke<Outcome[]>('session_outcomes', { payload: { path } })
      .then(o => setOutcomes(o))
      .catch(() => setOutcomes([]))
  }, [selectedSession])

  // The spine is the main thread; subagent (sidechain) turns become Work threads.
  const spineTurns = useMemo(() => turns.filter(t => !t.isSidechain), [turns])

  // Group sidechain turns into Work threads by subagent id, preserving order.
  const workThreads = useMemo(() => {
    const byId = new Map<string, { agentId: string; label: string; turns: Turn[]; spawnedBy: string | null }>()
    for (const t of turns) {
      if (!t.isSidechain || !t.agentId) continue
      let th = byId.get(t.agentId)
      if (!th) {
        th = { agentId: t.agentId, label: t.agentLabel || 'agent', turns: [], spawnedBy: t.spawnedBy ?? null }
        byId.set(t.agentId, th)
      }
      th.turns.push(t)
    }
    return Array.from(byId.values())
  }, [turns])

  // Jump to the spine turn that produced an outcome (or a search hit): switch to
  // the transcript, find the first matching turn, highlight + scroll it.
  const jumpToContent = useCallback((needle: string) => {
    const n = needle.toLowerCase()
    const idx = spineTurns.findIndex(t => t.content.toLowerCase().includes(n))
    if (idx < 0) return
    setReaderView('transcript')
    setActiveAgentId(null)
    setHighlightTurnIdx(idx)
  }, [spineTurns])

  // Clicking an outcome chip jumps to where it happened in the spine — outcomes
  // are an index into the transcript, not a parallel list (TIN-1771). Images
  // jump to the first turn that carries one.
  const activateOutcome = useCallback((o: Outcome) => {
    if (o.kind === 'image') {
      const idx = spineTurns.findIndex(t => t.images && t.images.length > 0)
      setReaderView('transcript')
      setActiveAgentId(null)
      setHighlightTurnIdx(idx >= 0 ? idx : null)
      return
    }
    jumpToContent(o.kind === 'pr' ? o.address : o.label)
  }, [spineTurns, jumpToContent])

  // The secondary affordance: open an addressable artifact (a PR) in the browser.
  const openOutcomeExternal = useCallback((o: Outcome) => {
    if (!o.address.startsWith('http')) return
    import('@tauri-apps/plugin-opener').then(m => m.openUrl(o.address)).catch(() => {})
  }, [])

  // After a search-hit session loads, scroll to + wash the first matching turn.
  useEffect(() => {
    if (!pendingSearchHit || turnsLoading || spineTurns.length === 0) return
    const needle = pendingSearchHit.toLowerCase()
    const idx = spineTurns.findIndex(t => t.content.toLowerCase().includes(needle))
    setHighlightTurnIdx(idx >= 0 ? idx : null)
    setPendingSearchHit(null)
  }, [pendingSearchHit, turnsLoading, spineTurns])

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
      // Fixed height so the list can virtualize (must match ROW_HEIGHT).
      height: ROW_HEIGHT,
      boxSizing: 'border-box',
      overflow: 'hidden',
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

  // One session row — rendered on demand by the virtual list (only the visible
  // window is built), so this stays cheap no matter how long the list gets.
  function renderSessionRow(s: SessionSummary): React.ReactNode {
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
  }

  // The list area: skeleton while loading, a calm empty state, or the
  // virtualized list. Each fills the column (flex:1); the VirtualList owns its
  // own scroller.
  const centeredState = (text: string, faint = false): React.ReactNode => (
    <div style={{ flex: 1, overflowY: 'auto', padding: space[5], ...typeToken.body, color: faint ? color.inkFaint : color.inkSoft, textAlign: 'center' }}>
      {text}
    </div>
  )

  let listArea: React.ReactNode
  if (sessionsLoading || (isSearchActive && searching)) {
    listArea = <SkeletonList />
  } else if (isSearchActive && searchDone && visibleSessions.length === 0) {
    listArea = centeredState('Nothing matched.', true)
  } else if (visibleSessions.length === 0) {
    listArea = centeredState(
      selectedDay ? 'No sessions on this day.' : 'No sessions match your filters.',
      true,
    )
  } else {
    listArea = (
      <VirtualList
        // Remount on a filter change so the new list starts scrolled to the top.
        key={`${selectedProject}|${selectedDay ?? ''}|${isSearchActive ? searchQuery : ''}`}
        items={visibleSessions}
        rowHeight={ROW_HEIGHT}
        renderRow={(s) => renderSessionRow(s)}
      />
    )
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
    const activeThread = workThreads.find(t => t.agentId === activeAgentId) ?? null
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
            marginBottom: space[4],
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

        {/* Segmented control — only when there is Work to switch to (TIN-1771). */}
        {workThreads.length > 0 && (
          <SegmentBar
            view={readerView}
            workCount={workThreads.length}
            onSelect={(v) => {
              setReaderView(v)
              if (v === 'transcript') setActiveAgentId(null)
            }}
          />
        )}

        {readerView === 'transcript' ? (
          <>
            {/* Outcomes ribbon — the masthead of the spine; absent when empty. */}
            {outcomes.length > 0 && (
              <OutcomesRibbon
                outcomes={outcomes}
                openGroup={openOutcomeGroup}
                onToggleGroup={(k) => setOpenOutcomeGroup(g => (g === k ? null : k))}
                onActivate={activateOutcome}
                onOpenExternal={openOutcomeExternal}
              />
            )}
            {/* The spine — main-thread turns only. */}
            {spineTurns.map((turn, i) => (
              <div key={i} style={{ borderBottom: `1px solid ${color.hairSoft}` }}>
                <ConversationTurn turn={turn} highlight={highlightTurnIdx === i} />
              </div>
            ))}
          </>
        ) : activeThread == null ? (
          <WorkList threads={workThreads} onOpen={setActiveAgentId} />
        ) : (
          <div>
            <button
              onClick={() => setActiveAgentId(null)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                ...typeToken.meta, color: color.forest, marginBottom: space[4],
                display: 'flex', alignItems: 'center', gap: space[1],
              }}
            >
              ← All work
            </button>
            <div style={{ ...typeToken.label, color: color.inkSoft, marginBottom: space[4] }}>
              {activeThread.label}
            </div>
            {activeThread.turns.map((turn, i) => (
              <div key={i} style={{ borderBottom: `1px solid ${color.hairSoft}` }}>
                <ConversationTurn turn={turn} highlight={false} />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── List header ────────────────────────────────────────────────────────────

  // Cost/token roll-up across the currently-visible (filtered) sessions, so the
  // header answers "what did this project / day / search cost?", not just a count.
  const rollupUsage = useMemo(
    () => sumUsage(visibleSessions.map(s => s.usage)),
    [visibleSessions],
  )

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
        <span style={{ color: color.inkSoft, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {formatDate(selectedDay)} · {sessionsLabel(visibleSessions.length)}
        </span>
      ) : (
        <span style={{ flexShrink: 0 }}>All sessions · {visibleSessions.length}</span>
      )}

      {/* Right group: cost/token roll-up of the visible set, then the day-clear. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: space[2], flexShrink: 0 }}>
        <SessionMetaLine usage={rollupUsage} compact />
        {selectedDay && (
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
        )}
      </div>
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
              dataVersion={dataVersion}
            />

            {/* (3) List header */}
            {listHeader}

            {/* (4) List — skeleton / empty state / virtualized scroller */}
            {listArea}
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
