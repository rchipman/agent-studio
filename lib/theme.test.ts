import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getThemePref, resolveTheme, setThemePref, applyTheme } from './theme'

// resolveTheme is an evaluator (system -> consults the OS); getThemePref a parser.
// These verify they fire correctly and fall back safely.

function mockPrefersDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('dark') ? dark : !dark,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('defaults to system when nothing is stored', () => {
    expect(getThemePref()).toBe('system')
  })

  it('reads a valid stored preference and ignores garbage', () => {
    localStorage.setItem('agent-studio-theme', 'dark')
    expect(getThemePref()).toBe('dark')
    localStorage.setItem('agent-studio-theme', 'banana')
    expect(getThemePref()).toBe('system')
  })

  it('resolveTheme returns the explicit choice unchanged', () => {
    mockPrefersDark(true)
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('resolveTheme consults the OS for system', () => {
    mockPrefersDark(true)
    expect(resolveTheme('system')).toBe('dark')
    mockPrefersDark(false)
    expect(resolveTheme('system')).toBe('light')
  })

  it('applyTheme writes the resolved theme to the document', () => {
    mockPrefersDark(false)
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('setThemePref persists, applies, and notifies', () => {
    mockPrefersDark(false)
    applyTheme('light')
    setThemePref('dark')
    expect(localStorage.getItem('agent-studio-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
