import { describe, it, expect } from 'vitest'
import { composeBundle, composeAgentArgs, stripFrontmatter } from './launcher'
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
