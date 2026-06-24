'use client'

/**
 * TopBar.tsx
 *
 * The one persistent, context-aware top bar (TIN-1708). Rendered once in
 * app/page.tsx, always visible, right of the nav rail and above the per-view
 * content, in every view (the workspace and all full views). It replaces both
 * the workspace's hand-rolled header and ViewShell's header.
 *
 * Left to right: history arrows (back / forward across every view, TIN-1705), a
 * hairline divider, a left-aligned context label (the serif wordmark in the
 * workspace, else the room title), a flex spacer, and a right contextual slot
 * (the workspace's create button, or the active view's registered actions).
 *
 * The rail shows where you are; the history arrows are how you leave (plus Esc).
 * There is no explicit back button. Tokens only; calm by construction.
 */

import { color, space, radius, type as typeRamp } from '@/lib/tokens'

// ── History arrow (moved here from page.tsx, TIN-1705) ─────────────────────────

/** A single back/forward chevron for the top bar. Calm and quiet; disabled (and
 *  unclickable) at the ends of the trail. */
function HistoryArrow({
  dir, enabled, onClick, title,
}: { dir: 'back' | 'forward'; enabled: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      aria-label={title}
      title={title}
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        background: 'transparent',
        border: 'none',
        borderRadius: radius.sm,
        cursor: enabled ? 'pointer' : 'default',
        color: enabled ? color.inkSoft : color.inkFaint,
        opacity: enabled ? 1 : 0.4,
        transition: 'all 0.1s ease',
      }}
      onMouseEnter={(e) => { if (enabled) { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.ink } }}
      onMouseLeave={(e) => { if (enabled) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkSoft } }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {dir === 'back'
          ? <polyline points="10,3 5,8 10,13" />
          : <polyline points="6,3 11,8 6,13" />}
      </svg>
    </button>
  )
}

// ── Top bar ────────────────────────────────────────────────────────────────────

export interface TopBarProps {
  /** 'wordmark' in the workspace; 'title' in every full view. */
  variant: 'wordmark' | 'title'
  /** The room name, when variant is 'title'. */
  title?: string
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  /** The right contextual slot (the workspace's create button, or a view's actions). */
  right?: React.ReactNode
}

export default function TopBar({
  variant, title, canBack, canForward, onBack, onForward, right,
}: TopBarProps) {
  return (
    <header
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        borderBottom: `1px solid ${color.hair}`,
        background: color.bgApp,
        flexShrink: 0,
        paddingLeft: space[6],
        paddingRight: space[5],
      }}
    >
      {/* Global history — back / forward across every view (TIN-1705). */}
      <div style={{ display: 'flex', gap: space[1], marginLeft: `-${space[2]}px` }}>
        <HistoryArrow dir="back" enabled={canBack} onClick={onBack} title="Back (⌘[)" />
        <HistoryArrow dir="forward" enabled={canForward} onClick={onForward} title="Forward (⌘])" />
      </div>

      {/* Vertical hairline divider. */}
      <div style={{ width: 1, height: 16, background: color.hair, margin: `0 ${space[4]}px` }} />

      {/* Context label, left-aligned right after the divider. */}
      {variant === 'wordmark' ? (
        <span
          style={{
            fontFamily: "'Fraunces', 'Georgia', serif",
            fontSize: 15,
            fontWeight: 600,
            color: color.forest,
            letterSpacing: '-0.01em',
          }}
        >
          Agent Studio
        </span>
      ) : (
        <span style={{ ...typeRamp.title, color: color.ink }}>{title}</span>
      )}

      <div style={{ flex: 1 }} />

      {/* Right contextual slot. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[4],
          flexShrink: 0,
          justifyContent: 'flex-end',
        }}
      >
        {right}
      </div>
    </header>
  )
}
