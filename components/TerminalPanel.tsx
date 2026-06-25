'use client'

import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { color } from '@/lib/tokens'
import PanelDivider from './PanelDivider'

/** A fully-composed launch: the agent to spawn, where, and the briefing bundle.
 *  The launcher passes one of these to run(). */
export interface RunRequest {
  /** Human label for the agent (printed in the terminal banner). */
  label: string
  /** Executable to spawn. */
  command: string
  /** Arguments, with the bundle path already substituted in. */
  args: string[]
  /** Working directory to spawn in. */
  cwd: string
  /** The composed briefing bundle, piped to the child's stdin after spawn. */
  bundle: string
}

interface TerminalPanelProps {
  isOpen: boolean
  onClose: () => void
  spawnRef: React.MutableRefObject<((filePath: string | null) => void) | null>
  /** Launcher entry point: run a composed agent launch in the terminal. */
  runRef?: React.MutableRefObject<((req: RunRequest) => void) | null>
}

const TERM_WIDTH_KEY = 'agent-studio-terminal-width'
const DEFAULT_WIDTH = 440
const MIN_WIDTH = 320

export default function TerminalPanel({ isOpen, onClose, spawnRef, runRef }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null)
  const initializedRef = useRef(false)
  // True while an agent session is live, so xterm keystrokes route to its stdin.
  const sessionActiveRef = useRef(false)
  const inputBoundRef = useRef(false)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  // Terminal dock width — persisted to localStorage, draggable via PanelDivider.
  const [termWidth, setTermWidthRaw] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH
    const stored = localStorage.getItem(TERM_WIDTH_KEY)
    const parsed = stored ? Number(stored) : NaN
    return Number.isFinite(parsed) && parsed >= MIN_WIDTH ? parsed : DEFAULT_WIDTH
  })

  const setTermWidth = useCallback((w: number) => {
    const maxW = Math.round(window.innerWidth * 0.6)
    const clamped = Math.min(maxW, Math.max(MIN_WIDTH, Math.round(w)))
    setTermWidthRaw(clamped)
    localStorage.setItem(TERM_WIDTH_KEY, String(clamped))
  }, [])

  // onResize is required by PanelDivider's interface but is superseded by
  // onMouseDownOverride — the pixel handler below handles all actual resizing.
  const handleDividerResize = useCallback(() => {}, [])

  // Pixel-accurate left-edge drag. PanelDivider takes over visual/cursor duties;
  // we attach our own global mousemove during drag to compute width from screen X.
  const isDraggingRef = useRef(false)

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDraggingRef.current = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        if (!isDraggingRef.current) return
        // Terminal dock is the rightmost sibling. Its right edge = viewport right edge
        // (minus any further siblings, but LinearPanel is a modal overlay).
        // New dock width = viewport right - cursor X.
        const newWidth = window.innerWidth - ev.clientX
        setTermWidth(newWidth)
        // Refit after each drag step
        requestAnimationFrame(() => fitAddonRef.current?.fit())
      }

      const onUp = () => {
        isDraggingRef.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        fitAddonRef.current?.fit()
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [setTermWidth]
  )

  // Initialize xterm once container is available and panel first opens
  useEffect(() => {
    if (!isOpen || !containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let term: import('@xterm/xterm').Terminal
    let fitAddon: import('@xterm/addon-fit').FitAddon

    ;(async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')

      term = new Terminal({
        theme: {
          background: '#1a1917',
          foreground: '#d4d0cb',
          cursor: '#d4d0cb',
          selectionBackground: 'rgba(255,255,255,0.15)',
        },
        fontFamily: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
        fontSize: 13,
        lineHeight: 1.45,
        cursorBlink: true,
        convertEol: true,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current!)
      fitAddon.fit()

      termRef.current = term
      fitAddonRef.current = fitAddon

      // Stream the spawned process's output (Rust emits `terminal://output`).
      unlistenRef.current = await listen<string>('terminal://output', (e) => {
        term.write(typeof e.payload === 'string' ? e.payload : String(e.payload))
      })

      // Forward keystrokes to the live child's stdin when a session is running.
      if (!inputBoundRef.current) {
        inputBoundRef.current = true
        term.onData((data: string) => {
          if (!sessionActiveRef.current) return
          term.write(data) // local echo so typing is visible
          invoke('terminal_write', { payload: { data } }).catch(() => {})
        })
      }

      term.writeln('\x1b[32mAgent Studio terminal\x1b[0m — press \x1b[33m⌘R\x1b[0m to compose and launch a session')
      term.write('\r\n$ ')
    })()

    return () => {
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }, [isOpen])

  // Refit when panel opens
  useEffect(() => {
    if (isOpen && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [isOpen])

  // Refit whenever the dock width changes (drag resize)
  useEffect(() => {
    if (isOpen && fitAddonRef.current) {
      fitAddonRef.current.fit()
    }
  }, [isOpen, termWidth])

  // ResizeObserver on the xterm container — refits whenever the container size
  // changes for any reason (window resize, dock drag, etc.)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      fitAddonRef.current?.fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Legacy direct-claude entry (kept for compatibility; the launcher path is
  // runRef). Spawns via the Rust command like everything else.
  useEffect(() => {
    spawnRef.current = async (filePath: string | null) => {
      const term = termRef.current
      if (!term) return
      const args = ['--dangerously-skip-permissions', ...(filePath ? ['--file', filePath] : [])]
      term.writeln('')
      term.writeln(`\x1b[33m> claude ${args.join(' ')}\x1b[0m`)
      try {
        await invoke('spawn_agent', { payload: { command: 'claude', args, cwd: '', bundle: null } })
        sessionActiveRef.current = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        term.writeln(`\x1b[33mCould not start claude: ${msg}\x1b[0m`)
        term.write('\r\n$ ')
      }
    }
  }, [spawnRef])

  // Launcher's run(): spawn the chosen agent in the chosen cwd via Rust, stream
  // its output into xterm (terminal://output), and pipe the briefing bundle to
  // its stdin. Keystrokes then route to stdin via terminal_write.
  useEffect(() => {
    if (!runRef) return
    runRef.current = async (req) => {
      const term = termRef.current
      if (!term) return
      term.writeln('')
      term.writeln(`\x1b[33m> ${req.command} ${req.args.join(' ')}\x1b[0m`)
      term.writeln(`\x1b[90m  in ${req.cwd}\x1b[0m`)
      try {
        await invoke('spawn_agent', {
          payload: { command: req.command, args: req.args, cwd: req.cwd, bundle: req.bundle || null },
        })
        sessionActiveRef.current = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        term.writeln(`\x1b[33mCould not start ${req.label}: ${msg}\x1b[0m`)
        term.writeln(`\x1b[90mCheck that \`${req.command}\` is installed and on your PATH.\x1b[0m`)
        term.write('\r\n$ ')
      }
    }
  }, [runRef])

  return (
    <>
      {/* Left-edge drag handle — rendered outside the dock so it overlaps the
          content column by a few pixels and is easy to grab. Reuses PanelDivider
          for visual/cursor/aria consistency; actual resize is pixel-based. */}
      {isOpen && (
        <PanelDivider
          onResize={handleDividerResize}
          onSnap={() => setTermWidth(DEFAULT_WIDTH)}
          onMouseDownOverride={handleDividerMouseDown}
        />
      )}

      {/* Terminal dock — full-height right column */}
      <div
        data-testid="terminal-dock"
        data-open={isOpen ? 'true' : 'false'}
        style={{
          height: '100%',
          width: isOpen ? `${termWidth}px` : 0,
          minWidth: 0,
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 0.18s ease',
          borderLeft: isOpen ? `1px solid ${color.hairSoft}` : 'none',
          background: '#1a1917',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Terminal header */}
        <div
          style={{
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            background: '#1a1917',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        >
          <span
            title="Toggle terminal (⌘J)"
            style={{
              fontSize: '11px',
              fontWeight: 500,
              color: 'rgba(255,255,255,0.45)',
              fontFamily: 'system-ui, sans-serif',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            Terminal
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              color: 'rgba(255,255,255,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '3px',
            }}
            aria-label="Close terminal"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* xterm container */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            overflow: 'hidden',
            padding: '8px 8px 4px',
          }}
        />
      </div>
    </>
  )
}
