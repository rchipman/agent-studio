# Agent Studio — Independent Code Review (Fable, via Poppy persona)

*Conducted 2026-07-11 by Claude Fable 5, prompted as Poppy. Scope: full Rust
core (search, terminal, settings, capabilities, cli, continuity, audit,
frontmatter, reason, hybrid, salience), Tauri config, frontend workspace and
key components, tests, and both manifests. ~18k lines Rust, ~17k lines TS.
Five axes: Security, Usability, Code Quality, Reasoning Quality, Agent
Usefulness (the latter two added specifically for this run).*

---

## 1. Security — **C+**

SQL and process-spawn hygiene are good, but the app runs with a null CSP,
exposes unvalidated command-execution and secret-reveal Tauri commands to the
webview, and has unsanitized path joins in every file-creation path —
acceptable today only because it's a single-user local tool.

**Positive findings**

- Parameterized SQL everywhere; FTS5 queries are quote-escaped before MATCH (`search.rs:599,714`).
- `spawn_agent` uses `Command::new(cmd).args(vec)` — an argument vector, never a shell string (`terminal.rs:74-83`).
- Secrets done right at the storage layer: keychain only, never the settings store, explicit `status` vs `reveal` split (`settings.rs:183-307`, `linear.rs`).
- The CLI treats all caller input as data — no shell-outs, content written via `fs::write`.

**Opportunities**

1. **Null CSP + arbitrary command execution = webview compromise is RCE.** `tauri.conf.json` sets `"csp": null`, and `spawn_agent` (`terminal.rs:66`) accepts any `command`/`args`/`cwd` from JS with zero validation. `react-markdown` without `rehype-raw` is the only backstop. Fix: real CSP, and `spawn_agent` should accept an agent *name* resolved server-side from settings.
2. **`reveal_embedding_key` / `reveal_linear_key` are plain invokable commands** — the doc comment says "never call except in response to a deliberate user Reveal" but nothing enforces it (`settings.rs:298-299`).
3. **Path traversal in every create path.** `create_file` joins unsanitized input (`search.rs:993-996`); same for `write_prompt` (`launcher.rs:423`) and CLI `--project` (`cli.rs:269`). `read_prompt` reads any absolute path — an arbitrary-file-read command exposed to the webview (`launcher.rs:264-267`).
4. Dead broad permissions: `capabilities/default.json` grants `$HOME/**` recursive read+write and shell execute/spawn that the code sidesteps — pure attack surface.
5. YAML frontmatter injection (low severity): unsanitized interpolation in `render_file`/`render_frontmatter`.

---

## 2. Usability — **B**

The degrade-gracefully philosophy is executed with unusual consistency and the
GUI's error language is humane, but the main search path fails silently and
the CLI has real sharp edges for its primary (scripted) callers.

**Positive findings**

- Genuine degrade-gracefully system: BM25 fallback with a log line not a user error; continuity returns `degraded: true`; actionable failure messages.
- Long passes stream progress events; audits are cancellable with partial findings.
- Failure-preserving UX ("Could not create the file. Your work is still here."); calm, never-red continuity notices.
- File watcher auto-reindexes on out-of-band changes.

**Opportunities**

1. **Search failures are invisible** — `runSearch` only `console.error`s (`page.tsx:621-632`); the app's primary interaction deserves a Toast.
2. **`agent-studio-memory --help` launches the GUI** — no help arm in the CLI dispatcher (`cli.rs:86-113`).
3. **The flag parser eats flags** — `cornerstones --neglected --k 5` silently drops `--k` (`cli.rs:60-74`). Order-dependent silent misbehavior.
4. Unknown flags silently ignored by design — `--porject attic` routes to `shared/` with no warning.
5. `MEMORY_ROOT` hardcoded to a personal absolute path in `page.tsx:50`, despite a working settings system.
6. `recall` emits `"score": 0.0` on every hit as a documented placeholder — worse than no field.

---

## 3. Code Quality — **A-**

One of the more disciplined codebases reviewed — pure testable cores behind
thin command shims, exceptional module documentation with ticket provenance,
real concurrency care — held back by cross-module duplication and a
full-rebuild indexing strategy.

**Positive findings**

- Pure core / thin Tauri-shim separation applied consistently; lock-phase discipline documented with the production incident that motivated it (`lib.rs:104-130`).
- ~290 Rust tests testing judgment, not just CRUD; `JUDGE_GOLDEN` labeled set with a confusion-matrix gate is a standout (`audit.rs:560-631`).
- Module headers explain *why*, with ticket refs throughout.
- Lean, inline-justified dependencies on both Rust and TS sides.

**Opportunities**

1. `score_content` vs `score_content_conn` — ~80-line copy-paste (`continuity.rs:195-279` vs `291-372`).
2. Five-way helper duplication (`pod_string`, `yaml_list`, `collect_md_files`, `known_projects`) across `search.rs`/`launcher.rs`/`frontmatter.rs`/`cli.rs` — escaping behavior has already drifted between copies.
3. Every write triggers a full index rebuild (`search.rs:420-489`) — fine at hundreds of notes, O(N) at thousands; the incremental machinery exists in `maintenance.rs` but the index doesn't use it.
4. `today_iso` hand-rolls a date algorithm to avoid chrono — which is already a dependency, used for the same thing elsewhere.
5. `Cargo.toml` metadata still placeholder (`authors = ["you"]`, empty license) despite a real MIT LICENSE.
6. Four frontend components at 1,300-1,650 lines — logic is extracted to `lib/` well, but these are where future regressions will hide.

---

## 4. Reasoning Quality — **B+** (with one likely live bug)

The judgment architecture — similarity finds *related*, LLM judges *truth*,
with an evaluated prompt and a golden-set gate — is genuinely well-designed,
but the harness has one lenient parser that can convert a chatty model into
universal false conflicts, and this plausibly explains today's 0.0-score
incident.

**Positive findings**

- `AUDIT_SYSTEM` (`audit.rs:214-234`) is a properly engineered judgment prompt: crisp contradiction definition, explicit not-a-conflict rules, conservative bias, strict output contract — iterated against data (the comment records that chain-of-thought measurably *lowered* discrimination on small local models).
- `JUDGE_GOLDEN` (14 labeled cases) with a zero-false-negative gate; verdict cache keys on `(body_hash, model)` so a model swap auto-invalidates — **TIN-1789's Gemini swap inherits correct cache behavior for free.**
- Correct, non-obvious scoring decisions: similarity never lowers score; degraded path floored at 0.5 and never invents conflicts; model-only frontmatter inference capped at 0.75 with a well-reasoned disagreement ladder.

**Opportunities**

1. **`parse_conflicts` matches `"conflict:"` anywhere in any line** (`audit.rs:237-250`). A verbose model answering *"There is no conflict: both notes agree on the price"* produces a **false conflict**. With 8 neighbours judged per write and a 0.35 penalty per conflict, three chatty "no conflict:" responses → score 0.0. **The degraded path can never produce 0.0 (floored at 0.5) — so every 0.0 seen today was a *judged* conflict, and this parser is the prime suspect.** One-line fix: require line-start match, stop at a leading `NONE`. → **ticketed, see below**
2. `add-memory`'s JSON omits the `degraded` field that `check` includes (`cli.rs:312-317` vs `908-912`) — loses the one bit that distinguishes "model down" from "your note contradicts everything."
3. Conflict counting conflates replication with independence — one reversed decision echoed in three notes scores identically to three genuinely separate contradictions.
4. `contradicted_decision` and `why` are populated from the same model sentence (`continuity.rs:262-267`) — schema promises two distinct fields, gets one.
5. Temporal decay keys on `created`, not `updated` — an actively-maintained note decays as if abandoned.
6. Prompt-size inconsistency: audit judge truncates to 1,500 chars; summarize/suggest prompts send the full note untruncated.

---

## 5. Agent Usefulness — **B**

The core loop is genuinely agent-shaped — the tool renders frontmatter itself
so an agent *cannot* produce schema errors, `recall --about` reconstructs
decision history in one call, provenance/supersede semantics are right — but
CLI discoverability and output-contract inconsistencies still force guesswork
on exactly the callers it exists for.

**Positive findings**

- **The agent can't get the schema wrong** — `add-memory` does rule-based frontmatter inference + flag overrides + slugify + collision-safe filenames + valid YAML, all in the tool (`cli.rs:219-318`). Right division of labor vs. asking an LLM to hand-write frontmatter.
- `recall --about` → `{resolved, related, audit, chain}` in one call is the standout: a fresh session reconstructs "how did we get here" without N round-trips.
- Never-fail write guarantee is honored in implementation: embedding/summary/scoring/read-tracking are all individually degrade-safe around the committed write.
- Provenance rows and read-count-driven salience give multi-agent teams real accountability.
- Would the reviewer use it? "For the write path and `--about`: yes, genuinely — it beats hand-managing a notes folder."

**Opportunities**

1. Zero discoverability from the binary — no help output, and JSON contracts live only in README/CLAUDE.md prose. The parser's silent-ignore means wrong flag guesses *appear to succeed*.
2. Inconsistent output contracts across subcommands (`recall` bare array vs. `recall --about` object; `degraded` present/absent; hardcoded `score: 0.0`) — each inconsistency is a branch in every calling skill's parsing code.
3. `recall` bumps read counts on every hit, feeding salience — so retrieval isn't idempotent; a polling/retrying agent distorts its own "cornerstones" signal.
4. The deferred MCP wrapper is the right call, but until then every consumer re-implements JSON parsing in prose instructions.

---

## Overall summary

What stands out most is the engineering culture in this codebase: pure cores
behind thin shims, documented lock discipline born from a real production
incident, a golden-set gate on the LLM judge, and degrade-gracefully executed
uniformly across a dozen failure modes — strong work for a solo-built internal
tool. The two things that cut against it: a security posture that fully
trusts the webview (null CSP, unvalidated `spawn_agent`, invokable
key-reveal, traversable path joins), and a handful of harness flaws around
otherwise well-designed reasoning. **If one finding gets acted on today, it's
`parse_conflicts` (`audit.rs:237`)** — the substring match turns any model
response containing "no conflict:" into a false conflict, it plausibly *is*
the root cause of today's continuityScore-0.0 incident, and critically: **it
will bite the Gemini backend in TIN-1789 just as hard as it bit Ollama** —
this is a harness bug, not a model-capability gap, so the Gemini swap alone
will not fix the symptom that motivated it.
