/**
 * theme.ts
 *
 * Light/dark theme controller (TIN-1673). The whole app themes through the CSS
 * custom properties in app/globals.css; this module only flips the
 * `data-theme` attribute on <html> and remembers the user's choice.
 *
 *   - preference is 'light' | 'dark' | 'system' (default 'system'), persisted in
 *     localStorage (which Tauri keeps across restarts).
 *   - 'system' resolves against `prefers-color-scheme` and follows OS changes live.
 */

export type ThemePref = 'light' | 'dark' | 'system'

const KEY = 'agent-studio-theme'

/** The persisted preference, defaulting to 'system'. */
export function getThemePref(): ThemePref {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/** Resolve a preference to a concrete theme, consulting the OS for 'system'. */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return pref
}

/** Apply a preference to the document (sets `data-theme` on <html>). */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolveTheme(pref))
}

// ── Change notification (so Settings reflects the live choice) ──────────────────

type Listener = (pref: ThemePref) => void
const listeners = new Set<Listener>()

/** Subscribe to preference changes; returns an unsubscribe fn. */
export function subscribeTheme(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Set and persist the preference, apply it, and notify subscribers. */
export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    /* ignore quota / unavailable */
  }
  applyTheme(pref)
  listeners.forEach((l) => l(pref))
}

// ── Init (call once on app mount) ───────────────────────────────────────────────

let started = false

/** Apply the saved theme and start following OS changes while in 'system'. */
export function initTheme(): void {
  if (started || typeof window === 'undefined') return
  started = true
  applyTheme(getThemePref())
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  mql.addEventListener('change', () => {
    if (getThemePref() === 'system') applyTheme('system')
  })
}
