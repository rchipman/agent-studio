'use client'

/**
 * AuditView.tsx
 *
 * Surface 3 of the frontmatter manager (TIN-1638): the audit view (⌘⇧A). A full
 * view, same family as the transcript browser — replaces the main content column,
 * top bar persists with `← Agent Studio`, centre reads `Frontmatter`.
 *
 * The library's calm self-portrait: a summary that leads with the good count, three
 * filter chips, and rows with the `●◐○` health dot + plain missing-field language.
 * Click a row → open the FrontmatterForm editor as a modal over the view; on save
 * call `updateFrontmatter` and re-resolve that row live. `Fix all` steps through the
 * unhealthy files (`Save and next →` / `Skip`, `2 of 8`).
 *
 * House rules: no red, no alarm glyphs. The "worst" state (missing) reads quietest;
 * `partial` carries the one warm tan accent. Tokens only, calm copy, no em-dashes,
 * curly apostrophes, Escape closes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { color, space, radius, font, shadow, type as type_ } from '@/lib/tokens'
import {
  auditFrontmatter,
  updateFrontmatter,
  type AuditEntry,
  type AuditStatus,
  type Suggestion,
} from '@/lib/frontmatter'
import TypeChip from '@/components/TypeChip'
import FrontmatterForm from '@/components/FrontmatterForm'

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

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

type Filter = 'all' | 'partial' | 'missing'

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

  // Editor modal: a queue (one entry, or the Fix-all sequence) + a cursor.
  const [editorQueue, setEditorQueue] = useState<AuditEntry[] | null>(null)
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

  // Escape: close the editor first, else the view.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (editorQueue) setEditorQueue(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editorQueue, onClose])

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

  function openRow(entry: AuditEntry) {
    setEditorQueue([entry])
    setEditorIdx(0)
  }

  function openFixAll() {
    if (unhealthy.length === 0) return
    setEditorQueue(unhealthy)
    setEditorIdx(0)
  }

  // Update one entry in place after a save, re-resolving its health.
  const refreshEntry = useCallback((path: string, fresh: AuditEntry) => {
    setEntries((prev) => (prev ? prev.map((e) => (e.path === path ? fresh : e)) : prev))
  }, [])

  // ── Render ──
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
      {/* Top bar */}
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
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            padding: `${space[2]}px ${space[3]}px`,
            cursor: 'pointer',
            ...type_.body,
            color: color.inkSoft,
            borderRadius: radius.md,
            display: 'flex',
            alignItems: 'center',
            gap: space[2],
          }}
        >
          <span style={{ fontSize: 14 }}>←</span>
          <span>Agent Studio</span>
        </button>
        <div style={{ flex: 1, textAlign: 'center', ...type_.title, color: color.ink }}>
          Frontmatter
        </div>
        <div style={{ ...type_.meta, color: color.inkSoft, width: 240, textAlign: 'right' }}>
          {entries && !allHealthy && (
            <>
              {counts.complete} described · {counts.partial} need a little · {counts.missing} not yet.
            </>
          )}
        </div>
      </div>

      {/* Body */}
      {error ? (
        <div style={{ padding: `${space[8]}px ${space[7]}px`, maxWidth: 680, margin: '0 auto', width: '100%' }}>
          <div style={noticeStyle}>
            Could not read the library just now.
            <button
              onClick={load}
              style={{ ...type_.body, background: 'none', border: 'none', color: color.inkSoft, cursor: 'pointer', marginLeft: space[3], padding: 0 }}
              onMouseEnter={(e) => (e.currentTarget.style.color = color.ink)}
              onMouseLeave={(e) => (e.currentTarget.style.color = color.inkSoft)}
            >
              Refresh
            </button>
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
              alignItems: 'center',
              gap: space[2],
              padding: `${space[3]}px ${space[5]}px`,
              background: color.bgField,
              borderBottom: `1px solid ${color.hair}`,
              flexShrink: 0,
            }}
          >
            <TypeChip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
            <TypeChip label="Need a little" active={filter === 'partial'} onClick={() => setFilter('partial')} />
            <TypeChip label="Not yet" active={filter === 'missing'} onClick={() => setFilter('missing')} />
            <div style={{ flex: 1 }} />
            <button
              onClick={openFixAll}
              style={{ ...type_.body, fontWeight: 600, background: 'none', border: 'none', color: color.forest, cursor: 'pointer', padding: `${space[1]}px ${space[2]}px` }}
            >
              Fix all
            </button>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ maxWidth: 920, margin: '0 auto', padding: `${space[5]}px ${space[5]}px 80px` }}>
              {visible.length === 0 ? (
                <CenterLine tone={color.inkFaint}>Nothing here needs that. Try another filter.</CenterLine>
              ) : (
                visible.map((e) => <Row key={e.path} entry={e} onClick={() => openRow(e)} />)
              )}
            </div>
          </div>
        </>
      )}

      {/* Editor modal over the view */}
      {editorQueue && editorQueue[editorIdx] && (
        <EditorModal
          entry={editorQueue[editorIdx]}
          stepLabel={editorQueue.length > 1 ? `${editorIdx + 1} of ${editorQueue.length}.` : null}
          knownTypes={knownTypes}
          knownProjects={knownProjects}
          onClose={() => setEditorQueue(null)}
          onSaved={(path, fresh) => {
            refreshEntry(path, fresh)
            advance()
          }}
          onSkip={advance}
        />
      )}
    </div>
  )

  function advance() {
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

// ── Sub-components ─────────────────────────────────────────────────────────────

function CenterLine({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', ...type_.body, color: tone, padding: space[8] }}>
      {children}
    </div>
  )
}

function Row({ entry, onClick }: { entry: AuditEntry; onClick: () => void }) {
  const h = health(entry.status)
  const projects = entry.projects.filter(Boolean)
  const loose = entry.status !== 'complete' ? loosePhrase(entry.missing) : ''
  const date = formatDate(entry.created)
  const stem = entry.path.split('/').pop()?.replace(/\.md$/, '') ?? entry.path
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: space[4],
        width: '100%',
        textAlign: 'left',
        padding: '8px 16px',
        background: 'transparent',
        border: 'none',
        borderLeft: '2px solid transparent',
        borderRadius: radius.card,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = color.bgFieldStrong)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
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

      {/* What's loose */}
      <div style={{ ...type_.meta, color: color.notice, width: 180, flexShrink: 0 }}>
        {loose}
      </div>
    </button>
  )
}

// ── Editor modal over the view ───────────────────────────────────────────────

function EditorModal({
  entry,
  stepLabel,
  knownTypes,
  knownProjects,
  onClose,
  onSaved,
  onSkip,
}: {
  entry: AuditEntry
  stepLabel: string | null
  knownTypes?: string[]
  knownProjects?: string[]
  onClose: () => void
  onSaved: (path: string, fresh: AuditEntry) => void
  onSkip: () => void
}) {
  const [fm, setFm] = useState<Suggestion>(() => auditToSuggestion(entry))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // Re-seed from the entry when it changes (Fix-all advance).
  useEffect(() => {
    setFm(auditToSuggestion(entry))
    setSaveError(false)
  }, [entry])

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
                <button style={secondaryBtnStyle} onClick={onSkip} {...secHover}>
                  Skip
                </button>
                <button style={primaryBtnStyle} onClick={save} disabled={saving} {...priHover}>
                  {saving ? 'Saving…' : 'Save and next →'}
                </button>
              </>
            ) : (
              <>
                <button style={secondaryBtnStyle} onClick={onClose} {...secHover}>
                  Cancel
                </button>
                <button style={primaryBtnStyle} onClick={save} disabled={saving} {...priHover}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
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

const primaryBtnStyle: React.CSSProperties = {
  background: color.forest,
  color: '#fff',
  border: 'none',
  borderRadius: radius.md,
  padding: `7px ${space[5]}px`,
  fontSize: 13,
  fontWeight: 600,
  fontFamily: font.sans,
  cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: color.inkSoft,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  padding: `7px ${space[5]}px`,
  fontSize: 13,
  fontFamily: font.sans,
  cursor: 'pointer',
}

const priHover = {
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.opacity = '0.92'),
  onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.opacity = '1'),
}

const secHover = {
  onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) =>
    (e.currentTarget.style.background = color.bgFieldStrong),
  onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) =>
    (e.currentTarget.style.background = 'transparent'),
}
