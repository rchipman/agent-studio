'use client'

/**
 * ViewShell.tsx
 *
 * The one shared chrome for every full-view "room" (Graph, Frontmatter, Consistency,
 * Transcripts). Phase 3 of the navigation redesign: the four views hand-rolled the
 * same 44px top bar (`← Agent Studio` + centered title + a right slot); this collapses
 * them into a single component so the chrome is identical everywhere and lives in one
 * place. The nav rail (always present to the left) handles room-to-room movement; this
 * bar's back button is the explicit "exit to the workspace."
 *
 * Tokens only; no new mood.
 */

import { color, space, radius, type as typeRamp } from '@/lib/tokens'

interface ViewShellProps {
  /** Centered title, e.g. "Graph", "Consistency". */
  title: string
  /** Back to the workspace. */
  onBack: () => void
  /** View-specific controls, right-aligned (reset, a count, a summary line). */
  right?: React.ReactNode
  children: React.ReactNode
}

export default function ViewShell({ title, onBack, right, children }: ViewShellProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: color.bgApp,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${space[5]}px`,
          borderBottom: `1px solid ${color.hair}`,
          flexShrink: 0,
          background: color.bgApp,
          gap: space[5],
        }}
      >
        <button
          onClick={onBack}
          title="Back to the workspace"
          style={{
            background: 'none',
            border: 'none',
            padding: `${space[2]}px ${space[3]}px`,
            cursor: 'pointer',
            ...typeRamp.body,
            color: color.inkSoft,
            borderRadius: radius.md,
            display: 'flex',
            alignItems: 'center',
            gap: space[2],
            flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = color.ink)}
          onMouseLeave={(e) => (e.currentTarget.style.color = color.inkSoft)}
        >
          <span style={{ fontSize: 14 }} aria-hidden>
            ←
          </span>
          <span>Agent Studio</span>
        </button>

        <div style={{ flex: 1, textAlign: 'center', ...typeRamp.title, color: color.ink }}>{title}</div>

        <div
          style={{
            width: 240,
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: space[3],
          }}
        >
          {right}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}
