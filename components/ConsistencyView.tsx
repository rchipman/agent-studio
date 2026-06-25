'use client'

/**
 * ConsistencyView.tsx
 *
 * Consistency as a live readout (TIN-1761). The check is now ambient: a one-time
 * seed reads the whole library; after that it keeps itself current in the
 * background as notes change. This view is a window onto that maintained picture,
 * not a run-button state machine.
 *
 * On mount we read `consistency_status()`; we re-fetch on window focus / when the
 * view becomes active (the table updates in the background, no event is emitted).
 * States: unseeded (the one-time seed invite) → seeding (the existing streaming
 * UX) → fresh-findings | fresh-clear → no-model | error.
 *
 * A finding is an invitation to look, never an accusation. No severity, no
 * dismiss/resolve, no red, no ⚠. Tokens only, calm copy, curly apostrophes,
 * no em-dashes.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { color, space, radius, font, type as typeToken } from '@/lib/tokens'
import Button from '@/components/Button'
import {
  consistencyAudit,
  consistencyStatus,
  consistencyFindings,
  statusToReadout,
  onAuditProgress,
  onFinding,
  cancelAudit,
  type Finding,
} from '@/lib/audit'
import ViewBody from '@/components/ViewBody'
import { useTopBarSlot } from '@/components/TopBarSlot'

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewState =
  | 'loading'
  | 'unseeded'
  | 'seeding'
  | 'fresh-findings'
  | 'fresh-clear'
  | 'no-model'
  | 'error'

export interface ConsistencyViewProps {
  /** plain click = this panel; ⌘-click = other panel */
  onOpenFile: (path: string, e: React.MouseEvent) => void
  onClose: () => void
  /** Note count, if cheaply available, for the seed-invite copy. */
  noteCount?: number
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

/** A calm, tappable pill that opens a note (plain click = same panel, ⌘-click =
 *  the other). Reused by the write-time continuity surfaces (TIN-1730). */
export function NotePill({
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

export default function ConsistencyView({ onOpenFile, onClose, noteCount }: ConsistencyViewProps) {
  const [viewState, setViewState] = useState<ViewState>('loading')
  const [findings, setFindings] = useState<Finding[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // True once a seed was stopped early, so the partial findings carry a note.
  const [stoppedEarly, setStoppedEarly] = useState(false)

  // Track unlisten fns so we can clean them up.
  const unlistenRef = useRef<(() => void) | null>(null)
  const unlistenFindingRef = useRef<(() => void) | null>(null)
  // Deduplicate live findings by their sorted file-pair key.
  const findingKeysRef = useRef<Set<string>>(new Set())
  // Don't clobber an in-flight seed with a background status refetch.
  const seedingRef = useRef(false)

  // ── Status refresh: on mount, on window focus ─────────────────────────────
  const refresh = useCallback(async () => {
    if (seedingRef.current) return
    try {
      const status = await consistencyStatus()
      if (seedingRef.current) return
      const readout = statusToReadout(status)
      if (readout !== 'fresh-findings') {
        setFindings([])
        setViewState(readout)
        return
      }
      const current = await consistencyFindings()
      if (seedingRef.current) return
      setFindings(current)
      setViewState('fresh-findings')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isNoModel =
        /reasoning model|ollama|no model|model not found|connection refused/i.test(msg)
      // On error keep whatever findings are shown; the readout stays useful.
      setViewState(isNoModel ? 'no-model' : 'error')
    }
  }, [])

  useEffect(() => {
    refresh()
    function onFocus() {
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Cleanup subscriptions on unmount.
  useEffect(() => {
    return () => {
      unlistenRef.current?.()
      unlistenFindingRef.current?.()
    }
  }, [])

  // ── The seed: the existing streaming sweep, verbatim UX ────────────────────
  const runSeed = useCallback(async () => {
    // Unsubscribe any previous listeners.
    unlistenRef.current?.()
    unlistenRef.current = null
    unlistenFindingRef.current?.()
    unlistenFindingRef.current = null

    seedingRef.current = true
    setStoppedEarly(false)
    setViewState('seeding')
    setProgress(null)
    setFindings([])
    findingKeysRef.current = new Set()

    // Subscribe before calling so we never miss events.
    const unlistenFinding = await onFinding((f) => {
      const key = [...f.files].sort().join('\0')
      if (!findingKeysRef.current.has(key)) {
        findingKeysRef.current.add(key)
        setFindings((prev) => [...prev, f])
      }
    })
    unlistenFindingRef.current = unlistenFinding

    const unlisten = await onAuditProgress((p) => {
      setProgress(p)
    })
    unlistenRef.current = unlisten

    try {
      const result = await consistencyAudit()
      unlisten()
      unlistenRef.current = null
      unlistenFinding()
      unlistenFindingRef.current = null
      seedingRef.current = false

      // Reconcile: the returned Vec is authoritative. Dedup by file-pair key.
      const seen = new Set<string>()
      const deduped = result.filter((f) => {
        const key = [...f.files].sort().join('\0')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      if (deduped.length === 0) {
        setFindings([])
        setViewState('fresh-clear')
      } else {
        setFindings(deduped)
        setViewState('fresh-findings')
      }
    } catch (err) {
      unlisten()
      unlistenRef.current = null
      unlistenFinding()
      unlistenFindingRef.current = null
      seedingRef.current = false

      const msg = err instanceof Error ? err.message : String(err)
      const isNoModel =
        /reasoning model|ollama|no model|model not found|connection refused/i.test(msg)
      const isCancelled = /cancelled|canceled|cancel/i.test(msg)

      if (isCancelled) {
        // Stopped early: keep partial findings, carry the durability note. Fall
        // back to a sensible state based on what streamed in.
        setStoppedEarly(true)
        setViewState(findingKeysRef.current.size > 0 ? 'fresh-findings' : 'fresh-clear')
      } else {
        setViewState(isNoModel ? 'no-model' : 'error')
      }
    }
  }, [])

  // ── Top-bar right slot: count only in fresh-findings ───────────────────────
  const { setRight } = useTopBarSlot()
  useEffect(() => {
    setRight(
      viewState === 'fresh-findings' ? (
        <span style={{ ...typeToken.meta, color: color.inkSoft }}>
          {findings.length} worth a look.
        </span>
      ) : null,
    )
    return () => setRight(null)
  }, [setRight, viewState, findings.length])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <ViewBody>
      {/* ── Loading: render nothing (status read is cheap) ─────────────────── */}
      {viewState === 'loading' && <Column>{null}</Column>}

      {/* ── Unseeded: the one-time seed invitation ─────────────────────────── */}
      {viewState === 'unseeded' && (
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
              Start watching for notes that disagree.
            </div>
            <div
              style={{
                ...typeToken.body,
                color: color.inkSoft,
                maxWidth: 440,
                lineHeight: 1.5,
              }}
            >
              The first pass reads all{noteCount != null ? ` ${noteCount}` : ''} notes once with the
              local model and builds the picture. It can take a minute. After that it keeps itself
              current as you edit, and you won&rsquo;t need to run it again.
            </div>
            <div>
              <Button variant="primary" onClick={runSeed}>
                Do the first pass
              </Button>
            </div>
          </div>
        </Column>
      )}

      {/* ── Seeding: the existing streaming UX, verbatim ───────────────────── */}
      {viewState === 'seeding' && (
        <Column>
          <div
            style={{ paddingTop: space[8], display: 'flex', flexDirection: 'column', gap: space[4] }}
          >
            <div style={{ ...typeToken.body, color: color.inkSoft }}>
              {progress && progress.total > 0
                ? `Checking ${progress.done} of ${progress.total} related notes…`
                : 'Reading your library…'}
            </div>
            <div>
              <Button variant="secondary" onClick={() => cancelAudit()}>
                Stop
              </Button>
            </div>

            {/* Live-streamed findings */}
            {findings.length > 0 && (
              <div style={{ marginTop: space[4] }}>
                {findings.map((f, i) => (
                  <FindingRow key={i} finding={f} onOpenFile={onOpenFile} />
                ))}
              </div>
            )}
          </div>
        </Column>
      )}

      {/* ── Fresh findings: the maintained current contradictions ──────────── */}
      {viewState === 'fresh-findings' && (
        <Column>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  marginBottom: space[3],
                  gap: space[4],
                }}
              >
                <div style={{ ...typeToken.display, color: color.ink }}>
                  What&rsquo;s in tension right now.
                </div>
                <span style={{ ...typeToken.meta, color: color.inkFaint, whiteSpace: 'nowrap' }}>
                  Kept current.
                </span>
              </div>
              <div style={{ ...typeToken.meta, color: color.inkSoft, lineHeight: 1.5 }}>
                These pairs currently say different things. As you edit, they update on their own.
              </div>
            </div>

            {stoppedEarly && (
              <div style={{ ...typeToken.meta, color: color.inkFaint, lineHeight: 1.5 }}>
                Stopped early. The rest will fill in as you edit, or you can do a full pass again.
              </div>
            )}

            <div>
              {findings.map((f, i) => (
                <FindingRow key={i} finding={f} onOpenFile={onOpenFile} />
              ))}
            </div>
          </div>
        </Column>
      )}

      {/* ── Fresh clear: nothing in tension ────────────────────────────────── */}
      {viewState === 'fresh-clear' && (
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
              Nothing in your library is in tension. This stays current as you write, so
              there&rsquo;s nothing to run.
            </div>

            {stoppedEarly && (
              <div style={{ ...typeToken.meta, color: color.inkFaint, lineHeight: 1.5 }}>
                Stopped early. The rest will fill in as you edit, or you can do a full pass again.
              </div>
            )}

            <div style={{ marginTop: space[3] }}>
              <Button variant="tertiary" padding="none" onClick={runSeed} style={{ color: color.inkFaint }}>
                Do a full pass again
              </Button>
            </div>
          </div>
        </Column>
      )}

      {/* ── No model ───────────────────────────────────────────────────────── */}
      {viewState === 'no-model' && (
        <Column>
          <div style={{ paddingTop: space[8] }}>
            <NoticeBlock>The check needs a local reasoning model.</NoticeBlock>
          </div>
        </Column>
      )}

      {/* ── Error: keep the table visible under a recessive notice ─────────── */}
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
            <NoticeBlock>
              The background check paused. What&rsquo;s shown is still current as of your last edit.
            </NoticeBlock>

            {findings.length > 0 && (
              <div>
                {findings.map((f, i) => (
                  <FindingRow key={i} finding={f} onOpenFile={onOpenFile} />
                ))}
              </div>
            )}
          </div>
        </Column>
      )}
    </ViewBody>
  )
}
