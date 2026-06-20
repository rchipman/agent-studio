import { describe, it, expect } from 'vitest'
import { flattenFiles } from './flattenTree'
import type { FileNode } from './types'

const file = (name: string, path: string): FileNode => ({ name, path, type: 'file' })
const dir = (name: string, path: string, children: FileNode[]): FileNode => ({
  name,
  path,
  type: 'dir',
  children,
})

describe('flattenFiles', () => {
  it('collects files in tree order, recursing into dirs (fires)', () => {
    const tree = [
      file('a.md', '/a.md'),
      dir('sub', '/sub', [file('b.md', '/sub/b.md'), file('c.md', '/sub/c.md')]),
      file('d.md', '/d.md'),
    ]
    expect(flattenFiles(tree).map((n) => n.path)).toEqual([
      '/a.md',
      '/sub/b.md',
      '/sub/c.md',
      '/d.md',
    ])
  })

  it('excludes directory nodes themselves (does not include dirs)', () => {
    const out = flattenFiles([dir('sub', '/sub', [file('b.md', '/sub/b.md')])])
    expect(out.every((n) => n.type === 'file')).toBe(true)
    expect(out).toHaveLength(1)
  })

  it('handles empty input and childless dirs (edge)', () => {
    expect(flattenFiles([])).toEqual([])
    expect(flattenFiles([dir('empty', '/empty', [])])).toEqual([])
  })
})
