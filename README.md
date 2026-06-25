# Agent Studio

An open-source Tauri + Next.js desktop app for working with agentic memory and implementation sessions across development projects.

Agent Studio is a fast, local-first workspace for the markdown "memory base" that coding agents read from and write to. It pairs a WYSIWYG markdown editor with full-text search over your memory files, a file tree, an embedded terminal for running implementation sessions, and a side panel for the Linear ticket you're working. Everything runs on your machine; nothing is sent anywhere.

## Features

- **Markdown editor** — WYSIWYG editing (Milkdown/Crepe) with `Cmd+S` to save. Files keep their YAML frontmatter.
- **Full-text search** — SQLite FTS5 index over every `.md` file in your memory root, filterable by `type` and `project`.
- **Command palette** — `Cmd/Ctrl+K` to jump to any file by name or content.
- **File tree** — browse, create, and pin files/folders; right-click context menu.
- **New-file flow** — create a memory file with frontmatter (name, type, projects, tags) pre-filled.
- **Terminal panel** — an embedded terminal (xterm.js) you can spawn against the active file to run an implementation/agent session.
- **Linear panel** — open the related Linear ticket inline beside your work.
- **Recents** — recently opened files are remembered locally.

## Tech stack

| Layer | Choice |
|-------|--------|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| Frontend | [Next.js 16](https://nextjs.org) (App Router, React 19), static-exported |
| Editor | [Milkdown](https://milkdown.dev) (Crepe) |
| Terminal | [xterm.js](https://xtermjs.org) |
| Search index | SQLite **FTS5** via [`rusqlite`](https://github.com/rusqlite/rusqlite) (bundled) |
| Frontmatter | [`gray_matter`](https://crates.io/crates/gray_matter) (Rust), `gray-matter` (JS) |

## Architecture

The frontend is a statically-exported Next.js app rendered inside the Tauri webview. Search and file-creation are **Rust Tauri commands** (not a Node/API server), so they work identically in `tauri dev` and a packaged `tauri build`:

```
React UI ──invoke('search' | 'create_file')──▶ Rust (src-tauri/src/search.rs)
                                                  │
                                                  ▼
                                         rusqlite FTS5 index
                                       (.studio-index.db in the memory root)
```

- The index is built once at app startup and held in Tauri managed state (`Mutex<Connection>`).
- File reads/writes use the Tauri filesystem plugin, scoped to your home directory.
- The memory base is a tree of markdown files with YAML frontmatter:

  ```markdown
  ---
  name: my-note
  type: feedback        # feedback | project | user | reference | ...
  projects: my-project  # a string, or a YAML list
  created: 2026-06-20
  updated: 2026-06-20
  tags: [search, recall]
  status: active
  ---

  Body content…
  ```

  `MEMORY.md` and hidden files/dirs are skipped by the indexer.

> **Note:** the memory root currently defaults to `~/Projects/tfl/memory` (see `MEMORY_ROOT` in `app/page.tsx` and `memory_root()` in `src-tauri/src/search.rs`). Point these at your own memory directory.

## Getting started

### Prerequisites

- **Node.js** 20+
- **Rust** (stable) and the Tauri prerequisites for your OS — see the [Tauri setup guide](https://tauri.app/start/prerequisites/)
- On macOS, the Xcode command-line tools

### Install

```bash
npm install
```

### Run (development)

```bash
npm run desktop      # = tauri dev — launches the native app with hot reload
```

This starts the Next.js dev server (`localhost:3002`) and the Tauri shell against it.

### Build (production)

```bash
npm run tauri build  # static-exports the frontend and bundles a native binary
```

The bundle (`.app` / `.dmg` on macOS, etc.) lands in `src-tauri/target/release/bundle/`.

### Configuration

On first run, open **Settings** (`⌘,`) to configure:

- **Memory root** — where your `.md` memory files live (default `~/Projects/tfl/memory`). Changing it rebuilds the index.
- **Embeddings** — semantic search and continuity scoring use a local embedding model ([candle](https://github.com/huggingface/candle), `all-MiniLM-L6-v2`) that downloads once and runs fully offline. No key or setup required. An embedding API key can optionally be set for a hosted model instead (stored in your system keychain).
- **Local reasoning model (optional)** — the consistency audit, continuity scoring, and note summaries use a local LLM via [Ollama](https://ollama.com). Install Ollama and pull a model, e.g. `ollama pull llama3.1:8b`. Without one, those features degrade gracefully (search and writing still work).
- **Linear (optional)** — paste a read-scoped Linear API key to ingest your issues and epics into the memory base (searchable, and as nodes in the graph). Stored in your system keychain; read-only.

### Agent memory CLI (the continuity loop)

Agents can write memory through a headless command that scores the note against your existing memory (flagging contradictions with earlier decisions), generates a summary, and records who wrote it:

```bash
agent-studio-memory add-memory --content "…" --agent <name> [--project <p>] [--type <t>]
#   → prints { path, continuityScore, conflicts }   (surface conflicts to the human)
agent-studio-memory supersede --old <path|name> --new <name>   # invalidate, don't delete
agent-studio-memory reindex                                    # re-index + re-embed the whole
#   → prints { indexed, embedded }   store after out-of-band edits (the GUI does this on startup)
```

It is **headless** (the GUI does not need to be running) and degrades gracefully if no reasoning model is available.

Install the `agent-studio-memory` command on your `PATH`:

```bash
npm run install-cli   # builds the release binary if needed, symlinks the wrapper
```

This symlinks `bin/agent-studio-memory` into `~/.local/bin` (override with `PREFIX=/usr/local/bin`). The wrapper resolves the built binary (release, then debug; override with `AGENT_STUDIO_BIN`). If the command is not available, agents fall back to writing the `.md` file directly — the continuity check is an enhancement, never required.

## Project structure

```
app/                 Next.js app-router UI (page.tsx is the main workspace)
components/           Editor, file tree, command palette, terminal, Linear panel
lib/                  Shared types and helpers
src-tauri/
  src/lib.rs          Tauri builder — plugins, managed state, command registration
  src/search.rs       rusqlite FTS5 index + `search` / `create_file` commands
  tauri.conf.json     App + bundle config
  capabilities/       Tauri permission scopes
```

## Development

```bash
npx tsc --noEmit                 # type-check the frontend
cd src-tauri && cargo test       # Rust unit tests (search/index logic)
cd src-tauri && cargo build      # compile the backend
```

## License

[MIT](./LICENSE) © 2026 Rob Chipman
