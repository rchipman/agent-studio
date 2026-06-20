'use client'

import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useCallback } from 'react'

/** A fully-composed launch: the agent to spawn, where, and the briefing bundle
 *  already written to a temp file. The launcher passes one of these to run(). */
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

export default function TerminalPanel({ isOpen, onClose, spawnRef, runRef }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null)
  const initializedRef = useRef(false)
  // The live child process, so xterm keystrokes can be forwarded to its stdin
  // (interactive sessions). Cleared when the process closes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childRef = useRef<any>(null)
  const inputBoundRef = useRef(false)

  const writeLine = useCallback((text: string) => {
    if (termRef.current) {
      termRef.current.writeln(text)
    }
  }, [])
  void writeLine

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

      // Forward keystrokes to the live child's stdin when one is running, so the
      // launched agent session is interactive. No child = keystrokes are ignored.
      if (!inputBoundRef.current) {
        inputBoundRef.current = true
        term.onData((data: string) => {
          const child = childRef.current
          if (child) {
            // Echo locally so typing is visible, then forward to the process.
            term.write(data)
            child.write(data).catch(() => {})
          }
        })
      }

      term.writeln('\x1b[32mAgent Studio terminal\x1b[0m — press \x1b[33m⌘R\x1b[0m to compose and launch a session')
      term.write('\r\n$ ')
    })()

    return () => {
      // Don't dispose on every close — keep terminal alive for the session
    }
  }, [isOpen])

  // Refit when panel opens
  useEffect(() => {
    if (isOpen && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [isOpen])

  // Expose spawnClaude via ref so page.tsx can call it
  useEffect(() => {
    spawnRef.current = async (filePath: string | null) => {
      if (!termRef.current) {
        return
      }
      const term = termRef.current

      const args = ['--dangerously-skip-permissions', ...(filePath ? ['--file', filePath] : [])]
      term.writeln('')
      term.writeln(`\x1b[33m> claude ${args.join(' ')}\x1b[0m`)

      try {
        const { Command } = await import('@tauri-apps/plugin-shell')
        const cmd = Command.create('claude', args)

        cmd.stdout.on('data', (data: string) => {
          term.write(data.replace(/\n/g, '\r\n'))
        })

        cmd.stderr.on('data', (data: string) => {
          term.write('\x1b[31m' + data.replace(/\n/g, '\r\n') + '\x1b[0m')
        })

        cmd.on('close', (code: { code: number | null }) => {
          term.writeln('')
          term.writeln(`\x1b[90mProcess exited (${code?.code ?? 'unknown'})\x1b[0m`)
          term.write('\r\n$ ')
        })

        cmd.on('error', (err: string) => {
          term.writeln(`\x1b[31mError: ${err}\x1b[0m`)
          term.write('\r\n$ ')
        })

        await cmd.spawn()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        term.writeln(`\x1b[31mFailed to spawn Claude: ${msg}\x1b[0m`)
        term.writeln('\x1b[90mMake sure the \`claude\` CLI is installed and in your PATH.\x1b[0m')
        term.write('\r\n$ ')
      }
    }
  }, [spawnRef])

  // Expose the launcher's run() via ref. Spawns the chosen agent in the chosen
  // cwd, streams stdout/stderr into xterm, and pipes the composed bundle to the
  // child's stdin so the agent starts fully briefed. Keystrokes route to stdin
  // via childRef (bound above) for an interactive session.
  useEffect(() => {
    if (!runRef) return
    runRef.current = async (req) => {
      if (!termRef.current) return
      const term = termRef.current

      term.writeln('')
      term.writeln(`\x1b[33m> ${req.command} ${req.args.join(' ')}\x1b[0m`)
      term.writeln(`\x1b[90m  in ${req.cwd}\x1b[0m`)

      try {
        const { Command } = await import('@tauri-apps/plugin-shell')
        const cmd = Command.create(req.command, req.args, { cwd: req.cwd })

        cmd.stdout.on('data', (data: string) => {
          term.write(data.replace(/\n/g, '\r\n'))
        })
        cmd.stderr.on('data', (data: string) => {
          // No red alarm: dim the agent's stderr rather than flag it.
          term.write('\x1b[90m' + data.replace(/\n/g, '\r\n') + '\x1b[0m')
        })
        cmd.on('close', (code: { code: number | null }) => {
          childRef.current = null
          term.writeln('')
          term.writeln(`\x1b[90mSession ended (${code?.code ?? 'unknown'})\x1b[0m`)
          term.write('\r\n$ ')
        })
        cmd.on('error', (err: string) => {
          childRef.current = null
          term.writeln('')
          term.writeln(`\x1b[33m${err}\x1b[0m`)
          term.write('\r\n$ ')
        })

        const child = await cmd.spawn()
        childRef.current = child

        // Inject the briefing bundle via stdin. The bundle path is also in the
        // agent's args (see composeAgentArgs), so a `claude`-style CLI can read
        // it as a file; piping to stdin covers prompt-on-stdin agents too.
        if (req.bundle) {
          try {
            await child.write(req.bundle)
          } catch {
            /* some agents close stdin early; the file arg still carries it */
          }
        }
      } catch (err) {
        childRef.current = null
        const msg = err instanceof Error ? err.message : String(err)
        term.writeln(`\x1b[33mCould not start ${req.label}: ${msg}\x1b[0m`)
        term.writeln(`\x1b[90mCheck that \`${req.command}\` is installed and on your PATH.\x1b[0m`)
        term.write('\r\n$ ')
      }
    }
  }, [runRef])

  return (
    <>
      <div
        style={{
          height: isOpen ? '280px' : '0',
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'height 0.2s ease',
          borderTop: isOpen ? '1px solid rgba(0,0,0,0.18)' : 'none',
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
