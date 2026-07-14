<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Commands

| Task | Command |
| --- | --- |
| Run the app (dev) | `npm run desktop` (= `tauri dev`) |
| Type-check | `npm run type-check` (`tsc --noEmit`) |
| Lint | `npm run lint` (`eslint .`) |
| Frontend tests | `npm test` (Vitest) · `npm run test:watch` |
| Rust tests | `cd src-tauri && cargo test` |
| Production build | `npm run tauri build` (static-exports the frontend, bundles the binary) |

The primary gate is local: a `pre-push` git hook runs lint + type-check +
`npm test` + `cargo test` + `cargo clippy` on every push and blocks it on
failure. See "Local CI: the pre-push gate" below. A light GitHub Actions
workflow (`.github/workflows/ci.yml`) runs the same `npm run green` chain on
`ubuntu-latest` as a PR backstop — it exists to catch a push that bypassed
the hook (`--no-verify`, a clone without the hook installed), not to
duplicate it as a second heavyweight suite. Keep it that way: single job,
no matrix, cached deps, `npm run e2e` excluded for the same reason it's
excluded from the hook.

Testing strategy and the test pyramid: see `docs/metrics/agent-ledger.md` and the TIN-1641 epic. Test logic, not pixels; GUI E2E is intentionally deferred.

## Local CI: the pre-push gate

Source of truth: `scripts/git-hooks/pre-push` (committed, version-controlled).
Installed at `.git/hooks/pre-push` — git hooks aren't versioned by git itself,
so re-run the install step below after cloning or if the hook goes missing:

```bash
cp scripts/git-hooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Gate, in order: `npm run lint` -> `npm run type-check` -> `npm run test` ->
`cargo test` -> `cargo clippy --all-targets -- -D warnings` (the two cargo
steps run in `src-tauri/` via the `cargo:test` / `cargo:clippy` npm scripts).
The same chain is available on demand as `npm run green`. `npm run e2e` is
deliberately NOT part of the gate — the desktop e2e suite is slow and needs a
display; run it manually before a release.

Emergency bypass: `git push --no-verify`.

## Background build agents (worktrees)

When a build runs in an isolated git worktree under `.claude/worktrees/`:

- **Branch naming.** Create and push a real `jrchipman1/tin-<n>-<slug>` branch and open a PR — do not leave work on the auto-generated `worktree-agent-<id>` branch (it disconnects the work from its ticket and clutters the branch list). (TIN-1742)
- **Lint scoped, not global.** Run `npx eslint <changed files>`, not `eslint .`. `eslint .` is also configured to ignore `.claude/**`, but scoping keeps output honest while a worktree is live.
