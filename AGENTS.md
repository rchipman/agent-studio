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
