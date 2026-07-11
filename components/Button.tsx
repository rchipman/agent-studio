'use client'

/**
 * Button.tsx
 *
 * The one shared button (design: studio-surfaces.md § Button system). Ends the
 * drift of per-file primary/secondary/text button styles and the hardcoded
 * `#fff` text that broke in dark mode. Three variants by loudness, two sizes,
 * tokens only — so both themes are correct for free (primary text is always
 * `--on-accent`, which flips white↔near-black per theme).
 *
 * Icon-only chrome glyphs (the nav rail, tab/panel ×, the + add-doc) stay
 * separate by design — this is for labelled actions.
 */

import { useState } from 'react'
import { color, space, radius, font } from '@/lib/tokens'

type Variant = 'primary' | 'secondary' | 'tertiary'
type Size = 'sm' | 'md'
/** Tertiary accent text (rest color); hover still resolves to `--ink`. */
type Tone = 'default' | 'notice' | 'forest'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  tone?: Tone
  /** Primary-only soft lift for a hero action. */
  glow?: boolean
  /** Drop horizontal padding for a truly inline link-in-a-sentence. */
  padding?: 'none'
}

const FOCUS_RING = `0 0 0 2px ${color.bgRaised}, 0 0 0 4px ${color.forestLine}`

function pads(size: Size, padding?: 'none'): React.CSSProperties {
  if (padding === 'none') return { padding: 0 }
  return size === 'sm'
    ? { padding: `${space[1]}px ${space[4]}px` }
    : { padding: `7px ${space[5]}px` }
}

function toneColor(tone: Tone): string {
  return tone === 'notice' ? color.notice : tone === 'forest' ? color.forest : color.inkSoft
}

export default function Button({
  variant = 'secondary',
  size = 'md',
  tone = 'default',
  glow = false,
  padding,
  disabled = false,
  style,
  children,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false)
  const [active, setActive] = useState(false)
  const [focus, setFocus] = useState(false)

  const base: React.CSSProperties = {
    ...pads(size, padding),
    fontFamily: font.sans,
    fontSize: size === 'sm' ? 12 : 13,
    fontWeight: 600,
    borderRadius: radius.md,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 0.12s ease, border-color 0.12s ease, color 0.12s ease',
    border: '1px solid transparent',
    boxShadow: focus && !disabled ? FOCUS_RING : 'none',
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  }

  let variantStyle: React.CSSProperties = {}

  if (variant === 'primary') {
    const bg = disabled
      ? color.forestDisabled
      : active
        ? color.forestActive
        : hover
          ? color.forestHover
          : color.forest
    variantStyle = {
      background: bg,
      color: color.onAccent,
      opacity: disabled ? undefined : 1,
      ...(disabled ? {} : glow ? { boxShadow: focus ? FOCUS_RING : `0 6px 20px ${color.forestWash}` } : {}),
    }
    // Disabled keeps on-accent text at half strength (per spec).
    if (disabled) variantStyle.color = color.onAccent
  } else if (variant === 'secondary') {
    variantStyle = {
      background: disabled ? 'transparent' : active ? color.hair : hover ? color.neutralTint : 'transparent',
      borderColor: disabled ? color.hairSoft : hover || active ? color.inkFaint : color.line,
      color: disabled ? color.inkFaint : hover || active ? color.ink : color.inkSoft,
    }
  } else {
    // tertiary
    variantStyle = {
      background: disabled ? 'transparent' : active ? color.hair : hover ? color.neutralTint : 'transparent',
      color: disabled ? color.inkFaint : hover || active ? color.ink : toneColor(tone),
    }
  }

  return (
    <button
      disabled={disabled}
      style={{ ...base, ...variantStyle, ...style }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false) }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      {...rest}
    >
      {/* Disabled primary: half-strength label per spec. */}
      {variant === 'primary' && disabled ? (
        <span style={{ opacity: 0.5 }}>{children}</span>
      ) : (
        children
      )}
    </button>
  )
}
