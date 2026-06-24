'use client'

/**
 * ImportModal.tsx
 *
 * Surface 2 of the frontmatter manager (TIN-1638): bring existing `.md` files into
 * memory. The parent handles drag-drop + ⌘O picking and hands already-read files in.
 *
 * Single file  → the modal IS one FrontmatterForm editor (Cancel / Import).
 * Multiple files → a 200-wide queue rail (○ Pending / ◐ Reviewed / ● Imported) +
 *                  the editor on the right (Import this one step-through / Import all N).
 *
 * For each file: if it already has a `---` frontmatter block we parse it for review
 * ("From this file's frontmatter."); otherwise we call `suggestFrontmatter` on the
 * body ("Described from the note."). Each import calls `importMarkdown`; partial
 * success is honest (committed files stay; per-file errors keep their row).
 *
 * House rules: tokens only, no red, no alarm glyphs, calm copy, no em-dashes,
 * curly apostrophes, role="dialog"/aria-modal, Escape closes.
 */

import { useCallback, useEffect, useState } from 'react'
import { color, space, radius, font, shadow, type as type_ } from '@/lib/tokens'
import Button from '@/components/Button'
import {
  suggestFrontmatter,
  importMarkdown,
  type Suggestion,
} from '@/lib/frontmatter'
import FrontmatterForm from '@/components/FrontmatterForm'

export interface ImportFile {
  path: string
  content: string
}

export interface ImportModalProps {
  files: ImportFile[]
  onClose: () => void
  onImported: (paths: string[]) => void
  knownTypes?: string[]
  knownProjects?: string[]
}

type RowStatus = 'pending' | 'reviewed' | 'imported'

interface FileState {
  path: string
  body: string // content with any leading frontmatter block stripped
  fm: Suggestion
  sourceLabel: string
  status: RowStatus
  error: string | null
  duplicate: boolean
}

// ── Minimal client-side frontmatter parse (the "From this file's" path) ──────

const EMPTY_SUGGESTION: Suggestion = {
  name: '',
  title: '',
  type: '',
  projects: [],
  tags: [],
  created: '',
  status: '',
}

/** If `content` opens with a `---` block, parse a tiny YAML subset and return
 *  { fm, body }; otherwise return null. Intentionally minimal. */
function parseFrontmatter(content: string): { fm: Suggestion; body: string } | null {
  if (!content.startsWith('---')) return null
  const rest = content.slice(3).replace(/^\r?\n/, '')
  const end = rest.search(/\r?\n---\s*(\r?\n|$)/)
  if (end === -1) return null
  const block = rest.slice(0, end)
  const body = rest.slice(end).replace(/^\r?\n---\s*\r?\n?/, '')

  const fm: Suggestion = { ...EMPTY_SUGGESTION }
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    let val = line.slice(colon + 1).trim()
    // Strip surrounding quotes.
    val = val.replace(/^["']|["']$/g, '')

    const asList = (v: string): string[] => {
      const inner = v.replace(/^\[|\]$/g, '').trim()
      if (!inner) return []
      return inner
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }

    switch (key) {
      case 'name':
        fm.name = val
        break
      case 'title':
        fm.title = val
        break
      case 'type':
        fm.type = val
        break
      case 'projects':
      case 'project':
        fm.projects = asList(val)
        break
      case 'tags':
        fm.tags = asList(val)
        break
      case 'created':
        fm.created = val
        break
      case 'status':
        fm.status = val
        break
    }
  }
  return { fm, body }
}

function fileLeaf(path: string): string {
  return path.split('/').pop() ?? path
}

// ── Queue rail status dot ─────────────────────────────────────────────────────

function statusDisplay(status: RowStatus): { glyph: string; word: string; tone: string } {
  switch (status) {
    case 'imported':
      return { glyph: '●', word: 'Imported', tone: color.forest }
    case 'reviewed':
      return { glyph: '◐', word: 'Reviewed', tone: color.notice }
    default:
      return { glyph: '○', word: 'Pending', tone: color.inkFaint }
  }
}

// ── The modal ─────────────────────────────────────────────────────────────────

export default function ImportModal({
  files,
  onClose,
  onImported,
  knownTypes,
  knownProjects,
}: ImportModalProps) {
  const [rows, setRows] = useState<FileState[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<null | { kind: 'one' } | { kind: 'all'; done: number; total: number }>(
    null,
  )

  const single = files.length === 1

  // ── Seed each file (parse existing frontmatter or suggest) on mount ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const seeded: FileState[] = await Promise.all(
        files.map(async (f) => {
          const parsed = parseFrontmatter(f.content)
          if (parsed) {
            const fm = { ...parsed.fm }
            if (!fm.name) fm.name = fileLeaf(f.path).replace(/\.md$/, '')
            return {
              path: f.path,
              body: parsed.body,
              fm,
              sourceLabel: "From this file’s frontmatter.",
              status: 'pending' as RowStatus,
              error: null,
              duplicate: false,
            }
          }
          let fm: Suggestion = { ...EMPTY_SUGGESTION }
          try {
            fm = await suggestFrontmatter(f.content)
          } catch (err) {
            console.error('[import] suggest', err)
          }
          if (!fm.name) fm.name = fileLeaf(f.path).replace(/\.md$/, '')
          return {
            path: f.path,
            body: f.content,
            fm,
            sourceLabel: 'Described from the note.',
            status: 'pending' as RowStatus,
            error: null,
            duplicate: false,
          }
        }),
      )
      if (!cancelled) {
        setRows(seeded)
        setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [files])

  // ── Esc to dismiss ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const setRowFm = useCallback((idx: number, fm: Suggestion) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? { ...r, fm, status: r.status === 'imported' ? r.status : 'reviewed', duplicate: false }
          : r,
      ),
    )
  }, [])

  // ── Import one file; returns the written path or null on failure ──
  const importOne = useCallback(
    async (idx: number): Promise<string | null> => {
      const row = rows[idx]
      if (!row || row.status === 'imported') return row?.path ?? null
      try {
        const written = await importMarkdown(row.body, row.fm)
        setRows((prev) =>
          prev.map((r, i) => (i === idx ? { ...r, status: 'imported', error: null, duplicate: false } : r)),
        )
        return written
      } catch (err) {
        const msg = String(err)
        const duplicate = /exist|already/i.test(msg)
        setRows((prev) =>
          prev.map((r, i) =>
            i === idx
              ? {
                  ...r,
                  error: 'Could not import this one. Still here to retry.',
                  duplicate,
                }
              : r,
          ),
        )
        return null
      }
    },
    [rows],
  )

  function nextPending(from: number): number | null {
    for (let i = from + 1; i < rows.length; i++) {
      if (rows[i].status !== 'imported') return i
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].status !== 'imported') return i
    }
    return null
  }

  const allImported = rows.length > 0 && rows.every((r) => r.status === 'imported')
  const pendingCount = rows.filter((r) => r.status !== 'imported').length
  const importedCount = rows.length - pendingCount

  async function handleImportThisOne() {
    if (allImported) {
      // The button has become "Done".
      finish()
      return
    }
    setBusy({ kind: 'one' })
    const written = await importOne(activeIdx)
    setBusy(null)
    if (written) {
      const next = nextPending(activeIdx)
      if (next !== null) setActiveIdx(next)
    }
  }

  async function handleImportAll() {
    const indices = rows
      .map((r, i) => (r.status !== 'imported' ? i : -1))
      .filter((i) => i >= 0)
    let done = 0
    const total = indices.length
    setBusy({ kind: 'all', done, total })
    for (const i of indices) {
      setActiveIdx(i)
      await importOne(i)
      done += 1
      setBusy({ kind: 'all', done, total })
    }
    setBusy(null)
    finish()
  }

  function finish() {
    const importedPaths = rows.filter((r) => r.status === 'imported').map((r) => r.path)
    onImported(importedPaths)
  }

  const active = rows[activeIdx]

  // ── Footer ──
  function renderFooter() {
    if (single) {
      return (
        <div style={{ display: 'flex', gap: space[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleImportThisOne} disabled={!!busy}>
            {busy ? 'Importing…' : allImported ? 'Done' : 'Import'}
          </Button>
        </div>
      )
    }
    const allLabel =
      busy?.kind === 'all'
        ? `Importing ${busy.done} of ${busy.total}…`
        : `Import all ${pendingCount}`
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: space[3] }}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <div style={{ flex: 1 }} />
        {!allImported && pendingCount > 0 && (
          <Button variant="primary" onClick={handleImportAll} disabled={!!busy}>
            {allLabel}
          </Button>
        )}
        <Button variant="primary" onClick={handleImportThisOne} disabled={!!busy}>
          {busy?.kind === 'one'
            ? 'Importing…'
            : allImported
              ? 'Done'
              : 'Import this one'}
        </Button>
      </div>
    )
  }

  return (
    <div style={scrimStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import notes"
        style={{
          width: 560,
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
        {/* Title */}
        <div style={{ padding: `${space[7]}px ${space[7]}px ${space[5]}px` }}>
          <div style={{ ...type_.title, color: color.ink }}>Import notes</div>
        </div>

        {!ready ? (
          <div style={{ ...type_.body, color: color.inkSoft, textAlign: 'center', padding: space[8] }}>
            Reading…
          </div>
        ) : single ? (
          <div style={{ padding: `0 ${space[7]}px`, overflowY: 'auto' }}>
            {active && <Editor row={active} idx={activeIdx} onFm={setRowFm} knownTypes={knownTypes} knownProjects={knownProjects} />}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 0, overflow: 'hidden', borderTop: `1px solid ${color.hair}` }}>
            {/* Queue rail */}
            <div
              style={{
                width: 200,
                flexShrink: 0,
                borderRight: `1px solid ${color.hair}`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <div style={{ flex: 1, overflowY: 'auto', padding: `${space[3]}px 0` }}>
                {rows.map((r, i) => {
                  const sd = statusDisplay(r.status)
                  const isActive = i === activeIdx
                  return (
                    <button
                      key={r.path}
                      onClick={() => setActiveIdx(i)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 16px',
                        background: isActive ? color.forestWash : 'transparent',
                        borderLeft: isActive ? `2px solid ${color.forest}` : '2px solid transparent',
                        border: 'none',
                        borderLeftWidth: 2,
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.background = color.bgFieldStrong
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <div
                        style={{
                          ...type_.body,
                          fontFamily: font.mono,
                          color: color.ink,
                          direction: 'rtl',
                          textAlign: 'left',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {fileLeaf(r.path)}
                      </div>
                      <div style={{ ...type_.meta, color: sd.tone, marginTop: 2 }}>
                        <span style={{ fontSize: 8, marginRight: space[1] }}>{sd.glyph}</span>
                        {sd.word}
                      </div>
                    </button>
                  )
                })}
              </div>
              <div
                style={{
                  ...type_.meta,
                  color: color.inkFaint,
                  padding: `${space[3]}px ${space[4]}px`,
                  borderTop: `1px solid ${color.hair}`,
                }}
              >
                {importedCount} of {rows.length} imported.
              </div>
            </div>

            {/* Per-file editor */}
            <div style={{ flex: 1, overflowY: 'auto', padding: `${space[5]}px ${space[7]}px` }}>
              {active && <Editor row={active} idx={activeIdx} onFm={setRowFm} knownTypes={knownTypes} knownProjects={knownProjects} />}
            </div>
          </div>
        )}

        {/* Footer */}
        {ready && (
          <div style={{ padding: `${space[5]}px ${space[7]}px ${space[7]}px`, borderTop: `1px solid ${color.hair}` }}>
            {renderFooter()}
          </div>
        )}
      </div>
    </div>
  )
}

// ── The per-file editor (path + form + per-file notices) ─────────────────────

function Editor({
  row,
  idx,
  onFm,
  knownTypes,
  knownProjects,
}: {
  row: FileState
  idx: number
  onFm: (idx: number, fm: Suggestion) => void
  knownTypes?: string[]
  knownProjects?: string[]
}) {
  return (
    <div>
      {/* Source path, truncated from the left */}
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
          marginBottom: space[4],
        }}
      >
        {row.path}
      </div>

      {row.duplicate && (
        <div style={noticeStyle}>
          A note already lives at this path. Change the name or project to keep both.
        </div>
      )}
      {row.error && !row.duplicate && <div style={noticeStyle}>{row.error}</div>}

      <FrontmatterForm
        value={row.fm}
        onChange={(fm) => onFm(idx, fm)}
        knownTypes={knownTypes}
        knownProjects={knownProjects}
        sourceLabel={row.sourceLabel}
      />
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const scrimStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2100,
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
  marginBottom: space[4],
}

