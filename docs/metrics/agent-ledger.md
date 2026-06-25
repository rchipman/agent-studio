# Agent ledger — Agent Studio batch (2026-06-20)

Orchestration record for the 8-ticket build wave (TIN-1626, 1629, 1633, 1634,
1635, 1636, 1637, 1640). Columns: agent | type | model | actual tokens | tools |
dur(s) | outcome | self-report fit | adjustment.

| Agent / purpose | type | model | tokens | tools | dur | outcome | fit | adjustment |
|---|---|---|---|---|---|---|---|---|
| Jonny holistic design spec | design | opus | 59.4k | 11 | 182 | BLESSED | right | keep opus for design decisions |
| TIN-1626 Linear webview | build | sonnet | 49.3k | 42 | 240 | CHANGES (ticket-switch fix) | right | sonnet right for well-spec'd swaps |
| TIN-1634 quick capture | build | sonnet | 46.6k | 15 | 113 | BLESSED (2 fixes) | right | — |
| 1634 jonny-lite | review | sonnet | 21.5k | 5 | 39 | found 2 nits | **over-powered** | **drop conformance reviews to haiku** |
| TIN-1637 settings | build | opus | 86.2k | 45 | 365 | BLESSED (2 fixes) | right | opus right for config/secure-store/backend |
| 1637 jonny-lite | review | haiku | 32.3k | 3 | 26 | found 2 nits | right | haiku confirmed for conformance |
| TIN-1640 panel system | build | opus | 108.6k | 44 | 496 | BLESSED (token nits) | right | opus right for the page.tsx keystone refactor |
| 1640 jonny-lite | review | sonnet | 42.3k | 5 | 53 | found token nits | right | (haiku would likely suffice) |
| TIN-1635 diff | build | sonnet | 73.5k | 30 | 275 | BLESSED (title fix) | right | sonnet right for medium feature + Rust |
| 1635 jonny-lite | review | haiku | 30.9k | 3 | 15 | found 1 nit | right | haiku ideal |
| TIN-1636 transcripts | build | sonnet | 76.5k | 37 | 360 | BLESSED (no changes) | right | sonnet right; clean first pass |
| TIN-1633 launcher (north star) | build | opus | 108.6k | 61 | 565 | BLESSED (nits) | right | opus right for the centerpiece + live spawn |
| 1633 jonny-lite | review | sonnet | 35.6k | 3 | 54 | found nits | right | (haiku would suffice) |
| 1636 jonny-lite | review | haiku | 31.7k | 3 | 14 | BLESSED | right | haiku ideal |
| Jonny design: nav chrome (1707/1708/1709) | design | opus | 66.7k | 12 | 176 | BLESSED | right | opus right; caught a doc-rule reversal + terminal token gap a cheaper model would miss |
| TIN-1707+1708 build (Launch destination + persistent bar) | build | opus | 170.6k | 102 | 657 | BLESSED (1 nit) | right | opus right for the page.tsx keystone refactor (ViewShell retire + slot-context across 5 views + Launcher-as-view) |
| 1707/1708 jonny-lite | review | haiku | 78.5k | 20 | 43 | found 1 nit (missing title attr) | right | haiku confirmed for conformance again |
| Jonny design: Sessions cosmetic cleanup | design | opus | 75.0k | 11 | 145 | BLESSED | right | briefed before user clarified intent; cosmetic spec (slug decode, naming, --notice-wash) still reusable |
| Jonny design: threaded subagent reader | design | opus | 64.2k | 6 | 121 | BLESSED | right | opus right; nailed the reading model + a complete Rust backend contract a cheaper model would under-spec |
| Cleo: agent-memory landscape research | research | opus | 31.8k | 13 | 113 | BLESSED | right | honest novelty read; landscape table + steal-list + sources |
| Jonny design: living-memory epic (6 surfaces) | design | opus | 75.5k | 18 | 175 | BLESSED | right | hit the hard constraint — ZERO new primitives across 6 surfaces, both themes via tokens |
| TIN-1730 continuity scorer | build | opus | 78.7k | 38 | 369 | BLESSED (0 changes) | **over-powered** | **reuse-compose Rust w/ a tight reading list → try sonnet next**; also caught a wrong specta ref in the ticket |
| TIN-1728 audit-trail backend | build | opus | 89.8k | 19 | 233 | BLESSED (0 changes) | over-powered | same class — drop to sonnet |
| TIN-1729 Linear ingest backend | build | **sonnet** | 85.7k | 23 | 349 | BLESSED (0 changes) | **right** | downgrade validated — sonnet nailed the GraphQL+keychain+index integration to a precise spec |

## Learnings → routing adjustments

- **Conformance reviews → haiku.** Every haiku jonny-lite (1637, 1635, 1636) came back "right" and caught the same class of nits (raw rgba vs token, copy drift, radius drift) the sonnet ones did. The one sonnet review self-reported **over-powered**. Standing change: all jonny-lite to haiku; escalate to full Jonny only on a real design question.
- **Build routing held.** sonnet for well-spec'd components + medium Rust; opus for load-bearing/architectural (settings backend, the panel refactor, the launcher). Every build self-reported "right" — no thin/under-powered, no over-powered. Routing table validated.
- **Recurring nit:** builders repeatedly hardcoded `rgba(155,123,90,0.08)` (a notice-wash) and chip radii instead of tokens. The token set lacked a notice-wash token. Worth adding `color.noticeWash` so it stops recurring.

## Process gotcha

- **Parallel worktree `npm install` cross-contaminates the lockfile.** The settings builder's `npm install` (adding `@tauri-apps/plugin-store`) leaked into the panel branch's `package.json`/lock even though the panel needs no new dep. Always diff `package.json` vs main before merging a worktree branch and strip spurious deps. (Caught and stripped on the 1640 branch.)

## Spine (orchestrator) cost — the other half of the ledger

The ledger above tracks **subagent** tokens. The **orchestrator/spine** cost is recoverable from the session transcript (`~/.claude/projects/<proj>/<session>.jsonl`) — each assistant turn carries `message.usage` (input / output / cache_creation / cache_read). Same data TIN-1725 already parses.

- **Session 2026-06-24 (this long-EM session, ~mid):** 3,247 turns · fresh input 0.40M · cache-write 25.3M · cache-read **1,554.9M** · output 5.16M. Cache hit ratio **98.4%**. Cost-weighted input-equiv ≈ **187M** vs **~1,581M** uncached → caching absorbs ~88% (~8×) of the long-session context cost.
- **Takeaway:** long-running EM sessions are *not* significantly less efficient than scoped sessions **while cache-warm**; the killer is idle gaps past the ~5-min cache TTL (forces full-price re-reads). Recommend EM for cohesive, *active* bodies of work; scoped for independent tickets.
- TODO (TIN below): automate this rollup so spine cost is logged per session, not computed by hand.
