'use client'

import { useEffect, useRef } from 'react'
import { color, radius, shadow, type as typeTokens, space } from '@/lib/tokens'

export interface ToastProps {
  message: string
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
}

/**
 * Toast — shared bottom-center notification primitive.
 *
 * Appearance: --bg-raised card, --r-md, subtle shadow, --t-body text,
 * 1px left accent in --add. Auto-dismisses after ~2.5s.
 *
 * Usage:
 *   <Toast message="Saved to studio." actionLabel="Open" onAction={...} onDismiss={...} />
 */
export default function Toast({ message, actionLabel, onAction, onDismiss }: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onDismiss()
    }, 2500)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [onDismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: space[7],
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 3000,
        display: 'flex',
        alignItems: 'center',
        gap: space[4],
        background: color.bgRaised,
        borderRadius: radius.md,
        boxShadow: shadow.toast,
        borderLeft: `1px solid ${color.add}`,
        padding: `${space[3]}px ${space[5]}px`,
        ...typeTokens.body,
        color: color.ink,
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
      }}
    >
      <span>{message}</span>
      {actionLabel && onAction && (
        <button
          onClick={() => {
            onAction()
            onDismiss()
          }}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            ...typeTokens.body,
            color: color.forest,
            fontWeight: 600,
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
