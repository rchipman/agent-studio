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

CI (`.github/workflows/ci.yml`) runs lint + type-check + `npm test` + build (frontend) and `cargo test` + `cargo build` (Rust) on every PR and push to `main`. Keep them green.

Testing strategy and the test pyramid: see `docs/metrics/agent-ledger.md` and the TIN-1641 epic. Test logic, not pixels; GUI E2E is intentionally deferred.

## Background build agents (worktrees)

When a build runs in an isolated git worktree under `.claude/worktrees/`:

- **Branch naming.** Create and push a real `jrchipman1/tin-<n>-<slug>` branch and open a PR — do not leave work on the auto-generated `worktree-agent-<id>` branch (it disconnects the work from its ticket and clutters the branch list). (TIN-1742)
- **Lint scoped, not global.** Run `npx eslint <changed files>`, not `eslint .`. `eslint .` is also configured to ignore `.claude/**`, but scoping keeps output honest while a worktree is live.
