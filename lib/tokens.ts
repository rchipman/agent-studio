/**
 * tokens.ts
 *
 * The design token set from docs/design/studio-surfaces.md, as typed values for
 * inline-styled React (the app's prevailing style). Mirrors the CSS custom
 * properties in app/globals.css. Reference these, never magic numbers.
 *
 * House rule: there is no red token. Removals and errors read as calm, recessive
 * states (heather `remove`, tan `notice`), never as alarm.
 */

export const color = {
  bgApp: '#F2F0ED',
  bgRaised: '#FCFAF4',
  bgField: 'rgba(255,255,255,0.70)',
  bgFieldStrong: 'rgba(255,255,255,0.85)',
  bgCard: 'rgba(255,255,255,0.55)',
  ink: '#262320',
  inkSoft: '#6B6760',
  inkFaint: '#9B9490',
  forest: '#3E5641',
  forestTint: 'rgba(62,86,65,0.10)',
  forestLine: 'rgba(62,86,65,0.30)',
  forestWash: 'rgba(62,86,65,0.06)',
  tan: '#9B7B5A',
  tanTint: 'rgba(155,123,90,0.10)',
  hair: 'rgba(38,35,32,0.10)',
  hairSoft: 'rgba(38,35,32,0.08)',
  neutralTint: 'rgba(38,35,32,0.06)',
  line: 'rgba(38,35,32,0.18)',
  scrim: 'rgba(38,35,32,0.45)',
  termBg: '#1a1917',
  termFg: '#d4d0cb',
  // Semantic accents — sparingly, never alarm
  add: '#3E5641',
  addWash: 'rgba(62,86,65,0.08)',
  remove: '#7C6A86',
  removeWash: 'rgba(124,106,134,0.08)',
  notice: '#9B7B5A',
} as const

/** 4px base scale. Values are pixels. */
export const space = {
  1: 4,
  2: 6,
  3: 8,
  4: 12,
  5: 16,
  6: 20,
  7: 24,
  8: 32,
} as const

/** Corner radii in pixels. */
export const radius = {
  sm: 3,
  chip: 9,
  md: 6,
  card: 8,
  field: 10,
  lg: 12,
} as const

export const font = {
  serif: "'Literata Variable', Georgia, serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
} as const

export const shadow = {
  modal: '0 20px 60px rgba(38,35,32,0.25)',
  panel: '-4px 0 24px rgba(38,35,32,0.12)',
  toast: '0 4px 20px rgba(38,35,32,0.16)',
} as const

/**
 * Type ramp — spread into a style object, e.g. `style={{ ...type.title }}`.
 * Sizes in px; serif for reading + titles, sans for chrome, mono for machinery.
 */
export const type = {
  display: { fontFamily: font.serif, fontSize: 18, fontWeight: 400 },
  title: { fontFamily: font.serif, fontSize: 15, fontWeight: 600 },
  body: { fontFamily: font.sans, fontSize: 13, fontWeight: 400 },
  label: {
    fontFamily: font.sans,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  meta: { fontFamily: font.sans, fontSize: 11, fontWeight: 400 },
  micro: { fontFamily: font.sans, fontSize: 10, fontWeight: 600 },
  mono: { fontFamily: font.mono, fontSize: 13, fontWeight: 400 },
} as const

export const tokens = { color, space, radius, font, shadow, type } as const
export default tokens
