import { describe, it, expect } from 'vitest'
import { driftBadgeLabel, reconcileTooltip } from './NavRail'

// Pure helpers behind the calm drift badge on the Check rail item (TIN-1761).

describe('driftBadgeLabel', () => {
  it('renders small counts verbatim, no plus, no icon', () => {
    expect(driftBadgeLabel(1)).toBe('1')
    expect(driftBadgeLabel(5)).toBe('5')
    expect(driftBadgeLabel(9)).toBe('9')
  })

  it('caps display at "9+" past nine', () => {
    expect(driftBadgeLabel(10)).toBe('9+')
    expect(driftBadgeLabel(42)).toBe('9+')
  })

  it('boundary: exactly 9 is not capped', () => {
    expect(driftBadgeLabel(9)).toBe('9')
    expect(driftBadgeLabel(10)).toBe('9+')
  })
})

describe('reconcileTooltip', () => {
  it('uses the singular for one', () => {
    expect(reconcileTooltip(1)).toBe('Consistency · 1 to reconcile')
  })

  it('uses the plural for more than one', () => {
    expect(reconcileTooltip(3)).toBe('Consistency · 3 to reconcile')
  })
})
