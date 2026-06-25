import { describe, it, expect } from 'vitest'
import { decodeProjectLabel, disambiguate } from './decodeProjectLabel'

describe('decodeProjectLabel', () => {
  it('prefers the real cwd basename (fires)', () => {
    expect(decodeProjectLabel('-Users-rob-Dev-agent-studio', '/Users/rob/Dev/agent-studio')).toBe(
      'agent-studio',
    )
  })

  it('decodes the slug last segment when there is no cwd (slug fallback)', () => {
    expect(decodeProjectLabel('-Users-rob-Dev-attic', '')).toBe('attic')
  })

  it('strips a single leading dash before splitting', () => {
    expect(decodeProjectLabel('-foo-bar-baz', '')).toBe('baz')
  })

  it('works on a slug without a leading dash (edge)', () => {
    expect(decodeProjectLabel('foo-bar', '')).toBe('bar')
  })

  it('falls back to the raw project string when the decoded label is empty (edge)', () => {
    // A trailing dash leaves an empty last segment → raw fallback.
    expect(decodeProjectLabel('-foo-', '')).toBe('-foo-')
  })

  it('ignores a whitespace-only cwd and decodes the slug instead (edge)', () => {
    expect(decodeProjectLabel('-Users-rob-Dev-studio', '   ')).toBe('studio')
  })
})

describe('disambiguate', () => {
  it('leaves unique labels untouched', () => {
    const out = disambiguate([
      { project: '-Users-rob-Dev-attic', cwd: '/Users/rob/Dev/attic' },
      { project: '-Users-rob-Dev-studio', cwd: '/Users/rob/Dev/studio' },
    ])
    expect(out.get('-Users-rob-Dev-attic')).toBe('attic')
    expect(out.get('-Users-rob-Dev-studio')).toBe('studio')
  })

  it('disambiguates two same-basename projects with the parent segment (fires)', () => {
    const out = disambiguate([
      { project: '-Users-rob-app-web', cwd: '/Users/rob/app/web' },
      { project: '-Users-rob-site-web', cwd: '/Users/rob/site/web' },
    ])
    expect(out.get('-Users-rob-app-web')).toBe('app / web')
    expect(out.get('-Users-rob-site-web')).toBe('site / web')
  })

  it('disambiguates via the slug parent when no cwd is present (slug fallback)', () => {
    const out = disambiguate([
      { project: '-app-web', cwd: '' },
      { project: '-site-web', cwd: '' },
    ])
    expect(out.get('-app-web')).toBe('app / web')
    expect(out.get('-site-web')).toBe('site / web')
  })

  it('keeps the base label when colliding projects have no parent segment (edge)', () => {
    const out = disambiguate([
      { project: 'web', cwd: '' },
      { project: '-web', cwd: '' },
    ])
    // Both decode to "web" and neither has a parent → base label, no slash.
    expect(out.get('web')).toBe('web')
    expect(out.get('-web')).toBe('web')
  })
})
