/**
 * sessionMetrics.ts  (TIN-1725)
 *
 * Token-formatting and cost-estimation helpers for session usage rollups.
 *
 * Cost notes
 * ----------
 * The transcript logs carry no per-model cost data, so estimates are
 * necessarily APPROXIMATE. All tokens are summed across models; we apply a
 * single blended rate table (claude-sonnet-class, the dominant model in
 * Agent Studio sessions). Cache-read tokens are charged at the discounted
 * read rate; cache-creation tokens at the write rate (slightly above base
 * input). Display MUST use "≈" to signal the estimate nature — never present
 * these figures as precise.
 *
 * Update this table when Anthropic publishes revised rates.
 */

// ── Rate table (USD per 1 000 000 tokens) ────────────────────────────────────
//
// Blended approximation for claude-sonnet-class models (current as of 2025).
// Cache-write tokens are billed at a modest premium over base input.
// Cache-read tokens are billed at ~10 % of base input.
// Adjust when pricing changes; this is the single source of truth for cost.
//
export const RATES_PER_M = {
  input: 3.0,        // base input tokens
  output: 15.0,      // output tokens
  cacheWrite: 3.75,  // cache_creation_input_tokens (cache-write premium)
  cacheRead: 0.30,   // cache_read_input_tokens (10 % of base input)
} as const

export interface UsageRollup {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/**
 * Estimate total cost in USD from a UsageRollup.
 * Returns a number (USD); display it with a leading "≈".
 */
export function estimateCost(usage: UsageRollup): number {
  const M = 1_000_000
  return (
    (usage.inputTokens * RATES_PER_M.input) / M +
    (usage.outputTokens * RATES_PER_M.output) / M +
    (usage.cacheCreationInputTokens * RATES_PER_M.cacheWrite) / M +
    (usage.cacheReadInputTokens * RATES_PER_M.cacheRead) / M
  )
}

/**
 * Format a token count in a human-readable compact form.
 *
 * Examples:
 *   1_200_000 → "1.2M"
 *   48_000    → "48k"
 *   900       → "900"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    // One decimal place, but strip trailing ".0"
    const s = v % 1 === 0 ? `${v.toFixed(0)}M` : `${v.toFixed(1)}M`
    return s
  }
  if (n >= 1_000) {
    const v = n / 1_000
    const rounded = Math.round(v * 10) / 10
    const s = rounded % 1 === 0 ? `${rounded.toFixed(0)}k` : `${rounded.toFixed(1)}k`
    return s
  }
  return String(n)
}

/**
 * Format a cost estimate as a display string with the "≈" prefix.
 * Rounds to cents for amounts >= $0.01; to fractional cents below.
 *
 * Examples:
 *   0.00034 → "≈ $0.0003"
 *   0.015   → "≈ $0.02"
 *   1.2567  → "≈ $1.26"
 */
export function formatCost(usd: number): string {
  if (usd < 0.001) {
    return `≈ $${usd.toFixed(4)}`
  }
  if (usd < 0.01) {
    return `≈ $${usd.toFixed(3)}`
  }
  return `≈ $${usd.toFixed(2)}`
}

/**
 * Total token count (input + output + cache tokens) for summary display.
 */
export function totalTokens(usage: UsageRollup): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  )
}

/** Sum a list of usage rollups into one — for a cost/token roll-up across the
 *  visible sessions. Skips null/undefined entries. */
export function sumUsage(usages: (UsageRollup | null | undefined)[]): UsageRollup {
  const acc: UsageRollup = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  for (const u of usages) {
    if (!u) continue
    acc.inputTokens += u.inputTokens || 0
    acc.outputTokens += u.outputTokens || 0
    acc.cacheCreationInputTokens += u.cacheCreationInputTokens || 0
    acc.cacheReadInputTokens += u.cacheReadInputTokens || 0
  }
  return acc
}
