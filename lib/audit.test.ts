import { describe, it, expect } from 'vitest'
import { statusToReadout } from './audit'

// The status → readout mapping behind the ambient consistency view (TIN-1761).

describe('statusToReadout', () => {
  it('an unseeded base invites the one-time seed', () => {
    expect(statusToReadout({ seeded: false, count: 0 })).toBe('unseeded')
    // count is meaningless before seeding; still unseeded.
    expect(statusToReadout({ seeded: false, count: 4 })).toBe('unseeded')
  })

  it('seeded with findings reads the maintained table', () => {
    expect(statusToReadout({ seeded: true, count: 1 })).toBe('fresh-findings')
    expect(statusToReadout({ seeded: true, count: 12 })).toBe('fresh-findings')
  })

  it('seeded with zero findings is the calm all-agree state', () => {
    expect(statusToReadout({ seeded: true, count: 0 })).toBe('fresh-clear')
  })
})
