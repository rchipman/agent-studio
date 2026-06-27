'use client'

/**
 * DiffView.tsx
 *
 * Fills the "Diff" tab inside WorkspacePanel (TIN-1635).
 *
 * Layout (per studio-surfaces.md §3 "Git diff viewer"):
 *   - Status summary: "N files changed  +adds  -removes"
 *   - File list: status chip (M/A/D) + left-truncated mono path; selected row
 *     gets forest-wash treatment.
 *   - Accordion diff below the list: mono, line backgrounds add/remove washes,
 *     +/- gutters, @@ hunk headers in ink-faint.
 *
 * States: clean | loading | not-a-repo | error | ready
 *
 * House rules enforced here:
 *   - No red. Removals = heather (--remove). Additions = forest (--add).
 *   - No traffic-light dots, no warning glyphs.
 *   - Tokens from lib/tokens.ts only; no magic numbers.
 *   - Read-only, no stage/commit/reset.
 */

import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { color, space, radius, font, type as typeRamp } from '@/lib/tokens'
import Button from '@/components/Button'

// ── Tauri response types ──────────────────────────────────────────────────────

interface GitFile {
  path: string
  /** "M" | "A" | "D" | "?" */
  status: string
}

interface GitStatusResult {
  branch: string
  files: GitFile[]
}

// ── Parsed diff types ─────────────────────────────────────────────────────────

type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk'

interface DiffLine {
  kind: DiffLineKind
  text: string
}

// ── Diff parser ───────────────────────────────────────────────────────────────

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      lines.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.push({ kind: 'add', text: line.slice(1) })
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lines.push({ kind: 'remove', text: line.slice(1) })
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename ')
    ) {
      // skip git meta header lines
    } else {
      // context line: strip leading space if present
      lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  // Trim trailing empty context lines
  while (lines.length > 0 && lines[lines.length - 1].kind === 'context' && lines[lines.length - 1].text === '') {
    lines.pop()
  }
  return lines
}

// ── Status summary helpers ────────────────────────────────────────────────────

function countAddRemove(diffRaw: string): { adds: number; removes: number } {
  let adds = 0
  let removes = 0
  for (const line of diffRaw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) adds++
    else if (line.startsWith('-') && !line.startsWith('---')) removes++
  }
  return { adds, removes }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CalmEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...typeRamp.body, textAlign: 'center', color: color.inkFaint, paddingTop: 60 }}>
      {children}
    </div>
  )
}

function NoticeBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        margin: `${space[4]}px ${space[5]}px`,
        padding: `${space[3]}px ${space[4]}px`,
        background: 'rgba(155,123,90,0.08)',
        borderRadius: radius.md,
        color: color.notice,
        fontSize: 12,
        fontFamily: font.sans,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  )
}

/** Status chip: M=neutral, A=add, D=remove */
function StatusChip({ status }: { status: string }) {
  let bg: string
  let fg: string

  switch (status) {
    case 'A':
      bg = color.addWash
      fg = color.add
      break
    case 'D':
      bg = color.removeWash
      fg = color.remove
      break
    default:
      bg = color.neutralTint
      fg = color.inkSoft
  }

  // Show M for any non-A/D status (includes untracked "?")
  const label = status === 'A' ? 'A' : status === 'D' ? 'D' : 'M'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: radius.sm,
        background: bg,
        color: fg,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: font.sans,
        flexShrink: 0,
        letterSpacing: 0,
      }}
    >
      {label}
    </span>
  )
}

/** Left-truncated mono path: shows as much of the right side as fits. */
function MonoPath({ path }: { path: string }) {
  return (
    <span
      title={path}
      style={{
        ...typeRamp.mono,
        fontSize: 12,
        color: color.inkSoft,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left',
        flex: 1,
        minWidth: 0,
      }}
    >
      {/* rtl + ltr inner span = left-truncate while keeping filename readable */}
      <span style={{ direction: 'ltr', unicodeBidi: 'bidi-override' }}>{path}</span>
    </span>
  )
}

/** A single diff line with gutter. */
function DiffLineRow({ line }: { line: DiffLine }) {
  let bg: string = 'transparent'
  let gutterColor: string = color.inkFaint
  let gutter: string = ' '
  let textColor: string = color.inkSoft

  switch (line.kind) {
    case 'add':
      bg = color.addWash
      gutterColor = color.add
      gutter = '+'
      textColor = color.ink
      break
    case 'remove':
      bg = color.removeWash
      gutterColor = color.remove
      gutter = '−' // minus sign (−), not hyphen
      textColor = color.ink
      break
    case 'hunk':
      bg = 'transparent'
      gutterColor = color.inkFaint
      gutter = ''
      textColor = color.inkFaint
      break
    case 'context':
      break
  }

  if (line.kind === 'hunk') {
    return (
      <div
        style={{
          display: 'flex',
          background: bg,
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      >
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            color: textColor,
            padding: '1px 8px',
            whiteSpace: 'pre',
            flex: 1,
          }}
        >
          {line.text}
        </span>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        background: bg,
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
    >
      {/* Gutter */}
      <span
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: gutterColor,
          width: 20,
          flexShrink: 0,
          textAlign: 'center',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {gutter}
      </span>
      {/* Content */}
      <span
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: textColor,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          flex: 1,
          paddingTop: 1,
          paddingBottom: 1,
          paddingRight: space[3],
        }}
      >
        {line.text || ' '}
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type ViewState = 'loading' | 'clean' | 'not-a-repo' | 'error' | 'ready' | 'no-dir'

interface FileDiff {
  raw: string
  lines: DiffLine[]
  loading: boolean
  error: string | null
}

export interface DiffViewProps {
  workingDir: string
}

export default function DiffView({ workingDir }: DiffViewProps) {
  const [viewState, setViewState] = useState<ViewState>('loading')
  const [branch, setBranch] = useState('')
  const [files, setFiles] = useState<GitFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  // Derived summary counts (recalculated from the current fileDiff)
  const totalAdds = fileDiff ? countAddRemove(fileDiff.raw).adds : 0
  const totalRemoves = fileDiff ? countAddRemove(fileDiff.raw).removes : 0

  // ── Load status ──

  const loadStatus = useCallback(async () => {
    // No configured working directory yet (e.g. no agent set up). Show a calm
    // prompt instead of running git against an empty path and erroring.
    if (!workingDir.trim()) {
      setViewState('no-dir')
      return
    }
    setViewState('loading')
    setSelectedFile(null)
    setFileDiff(null)
    try {
      const result = await invoke<GitStatusResult>('git_status', { dir: workingDir })
      setBranch(result.branch)
      setFiles(result.files)
      setViewState(result.files.length === 0 ? 'clean' : 'ready')
    } catch (err) {
      const msg = String(err)
      if (msg.includes('not-a-repo')) {
        setViewState('not-a-repo')
      } else {
        setErrorMsg(msg)
        setViewState('error')
      }
    }
  }, [workingDir])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // ── Load diff for selected file ──

  const selectFile = useCallback(async (file: GitFile) => {
    setSelectedFile(file.path)
    setFileDiff({ raw: '', lines: [], loading: true, error: null })
    try {
      const raw = await invoke<string>('git_diff', {
        payload: { dir: workingDir, file: file.path },
      })
      const lines = parseDiff(raw)
      setFileDiff({ raw, lines, loading: false, error: null })
    } catch (err) {
      setFileDiff({ raw: '', lines: [], loading: false, error: String(err) })
    }
  }, [workingDir])

  // ── Render ──

  if (viewState === 'loading') {
    return (
      <div style={{ ...typeRamp.body, color: color.inkSoft, textAlign: 'center', paddingTop: 60 }}>
        Reading changes…
      </div>
    )
  }

  if (viewState === 'no-dir') {
    return <CalmEmpty>Set a working directory in Settings to see changes.</CalmEmpty>
  }

  if (viewState === 'not-a-repo') {
    return <NoticeBlock>This folder isn&apos;t a git repository.</NoticeBlock>
  }

  if (viewState === 'error') {
    return (
      <NoticeBlock>
        Could not read git status.{' '}
        <Button variant="tertiary" tone="notice" padding="none" onClick={loadStatus}>
          Refresh
        </Button>
        {errorMsg && (
          <div style={{ marginTop: space[1], fontSize: 11, color: color.inkFaint }}>
            {errorMsg}
          </div>
        )}
      </NoticeBlock>
    )
  }

  if (viewState === 'clean') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <RefreshBar branch={branch} onRefresh={loadStatus} />
        <CalmEmpty>Nothing changed yet.</CalmEmpty>
      </div>
    )
  }

  // ready
  const summaryAddCount = files.filter((f) => f.status === 'A' || f.status === '?').length
  const summaryRemoveCount = files.filter((f) => f.status === 'D').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <RefreshBar branch={branch} onRefresh={loadStatus} />

      {/* Status summary */}
      <div
        style={{
          padding: `${space[3]}px ${space[5]}px`,
          borderBottom: `1px solid ${color.hairSoft}`,
          display: 'flex',
          alignItems: 'center',
          gap: space[3],
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: color.inkSoft, fontFamily: font.sans }}>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        {summaryAddCount > 0 && (
          <span style={{ fontSize: 12, color: color.add, fontFamily: font.mono, fontWeight: 500 }}>
            +{summaryAddCount}
          </span>
        )}
        {summaryRemoveCount > 0 && (
          <span style={{ fontSize: 12, color: color.remove, fontFamily: font.mono, fontWeight: 500 }}>
            −{summaryRemoveCount}
          </span>
        )}
      </div>

      {/* Scrollable body: file list + accordion diff */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* File list */}
        <div style={{ paddingTop: space[2], paddingBottom: space[2] }}>
          {files.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => selectFile(file)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: space[3],
                  width: '100%',
                  textAlign: 'left',
                  background: isSelected ? color.forestWash : 'transparent',
                  // All-longhand borders (no `border` shorthand to reconcile).
                  borderLeft: isSelected ? `2px solid ${color.forest}` : '2px solid transparent',
                  borderRight: 'none',
                  borderTop: 'none',
                  borderBottom: 'none',
                  padding: `${space[2]}px ${space[5]}px`,
                  cursor: 'pointer',
                  minWidth: 0,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = color.bgFieldStrong
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent'
                }}
              >
                <StatusChip status={file.status} />
                <MonoPath path={file.path} />
              </button>
            )
          })}
        </div>

        {/* Accordion diff */}
        {selectedFile && fileDiff && (
          <div
            style={{
              borderTop: `1px solid ${color.hairSoft}`,
              background: color.bgApp,
            }}
          >
            {/* Diff header */}
            <div
              style={{
                padding: `${space[2]}px ${space[5]}px`,
                borderBottom: `1px solid ${color.hairSoft}`,
                display: 'flex',
                alignItems: 'center',
                gap: space[3],
              }}
            >
              <span
                style={{
                  fontFamily: font.mono,
                  fontSize: 11,
                  color: color.inkFaint,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedFile}
              </span>
              {!fileDiff.loading && !fileDiff.error && fileDiff.raw && (
                <span style={{ fontSize: 11, color: color.inkFaint, fontFamily: font.sans, flexShrink: 0 }}>
                  <span style={{ color: color.add }}>+{totalAdds}</span>
                  {' '}
                  <span style={{ color: color.remove }}>−{totalRemoves}</span>
                </span>
              )}
            </div>

            {/* Diff body */}
            {fileDiff.loading ? (
              <div style={{ padding: `${space[4]}px ${space[5]}px`, fontSize: 12, color: color.inkSoft, fontFamily: font.sans }}>
                Reading diff…
              </div>
            ) : fileDiff.error ? (
              <div style={{ padding: `${space[4]}px ${space[5]}px`, fontSize: 12, color: color.notice, fontFamily: font.sans }}>
                Could not read diff.
              </div>
            ) : fileDiff.lines.length === 0 ? (
              <div style={{ padding: `${space[4]}px ${space[5]}px`, fontSize: 12, color: color.inkFaint, fontFamily: font.sans }}>
                No diff available.
              </div>
            ) : (
              <div
                style={{
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                  overflowX: 'auto',
                }}
              >
                {fileDiff.lines.map((line, i) => (
                  <DiffLineRow key={i} line={line} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── RefreshBar ────────────────────────────────────────────────────────────────

function RefreshBar({ branch, onRefresh }: { branch: string; onRefresh: () => void }) {
  return (
    <div
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${space[5]}px`,
        borderBottom: `1px solid ${color.hairSoft}`,
        gap: space[3],
        flexShrink: 0,
      }}
    >
      <span style={{ fontFamily: font.sans, fontSize: 13, fontWeight: 600, color: color.ink }}>
        Changes
      </span>
      {branch && (
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            color: color.inkFaint,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {branch}
        </span>
      )}
      <Button variant="tertiary" size="sm" onClick={onRefresh} style={{ marginLeft: 'auto' }}>
        Refresh
      </Button>
    </div>
  )
}
