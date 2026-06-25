import { describe, it, expect } from 'vitest'
import {
  composeBundle,
  composeAgentArgs,
  stripFrontmatter,
  parseFrontmatterContext,
  parseFrontmatterSystemFacts,
  systemFactsToList,
  systemFactsFromList,
  defaultSystemFacts,
  resolveFacts,
  formatStamp,
  formatDate,
  contextItemToRef,
  SYSTEM_FRAMING,
} from './launcher'
import type { Agent } from './settings'

describe('stripFrontmatter', () => {
  it('removes a leading YAML block (fires)', () => {
    const raw = '---\nname: x\ntype: feedback\n---\n\nBody text here.'
    expect(stripFrontmatter(raw)).toBe('Body text here.')
  })

  it('leaves content without frontmatter untouched (does not fire)', () => {
    expect(stripFrontmatter('Just a body.')).toBe('Just a body.')
  })

  it('returns the input when the block is unterminated (edge)', () => {
    const raw = '---\nname: x\nno closing delimiter'
    expect(stripFrontmatter(raw)).toBe(raw)
  })
})

describe('composeBundle', () => {
  it('puts the prompt first, then context grouped skill -> memory -> file (fires)', () => {
    const ctx = [
      { kind: 'file' as const, path: '/c.md', label: 'CLAUDE.md', body: 'file body' },
      { kind: 'skill' as const, path: '/s.md', label: 'Jonny', body: 'skill body' },
      { kind: 'memory' as const, path: '/m.md', label: 'note', body: 'memory body' },
    ]
    const out = composeBundle('My Prompt', 'prompt body', ctx)
    expect(out).toContain('# My Prompt')
    const iSkill = out.indexOf('Persona / skill: Jonny')
    const iMem = out.indexOf('Memory: note')
    const iFile = out.indexOf('Project file: CLAUDE.md')
    expect(iSkill).toBeGreaterThan(-1)
    expect(iSkill).toBeLessThan(iMem)
    expect(iMem).toBeLessThan(iFile)
  })

  it('strips frontmatter from the prompt and every context body (edge)', () => {
    const out = composeBundle('P', '---\nx: 1\n---\nclean prompt', [
      { kind: 'skill' as const, path: '/s', label: 'S', body: '---\ny: 2\n---\nclean skill' },
    ])
    expect(out).toContain('clean prompt')
    expect(out).toContain('clean skill')
    expect(out).not.toContain('x: 1')
    expect(out).not.toContain('y: 2')
  })

  it('emits no context dividers when there is no context (does not fire)', () => {
    const out = composeBundle('Solo', 'only body', [])
    expect(out).toContain('# Solo')
    expect(out).not.toContain('## Persona')
    expect(out).not.toContain('## Memory')
  })
})

const agent = (args: string[]): Agent => ({ name: 'claude', command: 'claude', args, cwd: '' })

describe('composeAgentArgs', () => {
  it('substitutes the {bundle} token in place when present (fires)', () => {
    expect(composeAgentArgs(agent(['--file', '{bundle}', '--flag']), '/tmp/b.md')).toEqual([
      '--file',
      '/tmp/b.md',
      '--flag',
    ])
  })

  it('appends the path as a trailing arg when no token is present (other branch)', () => {
    expect(composeAgentArgs(agent(['--resume']), '/tmp/b.md')).toEqual(['--resume', '/tmp/b.md'])
  })

  it('replaces every occurrence of the token (edge)', () => {
    expect(composeAgentArgs(agent(['{bundle}', '{bundle}']), '/b')).toEqual(['/b', '/b'])
  })
})

// ── TIN-1764: system tier + authoring helpers ──────────────────────────────────

describe('composeBundle — system tier', () => {
  it('emits a single fenced SYSTEM CONTEXT block after all user content (fires)', () => {
    const out = composeBundle(
      'P',
      'user body',
      [
        { kind: 'skill' as const, path: '/s', label: 'Jonny', body: 'skill body' },
        { kind: 'file' as const, path: '/f', label: 'cfg', body: 'sys file body', system: true },
      ],
      [{ label: 'time of input', value: '2026-06-25 09:14 PST' }],
    )
    const iUser = out.indexOf('Persona / skill: Jonny')
    const iSys = out.indexOf('# SYSTEM CONTEXT')
    expect(iUser).toBeGreaterThan(-1)
    expect(iSys).toBeGreaterThan(iUser) // system comes after user content
    expect(out).toContain(SYSTEM_FRAMING)
    expect(out).toContain('time of input: 2026-06-25 09:14 PST')
    expect(out).toContain('## SYSTEM — File: cfg')
    // exactly one SYSTEM CONTEXT fence
    expect(out.match(/# SYSTEM CONTEXT/g)?.length).toBe(1)
  })

  it('omits the SYSTEM block entirely when no system items and no facts (does not fire)', () => {
    const out = composeBundle('P', 'body', [
      { kind: 'skill' as const, path: '/s', label: 'S', body: 'b' },
    ])
    expect(out).not.toContain('# SYSTEM CONTEXT')
  })

  it('emits the SYSTEM block for facts alone, with no user-context dividers (edge)', () => {
    const out = composeBundle('P', 'body', [], [{ label: 'date', value: '2026-06-25' }])
    expect(out).toContain('# SYSTEM CONTEXT')
    expect(out).toContain('date: 2026-06-25')
    expect(out).not.toContain('## Persona')
  })
})

describe('parseFrontmatterContext', () => {
  it('parses a context list of kind/ref pairs (fires)', () => {
    const raw = '---\nname: P\ncontext:\n  - kind: skill\n    ref: jonny\n  - kind: memory\n    ref: studio/x.md\n---\nbody'
    expect(parseFrontmatterContext(raw)).toEqual([
      { kind: 'skill', ref: 'jonny' },
      { kind: 'memory', ref: 'studio/x.md' },
    ])
  })

  it('drops unknown kinds and returns [] without a context block (edge)', () => {
    const bad = '---\ncontext:\n  - kind: bogus\n    ref: x\n---\nb'
    expect(parseFrontmatterContext(bad)).toEqual([])
    expect(parseFrontmatterContext('no frontmatter')).toEqual([])
  })
})

describe('system_facts frontmatter round-trip', () => {
  it('writes only on-facts and parses them back (fires)', () => {
    const facts = { time: true, date: false, cwd: true, agent: false }
    const list = systemFactsToList(facts)
    expect(list).toEqual(['time', 'cwd'])
    expect(systemFactsFromList(list)).toEqual(facts)
  })

  it('parses an inline list value from frontmatter (edge)', () => {
    const raw = '---\nname: P\nsystem_facts: [time]\n---\nb'
    expect(parseFrontmatterSystemFacts(raw)).toEqual(['time'])
  })

  it('defaults time on and the rest off', () => {
    expect(defaultSystemFacts()).toEqual({ time: true, date: false, cwd: false, agent: false })
  })
})

describe('resolveFacts + formatStamp', () => {
  it('stamps time of input as YYYY-MM-DD HH:MM with a zone (fires)', () => {
    const d = new Date(2026, 5, 25, 9, 4)
    const stamp = formatStamp(d)
    expect(stamp).toMatch(/^2026-06-25 09:04( .+)?$/)
    expect(formatDate(d)).toBe('2026-06-25')
  })

  it('resolves only the on-facts in order (edge)', () => {
    const facts = resolveFacts(
      { time: true, date: false, cwd: true, agent: true },
      { cwd: '/work', agentName: 'claude' },
      new Date(2026, 5, 25, 9, 4),
    )
    expect(facts.map((f) => f.label)).toEqual(['time of input', 'working directory', 'agent name'])
    expect(facts.find((f) => f.label === 'working directory')?.value).toBe('/work')
  })
})

describe('contextItemToRef', () => {
  it('makes skill/memory refs root-relative and files absolute (fires)', () => {
    const roots = { skillsRoot: '/skills', memoryRoot: '/mem' }
    expect(contextItemToRef({ kind: 'skill', path: '/skills/jonny/SKILL.md', label: 'Jonny' }, roots)).toEqual({
      kind: 'skill',
      ref: 'jonny/SKILL.md',
    })
    expect(contextItemToRef({ kind: 'memory', path: '/mem/studio/x.md', label: 'x' }, roots)).toEqual({
      kind: 'memory',
      ref: 'studio/x.md',
    })
    expect(contextItemToRef({ kind: 'file', path: '/abs/cfg.toml', label: 'cfg' }, roots)).toEqual({
      kind: 'file',
      ref: '/abs/cfg.toml',
    })
  })
})
