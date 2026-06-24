'use client'

/**
 * TranscriptBrowser.tsx
 *
 * Three-pane session transcript browser (TIN-1636).
 * Pane 1: Projects rail (project list + session counts; FTS search switches to
 *          flat result rows).
 * Pane 2: Sessions list (newest first, forest-wash selection).
 * Pane 3: Conversation (human serif + tan rule, assistant serif + forest rule;
 *          tool-use blocks collapsed to "ran <tool>", expandable).
 *
 * Self-contained — the orchestrator wires cmd+T and view routing; this
 * component does not touch app/page.tsx.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { color, space, radius, type as typeToken, font } from '@/lib/tokens'
import MarkdownContent from '@/components/MarkdownContent'
import ViewShell from '@/components/ViewShell'

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
}

interface TranscriptSearchResult {
  project: string
  sessionPath: string
  snippet: string
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
          </div>
        ) : (
          <MarkdownContent content={turn.content} />
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface TranscriptBrowserProps {
  /** When used as an overlay / full view, optional close handler. */
  onClose?: () => void
}

export default function TranscriptBrowser({ onClose }: TranscriptBrowserProps) {
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
              placeholder="Search transcripts…"
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
                  Loading…
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
                  Loading…
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
                Loading…
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
                Loading…
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

  // Full view: the shared shell supplies the back + centered `Transcripts` bar.
  if (onClose) {
    return (
      <ViewShell title="Transcripts" onBack={onClose}>
        {body}
      </ViewShell>
    )
  }

  // Embedded (no close handler): a title-only bar, no back button.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: color.bgApp,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${space[5]}px`,
          borderBottom: `1px solid ${color.hair}`,
          flexShrink: 0,
          background: color.bgApp,
          gap: space[5],
        }}
      >
        <div style={{ flex: 1, textAlign: 'center', ...typeToken.title, color: color.ink }}>
          Transcripts
        </div>
      </div>
      {body}
    </div>
  )
}
