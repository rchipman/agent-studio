import { describe, it, expect } from 'vitest'
import {
  formatTokens,
  formatCost,
  estimateCost,
  totalTokens,
  RATES_PER_M,
  type UsageRollup,
} from './sessionMetrics'

// ── formatTokens ─────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('formats millions with one decimal (fires)', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('drops the decimal when it is zero (edge)', () => {
    expect(formatTokens(2_000_000)).toBe('2M')
  })

  it('formats thousands (fires)', () => {
    expect(formatTokens(48_000)).toBe('48k')
  })

  it('formats sub-thousand as plain number (fires)', () => {
    expect(formatTokens(900)).toBe('900')
    expect(formatTokens(0)).toBe('0')
  })

  it('formats fractional thousands with one decimal (edge)', () => {
    expect(formatTokens(1_500)).toBe('1.5k')
  })

  it('formats 999 999 as sub-million — rounds up to 1000k (edge)', () => {
    // 999_999 < 1_000_000 so stays in the k branch; 999.999 rounds to 1000k
    expect(formatTokens(999_999)).toBe('1000k')
  })
})

// ── formatCost ───────────────────────────────────────────────────────────────

describe('formatCost', () => {
  it('starts with the estimate prefix (fires)', () => {
    expect(formatCost(0.05)).toMatch(/^≈/)
  })

  it('rounds to 2 decimal places for amounts >= $0.01 (fires)', () => {
    expect(formatCost(1.2567)).toBe('≈ $1.26')
    // 0.025 rounds to $0.03 (unambiguous two-decimal round)
    expect(formatCost(0.025)).toBe('≈ $0.03')
  })

  it('uses 3 decimal places for sub-cent amounts (edge)', () => {
    expect(formatCost(0.005)).toBe('≈ $0.005')
  })

  it('uses 4 decimal places for very small amounts (edge)', () => {
    expect(formatCost(0.00034)).toBe('≈ $0.0003')
  })
})

// ── estimateCost ─────────────────────────────────────────────────────────────

describe('estimateCost', () => {
  it('returns 0 for zero usage (edge)', () => {
    const empty: UsageRollup = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }
    expect(estimateCost(empty)).toBe(0)
  })

  it('calculates cost for known usage rollup (fires)', () => {
    // 1M input at $3/M = $3.00
    // 100k output at $15/M = $1.50
    // 200k cache-write at $3.75/M = $0.75
    // 500k cache-read at $0.30/M = $0.15
    // total = $5.40
    const usage: UsageRollup = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationInputTokens: 200_000,
      cacheReadInputTokens: 500_000,
    }
    const cost = estimateCost(usage)
    expect(cost).toBeCloseTo(5.40, 5)
  })

  it('applies correct per-token rate (does not mix up input/output)', () => {
    const outputOnly: UsageRollup = {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }
    expect(estimateCost(outputOnly)).toBeCloseTo(RATES_PER_M.output, 5)
  })
})

// ── totalTokens ──────────────────────────────────────────────────────────────

describe('totalTokens', () => {
  it('sums all token categories (fires)', () => {
    const usage: UsageRollup = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    }
    expect(totalTokens(usage)).toBe(2000)
  })
})
