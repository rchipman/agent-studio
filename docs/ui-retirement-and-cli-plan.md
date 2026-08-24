# UI Retirement and CLI Evolution Plan

Author: Poppy. Date: 2026-08-11. Status: proposal — nothing here has been executed.
Companion tickets: `~/Projects/tfl/product/agent-studio/tickets-ui-retirement-and-cli-evolution.md`

---

## 0. The one urgent finding, up front

**The memory index has been broken for a month, and the failure was almost perfectly silent.**

The FTS5 full-text index inside `~/Projects/tfl/memory/.studio-index.db` is corrupt
(SQLITE_CORRUPT_VTAB). Any *write* to `memory_fts` fails with
`database disk image is malformed`, while `PRAGMA integrity_check` reports `ok` and
MATCH queries silently return zero rows. Verified by reproducing the failure on a
scratch copy of the DB (never the live file):

- `DELETE FROM memory_fts;` → `database disk image is malformed (11)`
- `INSERT INTO memory_fts(memory_fts) VALUES('rebuild');` → succeeds, and afterwards
  `MATCH 'pricing'` returns 48 rows (it returned 0 before).

Consequences, all confirmed against the live DB and the GUI log
(`~/Library/Logs/com.tinyforestlabs.agent-studio/Agent Studio.log`):

- `build_index`'s **first statement** is `DELETE FROM memory_fts; ...`, so every
  rebuild has failed since **2026-07-11 16:27** (first logged occurrence; it recurs
  through 07-14, 07-15, and the two errors agents hit today are the same failure
  surfacing through `add-memory`).
- The index is **frozen at 2026-07-11**: 784 files indexed vs **972 `.md` notes on
  disk** today; `MAX(updated)` in `memory_files` is 2026-07-11.
- **Provenance is dead**: the last `memory_audit` row is Jarvis at 2026-07-11 16:08.
  Every memory written since then either errored out of `add-memory` after the file
  landed (file written, then the rebuild step failed → error, no audit row, no
  embedding) or bypassed the CLI entirely via the documented file-write fallback.
  A month of writes has no continuity scoring, no conflict detection, no audit trail.
- `recall` did not error — it kept answering from a month-stale index, with the BM25
  leg silently contributing nothing (MATCH returns 0 rows on the corrupt index), i.e.
  vector-only search over July's embeddings. **Silent wrong answers**, exactly the
  failure mode Rob flagged as worse than no memory at all.

**Repair path (verified, cheap, non-destructive):**

1. `INSERT INTO memory_fts(memory_fts) VALUES('rebuild');` — rebuilds the FTS index
   from the intact `memory_files` content table. One statement.
2. `agent-studio-memory reindex` — catches up the ~188 unindexed notes and their
   embeddings.
3. Verify: indexed count == on-disk count, a MATCH probe returns rows, a test
   `add-memory` produces an audit row.
4. Heavier fallbacks if step 1 ever fails: `sqlite3 .recover`, or delete the DB and
   reindex from markdown — but note **the DB is not a pure cache**: `memory_audit`
   (provenance) and `memory_reads` (salience input) are the only tables *not*
   derivable from the markdown, so any nuke-and-rebuild must dump/restore those two
   tables first.

The Jul-11 → Aug-11 provenance gap is not recoverable. Accept it, record it as a
memory note, move on.

### Why it corrupted (root cause, traced not guessed)

`build_index` (`src-tauri/src/search.rs:430`) is a **full rebuild**: a
non-transactional autocommit batch `DELETE FROM memory_fts; DELETE FROM memory_files;`
followed by a *separate* transaction that re-inserts every file with **explicit
rowids** into the FTS table. This full rebuild runs on:

- GUI startup, GUI manual reindex,
- the GUI's ambient maintenance worker (its own second connection),
- **every single CLI `add-memory`, `supersede`, and `reindex`** — each CLI call
  re-reads and re-indexes all 972 files.

WAL + `busy_timeout(5s)` stops writers from *blocking* each other, but it does not
stop them *interleaving*: two processes each running delete-then-reinsert with
explicit FTS rowids can interleave their autocommit delete batch and insert
transactions, which desyncs FTS5's shadow tables — the classic SQLITE_CORRUPT_VTAB
recipe. The timeline fits exactly: corruption first logged minutes after parallel
Jarvis `add-memory` writes on Jul 11 while the GUI was also up during active dev.
Parallel persona/subagent writes (like today's) re-trigger the same race.

So the fix is not "repair and hope": the write path itself must change
(incremental per-file upsert + single-writer lock — see Part 3).

---

## Part 1 — Scoping the UI cut

### 1.1 What depends on the UI layer vs. what is independent

**Pure UI (goes away cleanly):** the entire TypeScript layer — `app/`, `components/`
(28 components incl. the Milkdown editor, FileTree, LinearPanel, TranscriptBrowser,
GraphView, CommandPalette), `lib/` (TS helpers), `e2e/`, `.next/`, `out/`, `public/`,
plus Next/Tailwind/Milkdown/Tauri-JS dependencies. **~15,300 LOC of TS** plus
`node_modules`.

**Rust core (17,670 LOC) splits cleanly:**

| Keep (CLI needs it) | LOC | UI-only (cuttable) | LOC |
|---|---|---|---|
| `cli.rs` | 2298 | `transcript.rs` (session browser) | 2147 |
| `search.rs` (index, FTS, sqlite-vec) | 1466 | `archive.rs` (zstd session archive) | 926 |
| `frontmatter.rs` | 1790 | `linear.rs` (Linear is canceled anyway) | 804 |
| `links.rs` (wiki-link graph) | 794 | `consistency.rs` (ambient GUI monitor)* | 574 |
| `continuity.rs` (scorer) | 761 | `suggestions.rs` (GUI suggest-all) | 546 |
| `maintenance.rs`* | 705 | `outcomes.rs` (session outcomes ribbon) | 356 |
| `audit.rs` (judge_pair — continuity depends on it) | 658 | `git.rs` (diff panel) | 218 |
| `embeddings.rs` | 651 | | |
| `salience.rs` | 626 | | |
| `reason.rs` (Gemini/Ollama) | 530 | | |
| `settings.rs` (trim Tauri commands) | 499 | | |
| `hybrid.rs` (ranker) | 440 | | |
| `memory_audit.rs` | 259 | | |
| `memory_reads.rs` | 221 | | |
| `local_embed.rs` (candle) | 183 | | |

\* `consistency.rs`/`maintenance.rs`: the ambient *surfaces* are GUI, but the
contradiction-sweep logic inside them is exactly what goal 4 (structural staleness
detection) needs. Keep the logic, re-home it behind a CLI `sweep` command.

Roughly: cut ~15.3k LOC TS + ~5.5k LOC UI-only Rust + the Tauri shell
(`tauri.conf.json`, `capabilities/`, `icons/`, plugins, webview glue); keep ~12k LOC
of Rust core.

**Bonus:** transcript FTS content is over half the 99 MB index DB (~47 MB). Dropping
the transcript/session tables and VACUUMing shrinks the DB to roughly a fifth of its
size.

### 1.2 Hidden UI dependencies in the CLI (the "secretly UI-dependent" audit)

Traced, not assumed. Four real ones, none fatal, all need tickets:

1. **The CLI binary IS the GUI binary.** `bin/agent-studio-memory` is a shell shim
   that `exec`s `src-tauri/target/{release,debug}/app` — the full Tauri app, with
   `cli::maybe_run()` intercepting argv before the webview starts. Cut the UI naively
   and there is no binary to exec. The clean move is a headless `memory-core` crate +
   a small bin target, not in-place surgery (see Part 3.0).
2. **Settings tier 2**: the CLI resolves the memory root as `$MEMORY_ROOT` → the
   GUI's `tauri-plugin-store` `settings.json` under
   `~/Library/Application Support/com.tinyforestlabs.agent-studio/` → default
   `~/Projects/tfl/memory`. Post-GUI, tier 2 becomes a fossil; harmless (tiers 1 and
   3 cover it) but should be replaced with a CLI-owned config file.
3. **API keys**: Gemini key resolution is OS-keychain
   (`com.agent-studio.embedding` / Gemini account) then `STUDIO_GEMINI_API_KEY` env
   var (`settings.rs:resolve_gemini_key`). Reading works headless; **setting** the
   keychain entry is currently only possible through GUI Tauri commands. Needs a
   `config set-key` subcommand (or documented env var in shell profile).
4. **The maintenance queue has no drainer without the GUI.** `build_index` — which
   every CLI write calls — enqueues change-triggered maintenance work
   (`maintenance::detect_and_dispatch`), and the **only** drain loop lives in the
   GUI's worker thread (`lib.rs:132`). Retire the UI without addressing this and
   `maintenance_queue` grows unbounded inside the DB forever. Either drain in-process
   at the end of each CLI write, or stop enqueueing and fold the handlers into the
   `sweep` command.

Also worth naming: the GUI's startup reindex + background embedding pass was the
thing keeping the index fresh when agents wrote files directly. Post-GUI, freshness
must come from the CLI itself (incremental index on write + a `doctor`/`reindex`
habit, or a cron/hook).

### 1.3 In-flight work at risk (explicit, per instruction)

- **PR #87 (TIN-1790, open, branch `jrchipman1/tin-1790-...`)** — fixes
  `parse_conflicts` false positives (line-start match for `CONFLICT:`) and **adds the
  `degraded` field to `add-memory` output**. This is *CLI* work, not UI work, and the
  degraded flag is directly on the critical path of the silent-failure problem.
  **Do not abandon — merge before or during the CLI hardening.** (55 lines in
  `audit.rs` + 5 in `cli.rs`.)
- **PR #89 (open)** — local pre-push gate (lint, type-check, test, cargo
  test/clippy). **PR #90 (open, currently checked out)** — light GitHub Actions CI.
  Both remain valuable post-cut but their gate contents reference npm/Next/Tauri
  steps that change shape when the UI goes. Recommend: merge now, then slim in the
  repo-restructure ticket — or rebase onto the restructure. A judgment call, flagged
  in tickets.
- Working tree is clean, no stashes. The ~40 other remote branches are pre-squash
  artifacts of already-merged PRs (e.g. #88/TIN-1793 is `afe0516` on main) — stale,
  not at-risk.

### 1.4 Removal footprint (rough scope)

- Delete: `app/`, `components/`, `lib/`, `e2e/`, `public/`, `.next/`, `out/`,
  `node_modules/`, Next/Tailwind/ESLint-next config, `package.json` (or reduce to a
  scripts shell), 7 UI-only Rust modules, Tauri shell config/icons/capabilities/gen,
  Tauri plugins and the `webdriver` feature.
- Restructure: extract the 15 keep-modules into a plain Rust crate with a bin target;
  `bin/agent-studio-memory` shim updates to exec the new binary (same name, same JSON
  contracts — zero change for agents).
- Keep: `docs/` (move relevant design docs), `scripts/install-cli.sh` (retarget),
  CI slimmed to `cargo test/clippy`.
- Data migration: drop transcript/session/GUI-only tables from the index DB, VACUUM.
  Keep `memory_audit` + `memory_reads` (non-derivable).

---

## Part 2 — Diagnosis of the current CLI

### 2.1 What backs the index

One SQLite file: `~/Projects/tfl/memory/.studio-index.db` (99 MB, WAL mode,
`busy_timeout` 5 s, created Jun 19). Bundled SQLite via rusqlite with **sqlite-vec**
statically linked (vector store) — no external services. Tables that matter:

- `memory_files` (784 rows; path, frontmatter fields, frontmatter-free body) +
  `memory_fts` (FTS5 over name/type/projects/tags/body) — the keyword leg.
- `chunks` (3,148 rows; per-chunk text + 384-dim `F32_BLOB` embeddings from the
  bundled local candle/BERT MiniLM-class model, downloaded once via hf-hub) — the
  semantic leg. **Real embeddings already exist; "add semantic search" is not a
  gap.**
- `memory_audit` (369 rows; who wrote what, continuity score per change) and
  `memory_reads` (read counts for salience) — the only **non-derivable** state.
- `links` (wiki-link graph), plus GUI-era freight: `transcript_*` (~47 MB),
  `consistency_findings`, `frontmatter_suggestions`, `audit_verdict_cache`,
  `maintenance_queue`, `ticket_cache`.

Corruption cause, effects, and repair: see Part 0. Not a sync-tool problem (no
`.obsidian/` in the store yet, not iCloud-placed) — it is a concurrency design
problem in `build_index`. Note for the Obsidian future: once the store becomes an
Obsidian vault, `.studio-index.db*` must be excluded from any Obsidian Sync setup —
SQLite inside a synced folder is an independent corruption vector.

### 2.2 How `recall` retrieves (concrete mechanism)

`recall --query` → `search_core`:
1. FTS5 **BM25** candidates + **sqlite-vec cosine** nearest chunks (local embedding
   of the query), aggregated per file.
2. Merge at `0.7 * bm25 + 0.3 * vec` after min-max normalisation (`hybrid.rs`).
3. **Temporal decay** on `created`: 180-day half-life, floored at 0.4 (old facts
   de-emphasised, never buried).
4. **MMR** diversity re-rank (λ = 0.7) so near-duplicates don't dominate.
5. Superseded notes deranked; top-k (default 8) returned with name/path/
   frontmatter-`summary`/status/snippet; read counts bumped for salience.

Verdict: this is a genuinely sound hybrid design that will hold to thousands of
notes. The problems are (a) reliability of the index feeding it, (b) no tiering of
output cost, (c) the whole thing silently degrades to vector-only-and-stale when FTS
breaks — which is exactly what has been happening.

### 2.3 How `check` detects conflicts (concrete mechanism)

`check --content` → `continuity::score_content`:
1. Embed the candidate locally; pull 50 nearest chunks; aggregate to files; keep the
   top 8 above cosine similarity 0.45.
2. Each neighbour is judged pairwise by the reasoning LLM — **Gemini
   `gemini-2.0-flash` free tier when a key is configured, else local Ollama**
   (TIN-1789; the local models were judging noise, hence Gemini), temperature 0.1,
   1,500 chars per note.
3. Only judged *contradictions with a prior decision* count; each subtracts 0.35
   from a 1.0 score. Similarity alone never lowers the score.
4. No model reachable → similarity-only score (floor 0.5), `degraded: true`, zero
   conflicts. `check` exposes `degraded`; `add-memory` does **not** yet (PR #87
   fixes that) — so today an agent cannot tell a real "no conflicts" from
   "judge was down".

### 2.4 MEMORY.md vs. the CLI index — two things that drift, resolved

They are **fully disjoint**. The code excludes `MEMORY.md` everywhere — from
indexing (`search.rs`), embedding (`embeddings.rs`), and name resolution (`cli.rs`).
Nothing reads it, nothing writes it. So the system has two indexes of the same store:

- `MEMORY.md` — hand-appended by Claude, currently **252 lines (already past its
  ~200-line practical ceiling)**, covering a small fraction of the 972 notes, only
  as fresh as the last time an agent remembered to edit it.
- The SQLite index — derived from the files, currently frozen a month stale.

Both are wrong today, in different directions. Resolution (firm recommendation, not
a hand-wave): **MEMORY.md becomes a generated artifact owned by the CLI.** A
`sync-index` step (run at the end of every successful write, and by `reindex`)
regenerates it from the DB: grouped by project, one line per note
(`[name](path) — summary`, status-annotated), prioritised by salience, with per-project
caps and an explicit "N more — `agent-studio-memory recall --project X`" overflow line
instead of a truncation cliff. Hand-editing stops; the human-authored routing rules at
the top survive as a preserved preamble block. One source of truth (the markdown
files), one derived DB, one generated human/agent-readable index.

---

## Part 3 — Proposed direction for the CLI

Ordered. 3.0–3.2 are the foundation; nothing else lands before them.

### 3.0 Repair now, restructure second

1. **Repair** (minutes): FTS `rebuild` statement → `reindex` → verify counts/probe →
   record the provenance gap as a memory note.
2. **Extract `memory-core`**: the 15 keep-modules into a plain crate + headless
   `agent-studio-memory` bin (no Tauri). Same argv surface, same JSON. The shim and
   agents notice nothing. UI deletion then becomes a mechanical follow-up with no
   entangled risk.

### 3.1 Reliability first (goal 1)

- **Kill the full rebuild on write.** `add-memory` re-indexes 972 files to add one.
  Replace with per-file transactional upsert (delete+insert that file's rows only);
  `note_index_state` fingerprints already exist to support incremental reindex of
  out-of-band edits. This removes the corruption race *and* makes writes O(1).
- **Single-writer lock** across processes: `flock` on a lockfile beside the DB (or
  `BEGIN IMMEDIATE` + bounded retry) so parallel personas serialise writes instead
  of interleaving them. Reads stay lock-free under WAL.
- **`doctor` command**: FTS write-probe on a scratch copy, disk-vs-index counts,
  embedding coverage, last-audit-row age, notes-with-no-audit-row count (= bypassed
  writes), maintenance-queue depth. JSON out, nonzero exit on unhealthy.
- **`repair` command**: escalating — FTS rebuild → `.recover` → dump
  `memory_audit`/`memory_reads`, recreate DB, reindex, restore.
- **No more silent degradation, anywhere**: every command that skipped scoring,
  judging, embedding, or indexing says so in its JSON (`degraded`, `indexHealth`)
  and exits nonzero where the contract wasn't met. Merge PR #87 as the first slice.

### 3.2 Hard conflict gating on write (Rob's new requirement)

Today `add-memory` writes first, reports conflicts after — a soft signal nobody is
forced to read. Invert it: **score BEFORE writing; a detected contradiction blocks
the write.**

Mechanism (concrete):

- `add-memory` runs `score_content` first. If `conflicts` is non-empty the file is
  **not written**; exit code 3; JSON lists each conflict (path, contradicted
  decision, why) plus the exact resolution invocations.
- Resolution is one flag, not an interrogation:
  - `--resolve supersede:<old-name>` — write the note and supersede the old one in
    one atomic step (the common case: new decision replaces old).
  - `--resolve coexist --why "<one line>"` — both stand (scoped exception, not a
    true contradiction); the justification lands in the audit row and the note is
    tagged `status: contested` so the sweep and `brief` keep surfacing it until a
    human or a later supersede settles it.
  - Re-running with `--force` does not exist. No silent override path.
- **Degraded mode does not block and does not silently pass**: if the judge is
  unreachable, the write proceeds with `status: unreviewed` in frontmatter and a
  queued entry for the next sweep — because blocking on a down model would guarantee
  agents route around the CLI entirely.
- **Route-around containment** (the real risk, since direct file-writes are the
  documented fallback): (a) keep the gated path *cheaper* than hand-writing
  frontmatter — auto-fill, summary, filing are genuine value; (b) direct writes are
  not an escape hatch — they get picked up by incremental reindex and judged by the
  next sweep, so bypassing only *delays* the flag; (c) `doctor` counts
  audit-row-less notes so bypassing is visible as a metric; (d) update the global
  CLAUDE.md contract: fallback file-writes are for CLI-*unavailable*, not
  CLI-said-no.

Tradeoff accepted: pre-write scoring adds judge latency (~1–3 s via Gemini) to every
write. Worth it; writes are infrequent relative to reads.

### 3.3 Tiered, token-efficient retrieval (goals 2, 5)

- `recall` default becomes **summary tier**: ranked name + one-line summary + status
  + path only (~30–50 tokens per hit). `--tier snippet` adds excerpts; a new
  `read <name|path>` returns one full note. Fresh agent flow: generated index (in
  context via auto-memory) → `recall` summaries → `read` the one or two notes that
  matter. Target: **correctly oriented on a settled topic in ≤2 tool calls and
  <1,500 tokens** — that is the north-star metric, and `doctor`/the agent ledger
  should report tokens-per-orientation so we can watch it.
- Semantic matching: **already present** (local 384-dim embeddings + sqlite-vec).
  No new infra needed at this scale; revisit embedding model quality only if recall
  precision measurably fails after the index is healthy. Do not buy anything.
- Query ergonomics: `--here` flag (or `AGENT_CWD` detection) auto-scopes recall to
  the product matching the repo/path the agent is working in, mapped via a small
  repo→project table in config — removes the guess-the-search-term problem for the
  common case.

### 3.4 Generated index — stop hand-maintaining MEMORY.md (goals 3, 6)

As specified in 2.4: CLI-owned `sync-index`, regenerated on every successful write
and on `reindex`; salience-prioritised, per-project capped with overflow pointers,
no truncation cliff; human routing preamble preserved verbatim; plain markdown that
reads well in Obsidian. Claude stops editing it by hand (CLAUDE.md contract update).

### 3.5 Structural staleness and contradiction sweep (goal 4)

The all-pairs contradiction machinery already exists (`audit.rs` consistency audit +
`audit_verdict_cache` so pairs are only re-judged when content changes) — it is
merely trapped behind the GUI. Re-home it:

- `sweep` command: judge changed/new note pairs since the last sweep (cached
  verdicts keep it cheap), plus a **date-aware supersede suggester**: when an older
  `active` note conflicts with a newer one, emit a ready-to-run
  `supersede --old X --new Y` suggestion rather than just a finding.
- Findings land in a **human-legible markdown review queue**
  (`memory/_review/contradictions.md`, itself excluded from indexing like
  MEMORY.md), and `brief` surfaces open findings. Today's "a subagent happened to
  notice" becomes "the sweep files it and every brief nags until resolved".
- Run cadence: end of each `add-memory` covers the new note (that's 3.2); the full
  sweep runs on demand and/or via a scheduled agent — no GUI worker needed.

### 3.6 Multi-agent write safety (goal 7)

Covered by 3.1's single-writer lock + O(1) writes (contention window shrinks from
"full 972-file rebuild" to "one file upsert"). Name-collision handling already
exists (numeric suffix). The audit table already records actor per write; `doctor`
adds the bypass count. Nothing more is needed at current team size.

### 3.7 What retires quietly with the UI

Linear integration (canceled anyway), transcript browser/session archive/outcomes,
git diff panel, GUI ambient suggestion surfaces, Milkdown editor, graph view.
Obsidian takes over human browsing with zero migration (the store is already plain
markdown + frontmatter).

---

## Recommended order

1. Repair the index + merge PR #87 (today-scale).
2. Extract `memory-core` + headless bin; incremental index + write lock; `doctor`/`repair`.
3. Conflict gating on write.
4. Generated MEMORY.md + tiered recall.
5. Sweep + review queue; `--here` scoping.
6. Delete the UI layer; slim CI; VACUUM the DB.

Decisions that genuinely need Rob are listed in the tickets file under NEEDS ROB.
