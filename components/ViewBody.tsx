'use client'

/**
 * ViewBody.tsx
 *
 * The header-less body shell for every full-view "room" (Graph, Fields,
 * Consistency, Sessions, Changes). TIN-1708 retired ViewShell's 44px header: the
 * one persistent TopBar (rendered once in page.tsx) now owns the back/forward
 * arrows, the room title, and each view's right-slot actions. What remains is
 * this minimal body container — it fills the content area below the TopBar, on
 * the app cream, with the view's own scroll handled inside.
 *
 * Tokens only; no chrome of its own.
 */

import { color } from '@/lib/tokens'

interface ViewBodyProps {
  children: React.ReactNode
}

export default function ViewBody({ children }: ViewBodyProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
        background: color.bgApp,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  )
}
