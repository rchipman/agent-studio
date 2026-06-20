'use client'

import { useCallback, useRef, useState } from 'react'
import { color } from '@/lib/tokens'

interface PanelDividerProps {
  /** Called continuously while dragging, with the new left-panel width as a percentage (0-100). */
  onResize: (leftPercent: number) => void
  /** Double-click snaps panels back to an even 50/50 split. */
  onSnap: () => void
}

/**
 * A thin draggable rule between the two workspace panels.
 *
 * onMouseDown starts a drag; mousemove translates the pointer's x against the
 * container's bounds into a left-width percentage and calls onResize. Double
 * click snaps to 50/50. The divider widens its hit area on hover so it is easy
 * to grab without visually intruding (the visible rule stays a hairline).
 */
export default function PanelDivider({ onResize, onSnap }: PanelDividerProps) {
  const [active, setActive] = useState(false)
  const frameRef = useRef<number | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const parent = (e.currentTarget as HTMLElement).parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      setActive(true)

      const onMove = (ev: MouseEvent) => {
        // Clamp so neither panel can collapse below a usable width.
        const raw = ((ev.clientX - rect.left) / rect.width) * 100
        const clamped = Math.min(80, Math.max(20, raw))
        if (frameRef.current) cancelAnimationFrame(frameRef.current)
        frameRef.current = requestAnimationFrame(() => onResize(clamped))
      }

      const onUp = () => {
        setActive(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [onResize]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      onMouseDown={handleMouseDown}
      onDoubleClick={onSnap}
      style={{
        flexShrink: 0,
        width: 9,
        marginLeft: -4,
        marginRight: -4,
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        zIndex: 5,
      }}
    >
      <div
        style={{
          width: 1,
          background: active ? color.forestLine : color.hair,
          transition: active ? 'none' : 'background 0.12s ease',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = color.forestLine
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = color.hair
        }}
      />
    </div>
  )
}
