'use client'

/**
 * ConsistencyView.tsx
 *
 * Consistency Audit full view (TIN-1695). A full view in the same family as
 * GraphView and AuditView: top bar with `← Agent Studio` and centred
 * `Consistency` title, a single centered reading column (maxWidth: 680),
 * Escape closes.
 *
 * State machine: idle → running → findings | all-clear | no-model | error.
 *
 * A finding is an invitation to look, never an accusation. No severity, no
 * dismiss/resolve, no red, no ⚠. Tokens only, calm copy, curly apostrophes,
 * no em-dashes.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { color, space, radius, font, type as typeToken } from '@/lib/tokens'
import Button from '@/components/Button'
import { consistencyAudit, onAuditProgress, type Finding } from '@/lib/audit'
import ViewShell from '@/components/ViewShell'

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewState = 'idle' | 'running' | 'findings' | 'all-clear' | 'no-model' | 'error'

export interface ConsistencyViewProps {
  /** plain click = this panel; ⌘-click = other panel */
  onOpenFile: (path: string, e: React.MouseEvent) => void
  onClose: () => void
}

// ── Reading column wrapper ─────────────────────────────────────────────────────

function Column({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div
        style={{
          maxWidth: 680,
          width: '100%',
          margin: '0 auto',
          padding: `${space[8]}px ${space[7]}px 80px`,
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ── Notice block (no-model / error) ───────────────────────────────────────────

function NoticeBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...typeToken.body,
        color: color.notice,
        background: color.tanTint,
        borderRadius: radius.md,
        padding: `${space[3]}px ${space[4]}px`,
      }}
    >
      {children}
    </div>
  )
}

// ── Primary "Run audit" button ─────────────────────────────────────────────────

function RunButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="primary" onClick={onClick}>
      Run audit
    </Button>
  )
}

// ── Ghost "Run again" text button ─────────────────────────────────────────────

function RunAgainButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="tertiary" padding="none" onClick={onClick}>
      Run again
    </Button>
  )
}

// ── Finding row ───────────────────────────────────────────────────────────────

function FindingRow({
  finding,
  onOpenFile,
}: {
  finding: Finding
  onOpenFile: (path: string, e: React.MouseEvent) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      style={{
        padding: '12px 16px',
        background: hovered ? color.bgFieldStrong : color.bgCard,
        border: `1px solid ${hovered ? color.line : color.hairSoft}`,
        borderRadius: radius.card,
        marginBottom: space[2],
        transition: 'all 0.1s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Summary — serif hero */}
      <div
        style={{
          fontFamily: font.serif,
          fontSize: 13,
          fontWeight: 400,
          color: color.ink,
          lineHeight: 1.5,
        }}
      >
        {finding.summary}
      </div>

      {/* Note pills */}
      <div
        style={{
          marginTop: space[3],
          display: 'flex',
          flexWrap: 'wrap',
          gap: space[2],
        }}
      >
        {finding.names.map((name, i) => (
          <NotePill
            key={finding.files[i]}
            name={name}
            filePath={finding.files[i]}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </div>
  )
}

// ── Note pill ─────────────────────────────────────────────────────────────────

function NotePill({
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function ConsistencyView({ onOpenFile, onClose }: ConsistencyViewProps) {
  const [viewState, setViewState] = useState<ViewState>('idle')
  const [findings, setFindings] = useState<Finding[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Keep findings from a prior run visible during an error state.
  const [priorFindings, setPriorFindings] = useState<Finding[] | null>(null)

  // Track the unlisten fn so we can clean it up.
  const unlistenRef = useRef<(() => void) | null>(null)

  // Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Cleanup progress subscription on unmount.
  useEffect(() => {
    return () => {
      unlistenRef.current?.()
    }
  }, [])

  const runAudit = useCallback(async () => {
    // Unsubscribe any previous listener.
    unlistenRef.current?.()
    unlistenRef.current = null

    setViewState('running')
    setProgress(null)

    // Subscribe to progress before calling audit so we never miss events.
    const unlisten = await onAuditProgress((p) => {
      setProgress(p)
    })
    unlistenRef.current = unlisten

    try {
      const result = await consistencyAudit()
      unlisten()
      unlistenRef.current = null

      if (result.length === 0) {
        setPriorFindings(null)
        setFindings([])
        setViewState('all-clear')
      } else {
        setPriorFindings(result)
        setFindings(result)
        setViewState('findings')
      }
    } catch (err) {
      unlisten()
      unlistenRef.current = null

      const msg = err instanceof Error ? err.message : String(err)
      const isNoModel =
        /reasoning model|ollama|no model|model not found|connection refused/i.test(msg)

      setViewState(isNoModel ? 'no-model' : 'error')
    }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  // Top-bar right slot: count only in findings state.
  const rightSlot =
    viewState === 'findings' ? (
      <span style={{ ...typeToken.meta, color: color.inkSoft }}>{findings.length} worth a look.</span>
    ) : undefined

  return (
    <ViewShell title="Consistency" onBack={onClose} right={rightSlot}>
      {/* ── Idle ─────────────────────────────────────────────────────────── */}
      {viewState === 'idle' && (
        <Column>
          <div
            style={{
              paddingTop: space[8],
              display: 'flex',
              flexDirection: 'column',
              gap: space[5],
            }}
          >
            <div style={{ ...typeToken.display, color: color.ink }}>
              Look for notes that disagree.
            </div>
            <div
              style={{
                ...typeToken.body,
                color: color.inkSoft,
                maxWidth: 440,
                lineHeight: 1.5,
              }}
            >
              This reads your whole library with the local model and points out places where two
              notes seem to say different things. It can take a minute.
            </div>
            <div>
              <RunButton onClick={runAudit} />
            </div>
          </div>
        </Column>
      )}

      {/* ── Running ──────────────────────────────────────────────────────── */}
      {viewState === 'running' && (
        <Column>
          <div style={{ paddingTop: space[8] }}>
            <div style={{ ...typeToken.body, color: color.inkSoft }}>
              {progress && progress.total > 0
                ? `Checking ${progress.done} of ${progress.total} related notes…`
                : 'Reading your library…'}
            </div>
          </div>
        </Column>
      )}

      {/* ── Findings ─────────────────────────────────────────────────────── */}
      {viewState === 'findings' && (
        <Column>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
            {/* Header */}
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  marginBottom: space[3],
                }}
              >
                <div style={{ ...typeToken.display, color: color.ink }}>
                  A few notes to look at.
                </div>
                <RunAgainButton onClick={runAudit} />
              </div>
              <div
                style={{
                  ...typeToken.meta,
                  color: color.inkSoft,
                  lineHeight: 1.5,
                }}
              >
                Each pair below seems to say different things. Open them side by side and decide.
              </div>
            </div>

            {/* Finding rows */}
            <div>
              {findings.map((f, i) => (
                <FindingRow key={i} finding={f} onOpenFile={onOpenFile} />
              ))}
            </div>
          </div>
        </Column>
      )}

      {/* ── All clear ────────────────────────────────────────────────────── */}
      {viewState === 'all-clear' && (
        <Column>
          <div
            style={{
              paddingTop: space[8],
              display: 'flex',
              flexDirection: 'column',
              gap: space[3],
            }}
          >
            <div style={{ ...typeToken.display, color: color.ink }}>Your notes agree.</div>
            <div style={{ ...typeToken.meta, color: color.inkFaint, lineHeight: 1.5 }}>
              Nothing in your library contradicts itself. Run this again whenever you have written a
              lot.
            </div>
            <div style={{ marginTop: space[3] }}>
              <RunAgainButton onClick={runAudit} />
            </div>
          </div>
        </Column>
      )}

      {/* ── No model ─────────────────────────────────────────────────────── */}
      {viewState === 'no-model' && (
        <Column>
          <div
            style={{
              paddingTop: space[8],
              display: 'flex',
              flexDirection: 'column',
              gap: space[5],
            }}
          >
            <NoticeBlock>
              <div>The audit needs a local reasoning model.</div>
              <div style={{ marginTop: space[2] }}>
                Start Ollama, or pull one with{' '}
                <span
                  style={{
                    ...typeToken.mono,
                    color: color.inkSoft,
                  }}
                >
                  ollama pull llama3.1:8b
                </span>
                , then run the audit again.
              </div>
            </NoticeBlock>
            <div>
              <RunButton onClick={runAudit} />
            </div>
          </div>
        </Column>
      )}

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {viewState === 'error' && (
        <Column>
          <div
            style={{
              paddingTop: space[8],
              display: 'flex',
              flexDirection: 'column',
              gap: space[5],
            }}
          >
            <NoticeBlock>The audit could not finish just now.</NoticeBlock>
            <div>
              <RunButton onClick={runAudit} />
            </div>

            {/* Keep prior findings visible if a re-run failed */}
            {priorFindings && priorFindings.length > 0 && (
              <div style={{ marginTop: space[6] }}>
                <div
                  style={{
                    ...typeToken.meta,
                    color: color.inkFaint,
                    marginBottom: space[4],
                  }}
                >
                  Results from your last run:
                </div>
                {priorFindings.map((f, i) => (
                  <FindingRow key={i} finding={f} onOpenFile={onOpenFile} />
                ))}
              </div>
            )}
          </div>
        </Column>
      )}
    </ViewShell>
  )
}
