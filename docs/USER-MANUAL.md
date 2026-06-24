# Agent Studio — User Manual

Agent Studio is a local desktop app for working with your agentic memory and
launching agent sessions. It is the launchpad: open it, find or write what you
need, assemble the right context, and start a session, all in one place.
Everything stays on your machine.

This manual covers what you can do and how. Every shortcut here has been verified
against the running app.

---

## 1. The workspace

When you open Agent Studio you land in the **workspace**: a search field and your
recent and matching memory files, with the markdown editor when a file is open.

The **nav rail** down the far left is home base. It holds every place you can go,
always visible, with the current one highlighted: **Search** (the workspace),
**Graph**, **Fields** (the frontmatter audit), **Check** (the consistency audit),
**Sessions** (transcripts), and **Settings** pinned at the bottom. Each also has
a keyboard shortcut (see the table at the end), but you never have to remember
them, the rail is right there.

The **top bar** is just your verbs: **Split**, **+ New**, and **Launch**.

Below the top bar each panel has a **tab row** of open documents (and the pinned
**Search** tab). A note shows its content, with its connections in a quiet
**Linked** footer at the bottom. Reviewing an agent's changes is its own place
now, the **Changes** view (see section 5), not a tab on a document.

---

## 2. Finding and opening notes

- **Search.** Type in the search field to full-text search your whole memory base.
  Narrow with the **type** chips (feedback, project, user, reference) and the
  **project** chips (attic, understory, website, studio, shared). Results show a
  snippet and update as you type.
- **Jump to a file fast.** Press **⌘K** to open the command palette, type a few
  letters of a name or content, and press **Return** to open it. **Esc** closes it.
- **Focus search** from anywhere with **⌘F**.
- Click any result to open it in the editor.

---

## 3. Writing notes

- **The editor** is a clean WYSIWYG markdown editor. Your file's frontmatter
  (the `---` block) is preserved; you edit the prose. Changes autosave.
- **New file.** Press **⌘N** (or **+ New**) to create a memory file with its
  type, project, and frontmatter set up for you.
- **Quick capture.** Press **⌘⇧N** from anywhere for the fastest path from a
  thought to memory: a small box opens, focused and ready. Type your note, pick a
  type and project, and press **⌘Return** to save. The name and filename are taken
  from your first line. A toast confirms ("Saved to studio.") with an **Open**
  link, and you stay exactly where you were. **Esc** dismisses without saving.

---

## 4. Two panels, side by side

Sometimes you want to hold two things at once: a note and its diff, two notes to
compare, or a prompt and its context.

- **Open the second panel** with **⌘\\** (or the **Split** button). It opens at
  50/50.
- **Send something to the other panel** by holding **⌘** while you click a result
  or link. It opens there instead of replacing what you are reading.
- **Resize** by dragging the divider between the panels. **Double-click** the
  divider to snap back to 50/50.
- **Close** the right panel with its **×** to return to a single full-width panel.
- Each panel remembers its own file and tab, and the whole layout is restored when
  you reopen the app.

---

## 4b. Retracing your steps — back and forward

Studio keeps a single trail of everywhere you have been, the way an editor does.
The two arrows at the top left (or **⌘[** and **⌘]**) step back and forward through
it: the notes you opened and the views you visited, in order. The arrows dim at
the ends of the trail, and opening something new from the middle starts a fresh
forward path from there.

---

## 5. Reviewing changes — the Changes view

When an agent has been working in a directory, review what changed without leaving
Studio. Changes is its own destination (the **Changes** rail item, or **⌘D**), not
tied to any note, because a diff is about a repository, not a document.

- Because you often work across several projects at once, Changes carries a **tab
  per working directory**, seeded from your configured agents and recent launch
  directories. Use **+ Directory** to add another; the ✕ on a tab removes it.
- For the selected directory you get a `git status` summary, a file list with
  **M / A / D** markers, and a click-to-expand diff for each file. Additions and
  removals are shown calmly (forest and heather), never as red alarms. It is
  read-only, staging and committing stay in the terminal.
- If a directory has no git status, Changes says so calmly; pick or add another.

---

## 6. Re-reading past sessions — Transcripts

Press **⌘T** (or the transcripts icon) to browse and search every past Claude
session.

- The left rail lists your **projects** with a session count. The search field at
  the top runs full-text search across **all** transcripts.
- The middle column lists that project's **sessions**, newest first, with the first
  message as a preview.
- The right pane renders the **conversation**: your turns and the assistant's turns
  in a clean reading style, with tool-use steps collapsed to a single line
  ("▸ ran Edit") that you can expand. It answers "what did we decide last time"
  without starting a new session.

---

## 7. The Launcher — start a session

This is the heart of Agent Studio. Press **⌘R** (or **Launch**).

You get a single composition canvas, three columns:

1. **Prompts** — browse and search your prompt files. Pick one.
2. **Preview & Context** — the prompt is rendered as readable prose so you can see
   exactly what the agent will receive. Below it, add context from three places:
   **Persona / skills**, **Memory** (the same search you use everywhere), and
   **Project files**. Everything you add shows as a removable chip, grouped by kind.
3. **Run** — choose the agent and working directory, glance at the context tally,
   and press the big **Run** button (or **⌘Return**).

Run assembles the prompt and every piece of selected context into one briefing and
spawns the agent in the terminal, fully briefed. The terminal slides up and the
session is live.

**It remembers.** The next time you pick the same prompt, your last setup (context,
agent, directory) is restored, so your second run is one keystroke. A quiet line
says "Restored your last setup." with a **Start fresh** option.

---

## 8. Linear tickets

Click a **TIN-XXXX** ticket reference in any note to open that ticket in a native
window beside Studio. Log in once; the session persists. Each ticket opens its own
window, and reopening the same ticket focuses the existing one.

---

## 8b. Frontmatter — described, imported, audited

Every memory file has a small frontmatter block (type, projects, tags, dates).
Studio fills it in for you and keeps it healthy.

- **Smart create.** When you create a note (**⌘N**), paste or write the body and
  Studio describes it: it suggests a name, type, projects, and tags from the
  content, with a live preview of how the card will look. Every field stays
  editable, and **Regenerate** re-describes from your latest text. Anything you
  edit by hand is kept.
- **Import existing notes.** Drop one or more `.md` files onto the window, or press
  **⌘O** to pick them. Studio reviews each file's frontmatter (or generates it when
  there is none), lets you adjust, and files it into the right project folder.
  Multiple files queue up so you can step through or import them all at once.
- **Audit (⌘⇧A).** A calm health view of your whole library: which notes are fully
  described, which need a little, and which are not described yet. Click a row to
  fix one, or "Fix all" to step through the loose ones. A tidy library is an empty
  screen, not a wall of warnings.

---

## 9. Connecting notes — wiki-links and the graph

Notes are not a flat folder; they form a graph. Three ways to use it:

- **Link to another note** by typing `[[` in the editor. A picker opens; keep
  typing to filter by name, then press Return to insert the link. Resolved links
  show the note's name in forest green; click one to open that note. A link to a
  note that does not exist yet stays calm and grey, never a broken-red link.
- **The Links tab** (on any open note) shows three things: the tickets the note
  mentions, the notes it links out to, and the notes that link back to it ("who
  talks about this?"). Click a card to open that note; ⌘-click opens it in the
  other panel.
- **The graph view** opens with **⌘G**: every note is a dot, coloured by project
  and sized by how connected it is; tickets are small rings. Drag to pan, scroll
  to zoom, click a dot to open it. Filter with the chips along the top, and find
  notes with no links yet on the "not yet linked" shelf.

Links rebuild automatically whenever the index does, so they stay in sync as you
write.

---

## 9b. Checking for contradictions — Consistency audit

Press **⌘⇧C** to look for places where two notes seem to say different things (a
stale price, a reversed decision, divergent duplicates). Studio uses the local
embeddings to find related notes, then reads each related pair with your local
model to spot concrete disagreements, and lists them: each finding is a one-line
summary and the two notes, which you can open side by side to reconcile.

It is calm by design: a finding is "worth a look," never an error, and the happy
outcome ("Your notes agree.") is the reward. The audit needs a local reasoning
model: if none is found, it points you to install one (for example
`ollama pull llama3.1:8b`). Nothing leaves your machine.

---

## 10. Settings

Press **⌘,** (or the gear). Settings is one calm panel:

- **Appearance** — Light, Dark, or System theme. System follows your operating
  system and switches live when it does. Your choice is remembered across
  restarts.
- **Roots** — where Studio looks for your memory, prompts, skills, and transcripts.
  Each has a "Choose…" folder picker. Changing the memory root offers to rebuild
  the index right there.
- **Embedding API key** — stored securely in your system keychain, never in plain
  text. Shows "Set" or "Not set"; reveal on demand.
- **Agents** — the coding agents you can launch: a name, the command, its
  arguments, and a default working directory. This list feeds the Launcher's agent
  picker and the Diff tab's working directory.

Settings persist across restarts.

---

## 11. Your memory files

A memory file is just markdown with a small YAML frontmatter block:

```markdown
---
name: my-note
type: feedback        # feedback | project | user | reference
projects: studio      # one project, or a list
created: 2026-06-20
updated: 2026-06-20
tags: [search, recall]
status: active
---

The note itself goes here.
```

Studio indexes these for search. `MEMORY.md` and hidden files are skipped.

---

## 12. Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette (jump to a file) |
| `⌘F` | Focus search |
| `⌘N` | New memory file |
| `⌘⇧N` | Quick capture |
| `⌘\` | Toggle the second panel |
| `⌘`-click | Open in the other panel |
| `⌘[` | Back (global history) |
| `⌘]` | Forward (global history) |
| `⌘D` | Changes |
| `⌘T` | Transcripts |
| `⌘G` | Knowledge graph |
| `⌘O` | Import Markdown files |
| `⌘⇧A` | Frontmatter audit |
| `⌘⇧C` | Consistency audit |
| `⌘R` | Launcher |
| `⌘,` | Settings |
| `⌘Return` | Save / Run (in modals and the launcher) |
| `Esc` | Dismiss the top layer |

---

## 13. Tips

- **Quick capture is for speed.** Don't reach for the full editor mid-thought;
  ⌘⇧N, type, ⌘Return, done. Structure can come later.
- **Use the second panel intentionally.** File + diff while you review, prompt +
  context while you compose, two notes while you compare.
- **Let the Launcher remember.** Set a prompt up well once; every run after is
  instant.
- **Everything is local.** Your memory, prompts, transcripts, and the search index
  live on your machine.
