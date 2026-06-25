'use client'

/**
 * AuditView.tsx
 *
 * Surface 3 of the frontmatter manager (TIN-1638), now with local-model
 * frontmatter suggestions + bulk apply (TIN-1758). The Fields view (⌘⇧A): a full
 * view, top bar persists with `← Agent Studio`, centre reads `Frontmatter`.
 *
 * Rows keep today's calm look until a suggestion exists; then the right "what's
 * loose" slot becomes a confidence dot + a one-line band summary, and a chevron
 * expands a thin panel showing each missing field as `current → suggested` with a
 * provenance micro-label and Apply / Edit / Skip. The filter strip carries the
 * headline: `Suggest all` runs the background pass, then a single quiet sentence
 * with a live count + a Settled / Settled + Likely threshold bulk-applies behind
 * one calm confirmation. Unsure is never bulk-selectable.
 *
 * House rules: no red, no alarm glyphs. The "worst" state reads quietest. Tokens
 * only, calm copy, no em-dashes, curly apostrophes, Escape closes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { color, space, radius, shadow, type as type_ } from '@/lib/tokens'
import {
  auditFrontmatter,
  updateFrontmatter,
  suggestAll,
  cancelSuggest,
  onSuggestResult,
  applySuggestion,
  applySuggestionsBulk,
  bandOf,
  type AuditEntry,
  type AuditStatus,
  type Suggestion,
  type ConfidenceResult,
  type FieldConfidence,
  type Band,
  type ApplySuggestionPayload,
} from '@/lib/frontmatter'
import { onAuditProgress } from '@/lib/audit'
import TypeChip from '@/components/TypeChip'
import Button from '@/components/Button'
import FrontmatterForm from '@/components/FrontmatterForm'
import ViewBody from '@/components/ViewBody'
import { useTopBarSlot } from '@/components/TopBarSlot'

// ── Health vocabulary (the calm dot grammar) ─────────────────────────────────

function health(status: AuditStatus): { glyph: string; word: string; dot: string; text: string } {
  switch (status) {
    case 'complete':
      return { glyph: '●', word: 'Described', dot: color.forest, text: color.forest }
    case 'partial':
      return { glyph: '◐', word: 'Needs a little', dot: color.notice, text: color.notice }
    default:
      return { glyph: '○', word: 'Not yet', dot: color.inkFaint, text: color.inkSoft }
  }
}

/** The confidence dot grammar — mirrors the health dots (●◐○) in forest/tan/heather. */
function bandDot(band: Band): { glyph: string; tone: string; word: string } {
  switch (band) {
    case 'settled':
      return { glyph: '●', tone: color.forest, word: 'Settled' }
    case 'likely':
      return { glyph: '◐', tone: color.notice, word: 'Likely' }
    default:
      return { glyph: '○', tone: color.remove, word: 'Unsure' }
  }
}

/** The provenance micro-label for a field, by its source tag. */
function provenance(source: FieldConfidence['source']): string {
  switch (source) {
    case 'path':
      return 'from folder'
    case 'agree':
      return 'folder + rules agree'
    case 'file-date':
      return 'file date'
    case 'model':
      return 'model read the note'
    case 'rules':
      return 'from the note'
    default:
      return 'needs your eye'
  }
}

/** Build the "what's loose" phrase from `missing[]`, joined with `and`. */
function loosePhrase(missing: string[]): string {
  const word = (m: string): string => {
    switch (m) {
      case 'type':
        return 'a type'
      case 'projects':
      case 'project':
        return 'a project'
      case 'created':
        return 'a created date'
      default:
        return `a ${m}`
    }
  }
  const parts = missing.map(word)
  if (parts.length === 0) return ''
  if (parts.length === 1) return `needs ${parts[0]}`
  const last = parts[parts.length - 1]
  return `needs ${parts.slice(0, -1).join(', ')} and ${last}`
}

/** The band summary line shown in the row's right slot once a suggestion exists. */
function bandSummary(result: ConfidenceResult): string {
  const band = bandOf(result.overall)
  if (band === 'unsure') return 'needs a closer look'
  const s = result.suggestion
  const bits: string[] = []
  if (result.fields.type && s.type) bits.push(s.type)
  if (result.fields.projects && s.projects[0]) bits.push('project')
  if (result.fields.created && s.created && !bits.length) bits.push('a date')
  const what = bits.length ? bits.join(', ') : 'the missing fields'
  return `suggests ${what}`
}

const FIELD_LABEL: Record<string, string> = {
  type: 'Type',
  projects: 'Project',
  created: 'Created',
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

type Filter = 'all' | 'partial' | 'missing'
type Threshold = 'settled' | 'likely'

// ── Adapt an AuditEntry to a Suggestion seed for the editor ──────────────────

function auditToSuggestion(e: AuditEntry): Suggestion {
  const stem = e.path.split('/').pop()?.replace(/\.md$/, '') ?? ''
  return {
    name: stem,
    title: stem,
    type: e.type,
    projects: e.projects,
    tags: [],
    created: e.created,
    status: e.docStatus,
  }
}

/** Re-resolve an entry's health from a freshly applied suggestion. */
function entryFromSuggestion(entry: AuditEntry, s: Suggestion): AuditEntry {
  const missing: string[] = []
  if (!s.type) missing.push('type')
  if (!s.projects.length) missing.push('projects')
  if (!s.created) missing.push('created')
  const status: AuditStatus =
    missing.length === 0 ? 'complete' : missing.length >= 3 ? 'missing' : 'partial'
  return {
    path: entry.path,
    status,
    type: s.type,
    projects: s.projects,
    created: s.created,
    docStatus: s.status || 'active',
    missing,
  }
}

// ── The view ─────────────────────────────────────────────────────────────────

export interface AuditViewProps {
  onClose: () => void
  /** Optional: open a file in the workspace. */
  onOpenFile?: (path: string) => void
  knownTypes?: string[]
  knownProjects?: string[]
}

export default function AuditView({ onClose, knownTypes, knownProjects }: AuditViewProps) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  // Suggestions keyed by path, the per-session skip set, and the expanded row.
  const [suggestions, setSuggestions] = useState<Record<string, ConfidenceResult>>({})
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<string | null>(null)

  // Bulk-pass state.
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [threshold, setThreshold] = useState<Threshold>('settled')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [afterBulk, setAfterBulk] = useState<number | null>(null)

  // Editor modal: a queue (one entry, or the Fix-all sequence) + a cursor.
  const [editorQueue, setEditorQueue] = useState<AuditEntry[] | null>(null)
  const [editorSeed, setEditorSeed] = useState<Suggestion | null>(null)
  const [editorIdx, setEditorIdx] = useState(0)

  const load = useCallback(async () => {
    setError(false)
    try {
      const e = await auditFrontmatter()
      setEntries(e)
    } catch (err) {
      console.error('[audit] load', err)
      setError(true)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Escape: close the editor first, then the confirm, then the view.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (editorQueue) setEditorQueue(null)
        else if (confirmOpen) setConfirmOpen(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editorQueue, confirmOpen, onClose])

  const counts = useMemo(() => {
    const c = { complete: 0, partial: 0, missing: 0 }
    for (const e of entries ?? []) c[e.status] += 1
    return c
  }, [entries])

  const unhealthy = useMemo(
    () => (entries ?? []).filter((e) => e.status !== 'complete'),
    [entries],
  )

  const visible = useMemo(() => {
    const list = entries ?? []
    if (filter === 'partial') return list.filter((e) => e.status === 'partial')
    if (filter === 'missing') return list.filter((e) => e.status === 'missing')
    return list
  }, [entries, filter])

  const allHealthy = entries !== null && entries.length > 0 && unhealthy.length === 0

  // The bulk set: every suggested, not-skipped row at or above the threshold.
  // Unsure is never selectable.
  const bulkSet = useMemo(() => {
    const out: ConfidenceResult[] = []
    for (const e of unhealthy) {
      if (skipped.has(e.path)) continue
      const s = suggestions[e.path]
      if (!s) continue
      const band = bandOf(s.overall)
      if (band === 'unsure') continue
      if (threshold === 'settled' && band !== 'settled') continue
      out.push(s)
    }
    return out
  }, [unhealthy, suggestions, skipped, threshold])

  const hasSuggestions = Object.keys(suggestions).length > 0

  function openRow(entry: AuditEntry) {
    setEditorSeed(null)
    setEditorQueue([entry])
    setEditorIdx(0)
  }

  function openFixAll() {
    if (unhealthy.length === 0) return
    setEditorSeed(null)
    setEditorQueue(unhealthy)
    setEditorIdx(0)
  }

  // Update one entry in place after a save, re-resolving its health.
  const refreshEntry = useCallback((path: string, fresh: AuditEntry) => {
    setEntries((prev) => (prev ? prev.map((e) => (e.path === path ? fresh : e)) : prev))
  }, [])

  const dropSuggestion = useCallback((path: string) => {
    setSuggestions((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
  }, [])

  // ── Suggest all (the background pass) ──
  const runSuggestAll = useCallback(async () => {
    setRunning(true)
    setProgress(null)
    setAfterBulk(null)
    setDegraded(false)
    const unlisten = await onAuditProgress((p) => setProgress(p))
    // Stream each suggestion as it lands so rows light up live; the batch result
    // below is a backstop in case an event was dropped.
    const unlistenResult = await onSuggestResult((r) => {
      setSuggestions((prev) => ({ ...prev, [r.path]: r }))
      if (r.degraded) setDegraded(true)
    })
    try {
      // Pass already-computed paths as skip so a stopped pass resumes from where it left off.
      const alreadyDone = Object.keys(suggestions)
      const results = await suggestAll(alreadyDone)
      setSuggestions((prev) => {
        const map = { ...prev }
        for (const r of results) map[r.path] = r
        return map
      })
      if (results.some((r) => r.degraded)) setDegraded(true)
    } catch (err) {
      console.error('[audit] suggestAll', err)
    } finally {
      unlisten()
      unlistenResult()
      setRunning(false)
      setProgress(null)
    }
  }, [suggestions])

  // ── Apply one (the per-row primary) ──
  const applyOne = useCallback(
    async (result: ConfidenceResult, entry: AuditEntry) => {
      const payload: ApplySuggestionPayload = {
        path: result.path,
        suggestion: result.suggestion,
        actorId: result.degraded ? 'rules' : 'model',
      }
      await applySuggestion(payload)
      refreshEntry(entry.path, entryFromSuggestion(entry, result.suggestion))
      dropSuggestion(result.path)
      setExpanded((cur) => (cur === entry.path ? null : cur))
    },
    [refreshEntry, dropSuggestion],
  )

  // ── Apply the bulk set behind the confirmation ──
  const runBulkApply = useCallback(async () => {
    const set = bulkSet
    if (set.length === 0) return
    setConfirmOpen(false)
    setApplying(true)
    setProgress(null)
    const unlisten = await onAuditProgress((p) => setProgress(p))
    const payloads: ApplySuggestionPayload[] = set.map((r) => ({
      path: r.path,
      suggestion: r.suggestion,
      actorId: r.degraded ? 'rules' : 'model',
    }))
    try {
      const applied = await applySuggestionsBulk(payloads)
      // Re-resolve each applied row + drop its suggestion.
      setEntries((prev) => {
        if (!prev) return prev
        const byPath = new Map(set.map((r) => [r.path, r]))
        return prev.map((e) => {
          const r = byPath.get(e.path)
          return r ? entryFromSuggestion(e, r.suggestion) : e
        })
      })
      setSuggestions((prev) => {
        const next = { ...prev }
        for (const r of set) delete next[r.path]
        return next
      })
      setAfterBulk(applied)
    } catch (err) {
      console.error('[audit] bulk apply', err)
    } finally {
      unlisten()
      setApplying(false)
      setProgress(null)
    }
  }, [bulkSet])

  // ── Render ──
  // Register the calm progress readout into the persistent top bar's right slot.
  const { setRight } = useTopBarSlot()
  useEffect(() => {
    let node: React.ReactNode = null
    if (running) {
      node = (
        <div style={{ ...type_.meta, color: color.inkSoft, textAlign: 'right' }}>
          {progress && progress.total > 0
            ? `Reading your notes… ${progress.done} of ${progress.total}.`
            : 'Reading your notes…'}
        </div>
      )
    } else if (applying) {
      node = (
        <div style={{ ...type_.meta, color: color.inkSoft, textAlign: 'right' }}>
          {progress && progress.total > 0
            ? `Filling ${progress.done} of ${progress.total}…`
            : 'Filling the missing fields…'}
        </div>
      )
    } else if (entries && !allHealthy) {
      node = (
        <div style={{ ...type_.meta, color: color.inkSoft, textAlign: 'right' }}>
          {counts.complete} described · {counts.partial} need a little · {counts.missing} not yet.
        </div>
      )
    }
    setRight(node)
    return () => setRight(null)
  }, [setRight, entries, allHealthy, counts, running, applying, progress])

  const busy = running || applying

  return (
    <ViewBody>
      {/* Body */}
      {error ? (
        <div style={{ padding: `${space[8]}px ${space[7]}px`, maxWidth: 680, margin: '0 auto', width: '100%' }}>
          <div style={noticeStyle}>
            Could not read the library just now.
            <Button variant="tertiary" padding="none" onClick={load} style={{ marginLeft: space[3] }}>
              Refresh
            </Button>
          </div>
        </div>
      ) : entries === null ? (
        <CenterLine tone={color.inkSoft}>Reading your library…</CenterLine>
      ) : entries.length === 0 ? (
        <CenterLine tone={color.inkFaint}>No notes yet. Create one with ⌘N and it shows up here.</CenterLine>
      ) : allHealthy ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: space[3] }}>
          <div style={{ ...type_.display, color: color.ink }}>Every note is described.</div>
          <div style={{ ...type_.meta, color: color.inkFaint }}>Your library is tidy. Nothing to do here.</div>
        </div>
      ) : (
        <>
          {/* Filter strip */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: space[2],
              padding: `${space[3]}px ${space[5]}px`,
              background: color.bgField,
              borderBottom: `1px solid ${color.hair}`,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
              <TypeChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
              <TypeChip label="Need a little" active={filter === 'partial'} onClick={() => setFilter('partial')} />
              <TypeChip label="Not yet" active={filter === 'missing'} onClick={() => setFilter('missing')} />
              <div style={{ flex: 1 }} />
              {running ? (
                <Button variant="secondary" size="sm" onClick={() => cancelSuggest()}>
                  Stop
                </Button>
              ) : (
                <Button variant="tertiary" tone="forest" size="sm" onClick={runSuggestAll} disabled={busy}>
                  Suggest all
                </Button>
              )}
              <Button variant="tertiary" tone="forest" size="sm" onClick={openFixAll} disabled={busy}>
                Fix all
              </Button>
            </div>

            {/* The headline: live count + threshold, once suggestions exist. */}
            {hasSuggestions && !busy && (
              <BulkBar
                count={bulkSet.length}
                threshold={threshold}
                onThreshold={setThreshold}
                onApply={() => setConfirmOpen(true)}
              />
            )}

            {/* Calm degrade / after-bulk lines. */}
            {degraded && !busy && (
              <div style={{ ...type_.meta, color: color.inkSoft, lineHeight: 1.5 }}>
                Working from folders and rules just now. The local model isn&rsquo;t running, so notes that
                need a closer read are left for you.
              </div>
            )}
            {afterBulk !== null && !busy && (
              <div style={{ ...type_.meta, color: color.inkSoft }}>
                {afterBulk} filled. A few need your eye.
              </div>
            )}
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ maxWidth: 920, margin: '0 auto', padding: `${space[5]}px ${space[5]}px 80px` }}>
              {visible.length === 0 ? (
                <CenterLine tone={color.inkFaint}>Nothing here needs that. Try another filter.</CenterLine>
              ) : (
                visible.map((e) => (
                  <Row
                    key={e.path}
                    entry={e}
                    suggestion={suggestions[e.path]}
                    expanded={expanded === e.path}
                    onToggle={() => setExpanded((cur) => (cur === e.path ? null : e.path))}
                    onOpen={() => openRow(e)}
                    onApply={(r) => applyOne(r, e)}
                    onEdit={(r) => {
                      setEditorSeed(r.suggestion)
                      setEditorQueue([e])
                      setEditorIdx(0)
                    }}
                    onSkip={() => {
                      setSkipped((prev) => new Set(prev).add(e.path))
                      setExpanded(null)
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Editor modal over the view */}
      {editorQueue && editorQueue[editorIdx] && (
        <EditorModal
          entry={editorQueue[editorIdx]}
          seed={editorSeed}
          stepLabel={editorQueue.length > 1 ? `${editorIdx + 1} of ${editorQueue.length}.` : null}
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onClose={() => {
            setEditorQueue(null)
            setEditorSeed(null)
          }}
          onSaved={(path, fresh) => {
            refreshEntry(path, fresh)
            dropSuggestion(path)
            advance()
          }}
          onSkip={advance}
        />
      )}

      {/* The one calm confirmation (reuses the modal scrim, not a new modal). */}
      {confirmOpen && (
        <ConfirmDialog
          count={bulkSet.length}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={runBulkApply}
        />
      )}
    </ViewBody>
  )

  function advance() {
    setEditorSeed(null)
    setEditorQueue((q) => {
      if (!q) return q
      if (editorIdx + 1 < q.length) {
        setEditorIdx(editorIdx + 1)
        return q
      }
      return null
    })
  }
}

// ── The bulk headline bar ────────────────────────────────────────────────────

function BulkBar({
  count,
  threshold,
  onThreshold,
  onApply,
}: {
  count: number
  threshold: Threshold
  onThreshold: (t: Threshold) => void
  onApply: () => void
}) {
  const phrase = threshold === 'settled' ? 'that are settled' : 'that are settled or likely'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space[3], ...type_.meta, color: color.inkSoft }}>
      <Button variant="tertiary" tone="forest" padding="none" onClick={onApply} disabled={count === 0}>
        Apply {count} {phrase}.
      </Button>
      <select
        value={threshold}
        onChange={(e) => onThreshold(e.target.value as Threshold)}
        aria-label="Confidence threshold"
        style={{
          ...type_.meta,
          color: color.inkSoft,
          background: 'transparent',
          border: `1px solid ${color.line}`,
          borderRadius: radius.md,
          padding: `${space[1]}px ${space[2]}px`,
          fontFamily: type_.meta.fontFamily,
          cursor: 'pointer',
        }}
      >
        <option value="settled">Settled</option>
        <option value="likely">Settled + Likely</option>
      </select>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function CenterLine({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', ...type_.body, color: tone, padding: space[8] }}>
      {children}
    </div>
  )
}

function Row({
  entry,
  suggestion,
  expanded,
  onToggle,
  onOpen,
  onApply,
  onEdit,
  onSkip,
}: {
  entry: AuditEntry
  suggestion?: ConfidenceResult
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
  onApply: (r: ConfidenceResult) => void
  onEdit: (r: ConfidenceResult) => void
  onSkip: () => void
}) {
  const h = health(entry.status)
  const projects = entry.projects.filter(Boolean)
  const loose = entry.status !== 'complete' ? loosePhrase(entry.missing) : ''
  const date = formatDate(entry.created)
  const stem = entry.path.split('/').pop()?.replace(/\.md$/, '') ?? entry.path

  const band = suggestion ? bandOf(suggestion.overall) : null
  const dot = band ? bandDot(band) : null

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[4],
          width: '100%',
          padding: '8px 16px',
          background: 'transparent',
          borderLeft: '2px solid transparent',
          borderRadius: radius.card,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = color.bgFieldStrong)}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        {/* Chevron toggles the panel; only when a suggestion exists. */}
        {suggestion ? (
          <button
            onClick={onToggle}
            aria-label={expanded ? 'Hide suggestion' : 'Show suggestion'}
            aria-expanded={expanded}
            style={{
              width: 16,
              flexShrink: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: color.inkFaint,
              fontSize: 10,
              transition: 'transform 0.12s ease',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </button>
        ) : (
          <span style={{ width: 16, flexShrink: 0 }} />
        )}

        {/* Clicking the body still opens the editor. */}
        <button
          onClick={onOpen}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: space[4],
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {/* Health */}
          <div style={{ width: 150, flexShrink: 0, display: 'flex', alignItems: 'center', gap: space[2] }}>
            <span style={{ fontSize: 8, color: h.dot }}>{h.glyph}</span>
            <span style={{ ...type_.body, color: h.text }}>{h.word}</span>
          </div>

          {/* Name + path */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...type_.body, fontWeight: 600, color: color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {stem}
            </div>
            <div
              style={{
                ...type_.mono,
                fontSize: 11,
                color: color.inkFaint,
                direction: 'rtl',
                textAlign: 'left',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.path}
            </div>
          </div>

          {/* Type + projects */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space[2], flexShrink: 0, flexWrap: 'wrap', maxWidth: 220 }}>
            {entry.type ? (
              <span style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 10, fontWeight: 600 }}>
                {entry.type}
              </span>
            ) : (
              <span style={{ ...type_.meta, color: color.inkFaint, fontStyle: 'italic' }}>no type yet</span>
            )}
            {projects.length ? (
              projects.map((p) => (
                <span key={p} style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 10, fontWeight: 500 }}>
                  {p}
                </span>
              ))
            ) : (
              <span style={{ ...type_.meta, color: color.inkFaint, fontStyle: 'italic' }}>no project yet</span>
            )}
          </div>

          {/* Created */}
          <div style={{ ...type_.meta, color: color.inkFaint, width: 96, textAlign: 'right', flexShrink: 0 }}>
            {date || 'undated'}
          </div>

          {/* What's loose, or the confidence dot + band summary once suggested. */}
          <div style={{ ...type_.meta, width: 200, flexShrink: 0, display: 'flex', alignItems: 'center', gap: space[2] }}>
            {suggestion && dot ? (
              <>
                <span style={{ fontSize: 8, color: dot.tone }}>{dot.glyph}</span>
                <span style={{ color: color.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bandSummary(suggestion)} · <span style={{ color: dot.tone }}>{dot.word}</span>
                </span>
              </>
            ) : (
              <span style={{ color: color.notice }}>{loose}</span>
            )}
          </div>
        </button>
      </div>

      {/* The thin expand panel: current → suggested per missing field + actions. */}
      {suggestion && expanded && (
        <SuggestionPanel
          result={suggestion}
          onApply={() => onApply(suggestion)}
          onEdit={() => onEdit(suggestion)}
          onSkip={onSkip}
        />
      )}
    </div>
  )
}

// ── The expanded suggestion panel ────────────────────────────────────────────

function SuggestionPanel({
  result,
  onApply,
  onEdit,
  onSkip,
}: {
  result: ConfidenceResult
  onApply: () => Promise<void> | void
  onEdit: () => void
  onSkip: () => void
}) {
  const [busy, setBusy] = useState(false)
  const order = ['type', 'projects', 'created'].filter((k) => result.fields[k])

  async function apply() {
    setBusy(true)
    try {
      await onApply()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        // Left inset (space[8]+space[4]+space[2] = 50) aligns the panel under the
        // row's text, past the dot + chevron gutter.
        margin: `0 ${space[5]}px ${space[3]}px ${space[8] + space[4] + space[2]}px`,
        padding: `${space[4]}px ${space[5]}px`,
        background: color.bgCard,
        border: `1px solid ${color.hairSoft}`,
        borderRadius: radius.card,
        display: 'flex',
        flexDirection: 'column',
        gap: space[4],
      }}
    >
      {order.map((key) => {
        const fc = result.fields[key]
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: space[4] }}>
            <div style={{ ...type_.micro, color: color.inkSoft, width: 64, flexShrink: 0 }}>
              {FIELD_LABEL[key] ?? key}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: space[3], flex: 1, minWidth: 0 }}>
              <CurrentValue field={key} />
              <span style={{ ...type_.meta, color: color.inkFaint }}>→</span>
              <SuggestedChip field={key} fc={fc} suggestion={result.suggestion} />
              <span style={{ ...type_.micro, color: color.inkFaint }}>{provenance(fc.source)}</span>
            </div>
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end' }}>
        <Button variant="tertiary" size="sm" onClick={onSkip} disabled={busy}>
          Skip
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          Edit
        </Button>
        <Button variant="primary" size="sm" onClick={apply} disabled={busy}>
          {busy ? 'Applying…' : 'Apply'}
        </Button>
      </div>
    </div>
  )
}

/** The `current` value: the existing faint-italic "no type yet" treatment. */
function CurrentValue({ field }: { field: string }) {
  const noun = field === 'type' ? 'type' : field === 'projects' ? 'project' : 'date'
  return (
    <span style={{ ...type_.meta, color: color.inkFaint, fontStyle: 'italic', flexShrink: 0 }}>
      no {noun} yet
    </span>
  )
}

/** The suggested value, reusing the EXACT chip treatments from the row. */
function SuggestedChip({ field, fc, suggestion }: { field: string; fc: FieldConfidence; suggestion: Suggestion }) {
  if (field === 'type') {
    return (
      <span style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.forestTint, color: color.forest, fontSize: 10, fontWeight: 600 }}>
        {fc.value || suggestion.type}
      </span>
    )
  }
  if (field === 'projects') {
    return (
      <span style={{ padding: '1px 7px', borderRadius: radius.chip, background: color.tanTint, color: color.tan, fontSize: 10, fontWeight: 500 }}>
        {fc.value || suggestion.projects[0]}
      </span>
    )
  }
  return <span style={{ ...type_.meta, color: color.inkSoft }}>{formatDate(fc.value || suggestion.created)}</span>
}

// ── The calm bulk confirmation (reuses the modal scrim/dialog) ───────────────

function ConfirmDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div style={scrimStyle} onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apply settled frontmatter"
        style={{
          width: 460,
          maxWidth: '100%',
          background: color.bgRaised,
          borderRadius: radius.lg,
          boxShadow: shadow.modal,
          display: 'flex',
          flexDirection: 'column',
          padding: space[7],
          gap: space[5],
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...type_.title, color: color.ink }}>
          Apply settled frontmatter to {count} notes?
        </div>
        <div style={{ ...type_.body, color: color.inkSoft, lineHeight: 1.55 }}>
          Each note keeps its body. Only the missing fields are filled: type, project, and date. The
          change is recorded in each note&rsquo;s history, so you can see exactly what was set.
        </div>
        <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onCancel}>
            Not now
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Apply to {count}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Editor modal over the view ───────────────────────────────────────────────

function EditorModal({
  entry,
  seed,
  stepLabel,
  knownTypes,
  knownProjects,
  onClose,
  onSaved,
  onSkip,
}: {
  entry: AuditEntry
  /** When set, seed the form from the suggestion (the per-row Edit path). */
  seed: Suggestion | null
  stepLabel: string | null
  knownTypes?: string[]
  knownProjects?: string[]
  onClose: () => void
  onSaved: (path: string, fresh: AuditEntry) => void
  onSkip: () => void
}) {
  const [fm, setFm] = useState<Suggestion>(() => seed ?? auditToSuggestion(entry))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // Re-seed when the entry (Fix-all advance) or the suggestion seed changes.
  useEffect(() => {
    setFm(seed ?? auditToSuggestion(entry))
    setSaveError(false)
  }, [entry, seed])

  function statusToAudit(s: Suggestion): AuditEntry {
    const missing: string[] = []
    if (!s.type) missing.push('type')
    if (!s.projects.length) missing.push('projects')
    if (!s.created) missing.push('created')
    const status: AuditStatus =
      missing.length === 0 ? 'complete' : missing.length >= 3 ? 'missing' : 'partial'
    return {
      path: entry.path,
      status,
      type: s.type,
      projects: s.projects,
      created: s.created,
      docStatus: s.status,
      missing,
    }
  }

  async function save() {
    setSaving(true)
    setSaveError(false)
    try {
      await updateFrontmatter(entry.path, fm)
      onSaved(entry.path, statusToAudit(fm))
    } catch (err) {
      console.error('[audit] save', err)
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  const stepping = stepLabel !== null

  return (
    <div style={scrimStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit frontmatter"
        style={{
          width: 480,
          maxWidth: '100%',
          background: color.bgRaised,
          borderRadius: radius.lg,
          boxShadow: shadow.modal,
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: `${space[7]}px ${space[7]}px ${space[5]}px`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ ...type_.title, color: color.ink }}>Frontmatter</div>
          {stepLabel && <div style={{ ...type_.meta, color: color.inkFaint }}>{stepLabel}</div>}
        </div>

        <div style={{ padding: `0 ${space[7]}px`, overflowY: 'auto' }}>
          <FrontmatterForm
            value={fm}
            onChange={setFm}
            knownTypes={knownTypes}
            knownProjects={knownProjects}
          />
        </div>

        <div style={{ padding: `${space[5]}px ${space[7]}px ${space[7]}px` }}>
          {saveError && (
            <div style={{ ...noticeStyle, marginBottom: space[4] }}>
              Could not save. Your work is still here.
            </div>
          )}
          <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end' }}>
            {stepping ? (
              <>
                <Button variant="tertiary" onClick={onSkip}>
                  Skip
                </Button>
                <Button variant="primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save and next →'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const scrimStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2200,
  background: color.scrim,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: `${space[8]}px ${space[5]}px`,
  overflowY: 'auto',
}

const noticeStyle: React.CSSProperties = {
  ...type_.body,
  color: color.notice,
  background: color.tanTint,
  borderRadius: radius.md,
  padding: `${space[3]}px ${space[4]}px`,
}
