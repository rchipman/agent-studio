import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates spaces (fires)', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('strips punctuation and collapses whitespace (does not pass junk through)', () => {
    expect(slugify('Feedback: picker  pattern!!')).toBe('feedback-picker-pattern')
  })

  it('preserves digits and existing hyphens', () => {
    expect(slugify('TIN-1641 test 2')).toBe('tin-1641-test-2')
  })

  it('drops non-ascii characters (edge: unicode)', () => {
    expect(slugify('Café déjà vu')).toBe('caf-dj-vu')
  })

  it('returns empty for empty or whitespace-only input (edge)', () => {
    expect(slugify('')).toBe('')
    expect(slugify('   ')).toBe('')
  })
})
