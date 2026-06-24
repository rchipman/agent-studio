'use client'

/**
 * NavRail.tsx
 *
 * The persistent left navigation rail (TIN navigation redesign). Gives every
 * destination a permanent, labelled home and shows where you are — answering
 * "where am I" (the active item) and "where can I go" (it's always there, in the
 * workspace and inside every full view). Rail = destinations (rooms); the top
 * bar = verbs (New / Launch / Split).
 *
 * Calm by construction: forest-on-cream, icon + faint micro-label, exactly one
 * active item in forest with the established selected-row treatment. No new
 * tokens — all from lib/tokens.ts.
 */

import { color, space, radius, font, type as typeRamp } from '@/lib/tokens'

/** Rail destinations. `search` is the workspace home. */
export type RailDest = 'search' | 'graph' | 'frontmatter' | 'consistency' | 'transcripts'

const RAIL_WIDTH = 52

interface NavRailProps {
  active: RailDest
  onSelect: (dest: RailDest) => void
  onOpenSettings: () => void
}

// ── Icons (16px stroke, matching the app's icon style) ──────────────────────────

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Icon({ name }: { name: RailDest | 'settings' }) {
  const common = { width: 17, height: 17, viewBox: '0 0 24 24', ...stroke }
  switch (name) {
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <line x1="16" y1="16" x2="21" y2="21" />
        </svg>
      )
    case 'graph':
      return (
        <svg {...common}>
          <circle cx="6" cy="7" r="2.2" />
          <circle cx="18" cy="9" r="2.2" />
          <circle cx="11" cy="18" r="2.2" />
          <line x1="8" y1="8" x2="16" y2="9" />
          <line x1="7" y1="9" x2="10" y2="16" />
          <line x1="16" y1="11" x2="12" y2="16" />
        </svg>
      )
    case 'frontmatter':
      return (
        <svg {...common}>
          <path d="M6 3h9l3 3v15H6z" />
          <line x1="9" y1="9" x2="15" y2="9" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="12" y2="17" />
        </svg>
      )
    case 'consistency':
      return (
        <svg {...common}>
          <path d="M3 9c3 0 3-3 6-3s3 3 6 3" />
          <path d="M3 15c3 0 3-3 6-3s3 3 6 3" />
          <line x1="18" y1="5" x2="18" y2="19" />
        </svg>
      )
    case 'transcripts':
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
  }
}

// ── Rail item ───────────────────────────────────────────────────────────────────

function RailItem({
  dest,
  label,
  active,
  onClick,
  title,
}: {
  dest: RailDest | 'settings'
  label: string
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      style={{
        position: 'relative',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        padding: `${space[2]}px 0`,
        background: active ? color.forestWash : 'transparent',
        color: active ? color.forest : color.inkSoft,
        border: 'none',
        borderRadius: radius.md,
        cursor: 'pointer',
        transition: 'all 0.1s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = color.bgFieldStrong
          e.currentTarget.style.color = color.ink
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = color.inkSoft
        }
      }}
    >
      {/* Active left rule — the selected-row treatment, rotated to the rail. */}
      {active && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: color.forest,
          }}
        />
      )}
      <Icon name={dest} />
      <span style={{ ...typeRamp.micro, fontSize: 9, letterSpacing: '0.01em', lineHeight: 1 }}>{label}</span>
    </button>
  )
}

function Divider() {
  return <div style={{ height: 1, background: color.hair, margin: `${space[2]}px ${space[3]}px` }} />
}

// ── Rail ────────────────────────────────────────────────────────────────────────

export default function NavRail({ active, onSelect, onOpenSettings }: NavRailProps) {
  return (
    <nav
      aria-label="Main"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        background: color.bgApp,
        borderRight: `1px solid ${color.hair}`,
        padding: `${space[2]}px ${space[2]}px`,
        boxSizing: 'border-box',
        gap: 2,
      }}
    >
      {/* Wordmark */}
      <div
        style={{
          textAlign: 'center',
          fontFamily: "'Fraunces', 'Georgia', serif",
          fontSize: 16,
          fontWeight: 600,
          color: color.forest,
          padding: `${space[2]}px 0 ${space[3]}px`,
          letterSpacing: '-0.01em',
        }}
        title="Agent Studio"
      >
        Ag
      </div>

      <RailItem dest="search" label="Search" active={active === 'search'} onClick={() => onSelect('search')} title="Search (⌘F)" />

      <Divider />

      <RailItem dest="graph" label="Graph" active={active === 'graph'} onClick={() => onSelect('graph')} title="Knowledge graph (⌘G)" />
      <RailItem dest="frontmatter" label="Fields" active={active === 'frontmatter'} onClick={() => onSelect('frontmatter')} title="Frontmatter audit (⌘⇧A)" />
      <RailItem dest="consistency" label="Check" active={active === 'consistency'} onClick={() => onSelect('consistency')} title="Consistency audit (⌘⇧C)" />

      <Divider />

      <RailItem dest="transcripts" label="Sessions" active={active === 'transcripts'} onClick={() => onSelect('transcripts')} title="Transcripts (⌘T)" />

      <div style={{ flex: 1 }} />

      <RailItem dest="settings" label="Settings" active={false} onClick={onOpenSettings} title="Settings (⌘,)" />
    </nav>
  )
}
