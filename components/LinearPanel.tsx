'use client'

import { useEffect, useRef } from 'react'

/**
 * Opens (or focuses) a native Tauri WebviewWindow for a Linear ticket.
 *
 * - Each ticket gets its own window, keyed by a per-ticket label, so opening
 *   a different ticket shows that ticket (Tauri v2 has no JS navigate() to
 *   repoint a live window).
 * - Reopening the same ticket while its window is still open focuses it
 *   instead of spawning a duplicate, and the webview keeps its own
 *   cookie/session store across opens.
 */
async function openLinearWindow(ticketId: string): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const { getCurrentWindow } = await import('@tauri-apps/api/window')

  const url = `https://linear.app/tiny-forest/issue/${ticketId}`
  // Per-ticket label (labels allow [a-zA-Z0-9_-], which covers TIN-1234).
  const label = `linear-${ticketId}`

  // Reuse the existing window if it is still alive
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    try {
      await existing.show()
      await existing.setFocus()
    } catch {
      // Window may have been destroyed between getByLabel and here; fall through to create
    }
    return
  }

  // Position the new window to the right of the main window
  let x: number | undefined
  let y: number | undefined
  try {
    const main = getCurrentWindow()
    const pos = await main.outerPosition()
    const size = await main.outerSize()
    // Place it immediately to the right; if that goes off-screen the OS will
    // clip/reposition automatically.
    x = pos.x + size.width
    y = pos.y
  } catch {
    // Position is a hint; fine to omit
  }

  new WebviewWindow(label, {
    url,
    title: ticketId,
    width: 900,
    height: 800,
    x,
    y,
    focus: true,
    resizable: true,
    decorations: true,
  })
}

// ── Public hook ────────────────────────────────────────────────────────────────

interface UseLinearWindowResult {
  openTicket: (ticketId: string) => void
}

export function useLinearWindow(): UseLinearWindowResult {
  const openTicket = (ticketId: string) => {
    openLinearWindow(ticketId).catch((err) => {
      console.error('[LinearWindow] failed to open:', err)
    })
  }
  return { openTicket }
}

// ── Drop-in compatibility shim ─────────────────────────────────────────────────
//
// page.tsx renders <LinearPanel ticketId={activeTicket} onClose={...} />.
// This component preserves that interface: when ticketId changes to a non-null
// value it opens/focuses the native window; onClose is called immediately so
// the parent state resets (the window manages its own lifecycle from here).

interface LinearPanelProps {
  ticketId: string | null
  onClose: () => void
}

export default function LinearPanel({ ticketId, onClose }: LinearPanelProps) {
  const prevTicketRef = useRef<string | null>(null)

  useEffect(() => {
    if (!ticketId || ticketId === prevTicketRef.current) return
    prevTicketRef.current = ticketId

    openLinearWindow(ticketId).catch((err) => {
      console.error('[LinearWindow] failed to open:', err)
    })

    // Reset parent state — the native window is now in charge
    onClose()
  }, [ticketId, onClose])

  // No DOM rendered; this component is purely a side-effect bridge
  return null
}
