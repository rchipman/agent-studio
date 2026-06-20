# Agent Studio — Surface System

A design decision pass for the five new surfaces that turn Agent Studio from a
markdown memory browser into an agent launchpad. The brief is cohesion: these
must feel like one inevitable app, not six bolted-on screens.

The app already has a quiet, confident voice — forest green on warm cream, serif
for reading and ideas, system sans for chrome, a near-monochrome ink palette, and
generous calm. Nothing here introduces a new mood. We are extending a language,
not inventing one. Every decision below either reuses an existing pattern or
formalizes one that was already implied by the inline styles in `app/page.tsx`.

House voice, in one line: calm and present, never loud. No alarm, no red, no
warning glyphs. Restraint over decoration. Inevitability over cleverness.

---

## A. Tokens

These promote the currently-inline values in `app/page.tsx`,
`components/CommandPalette.tsx`, and friends into one named set. They live as CSS
custom properties on `:root` in `app/globals.css`, mirrored by a typed
`lib/tokens.ts` for use in inline-styled React (the app's prevailing style).
Builders reference tokens, never magic numbers.

### Color

| Token | Value | Role |
| --- | --- | --- |
| `--bg-app` | `#F2F0ED` | App background, top bar |
| `--bg-raised` | `#FCFAF4` | Modals, right panels, menus (cream) |
| `--bg-field` | `rgba(255,255,255,0.70)` | Inputs, search fields |
| `--bg-field-strong` | `rgba(255,255,255,0.85)` | Hovered cards, inline inputs |
| `--bg-card` | `rgba(255,255,255,0.55)` | Resting result cards |
| `--ink` | `#262320` | Primary text |
| `--ink-soft` | `#6B6760` | Secondary text, labels |
| `--ink-faint` | `#9B9490` | Tertiary text, timestamps, hints |
| `--forest` | `#3E5641` | Primary accent, active state, primary button |
| `--forest-tint` | `rgba(62,86,65,0.10)` | Type chips, forest badges |
| `--forest-line` | `rgba(62,86,65,0.30)` | Active card border |
| `--forest-wash` | `rgba(62,86,65,0.06)` | Active card fill, selected row |
| `--tan` | `#9B7B5A` | Project accent |
| `--tan-tint` | `rgba(155,123,90,0.10)` | Project chips, project badges |
| `--hair` | `rgba(38,35,32,0.10)` | Standard hairline / divider |
| `--hair-soft` | `rgba(38,35,32,0.08)` | Card border, lighter divider |
| `--line` | `rgba(38,35,32,0.18)` | Input border, control border |
| `--scrim` | `rgba(38,35,32,0.45)` | Modal overlay |
| `--term-bg` | `#1a1917` | Terminal surface |
| `--term-fg` | `#d4d0cb` | Terminal text |

Semantic accents (used sparingly, never as alarm):

| Token | Value | Role |
| --- | --- | --- |
| `--add` | `#3E5641` | Diff additions, "saved", success. Forest, not green-LED. |
| `--add-wash` | `rgba(62,86,65,0.08)` | Added-line background |
| `--remove` | `#7C6A86` | Diff removals. Muted heather, never red. |
| `--remove-wash` | `rgba(124,106,134,0.08)` | Removed-line background |
| `--notice` | `#9B7B5A` | "Index out of date", "unsaved", attention without alarm. Tan. |

There is no red token. Errors and removals read as calm, recessive states, not
emergencies. This is a house rule, not a preference (see §D).

### Spacing

A 4px base scale. Token name = pixels.

| Token | px |
| --- | --- |
| `--sp-1` | 4 |
| `--sp-2` | 6 |
| `--sp-3` | 8 |
| `--sp-4` | 12 |
| `--sp-5` | 16 |
| `--sp-6` | 20 |
| `--sp-7` | 24 |
| `--sp-8` | 32 |

### Radii

| Token | px | Use |
| --- | --- | --- |
| `--r-sm` | 3 | Scrollbar, micro-controls |
| `--r-chip` | 9 | Badges, pills |
| `--r-md` | 6 | Inputs, buttons |
| `--r-card` | 8 | Cards, list rows |
| `--r-field` | 10 | Hero search field |
| `--r-lg` | 12 | Modals, panels, menus |

### Type

Three families, already loaded: `Fraunces`/`Literata Variable` (serif, reading +
wordmark + surface titles), `system-ui` (chrome), `JetBrains Mono` (code, terminal,
diffs, keycaps).

| Token | size / weight / family | Use |
| --- | --- | --- |
| `--t-display` | 18 / 400 / serif | Reading body, prompt preview body |
| `--t-title` | 15 / 600 / serif | Surface titles ("Settings", "Quick capture") |
| `--t-body` | 13 / 400 / sans | Default UI text, list primary |
| `--t-label` | 11 / 600 / sans, upper, `0.04em` | Field labels, section headers |
| `--t-meta` | 11 / 400 / sans | Secondary list text |
| `--t-micro` | 10 / 600 / sans | Badge text |
| `--t-mono` | 13 / 400 / mono | Paths, commands, diff lines, keycaps |

### Chrome primitives (composed from the above)

- **Modal card**: `--bg-raised`, `--r-lg`, shadow `0 20px 60px rgba(38,35,32,0.25)`,
  padding `--sp-7`, scrim `--scrim`.
- **Right panel**: width per surface, `--bg-raised`, shadow `-4px 0 24px rgba(38,35,32,0.12)`,
  slide `width 0.25s ease`, 44px header with `--hair` bottom border.
- **Input**: `--bg-field`, `1px solid --line`, `--r-md`, padding `6px 10px`,
  focus border `--forest`.
- **Primary button**: `--forest` fill, white text, `--r-md`, `7px 16px`, weight 600.
- **Secondary button**: transparent, `1px solid --line`, `--ink-soft` text.
- **Chip** (`TypeChip`, already exists): pill, active = `--forest` fill / white,
  resting = transparent / `--ink-soft` with `--line` border.
- **Badge**: type = `--forest-tint`/`--forest`; project = `--tan-tint`/`--tan`;
  neutral = `rgba(38,35,32,0.06)`/`--ink-soft`.
- **List row**: `8px 16px`, selected = `--forest-wash` fill + 2px `--forest` left
  border, hover = `--bg-field-strong`. (Matches `CommandPalette` and `FileTree`.)

---

## B. The surface system + shortcut map

### When is it a modal, a panel, or a view?

One rule, three answers. Choose by the question "what is the user's relationship to
the rest of the app right now?"

- **MODAL** — *a quick, self-contained act that returns you exactly where you were.*
  Centered cream card over a scrim. You came to do one small thing (capture a note,
  change a setting) and the underlying context still matters, so we float over it
  and dismiss cleanly. Modals never navigate. Dismiss on Esc / scrim click.
  → Quick capture, Settings.

- **RIGHT-SIDE PANEL** — *a companion to what you're looking at.* Slides in from the
  right, the main view stays put and visible. Used for things you consult *alongside*
  your work: the diff of the repo you're in, a reference. Read-leaning. Esc closes.
  → Git diff viewer. (Matches the existing `LinearPanel`.)

- **FULL VIEW** — *a place you go to, with its own multi-step flow and depth.* Replaces
  the main content column (the search/editor area), top bar persists with a `← Agent
  Studio` return. Used when the task *is* the session, not a side errand.
  → Transcript browser, Prompt launcher.

Settings is the one judgment call: it is configuration, self-contained, and returns
you home, so it is a **modal** (a tall one) — not a view. This keeps "go somewhere"
reserved for the two flows that earn it.

### Shortcut map

Single chords for the things you reach for constantly; `⌘⇧` for the deliberate,
less-frequent create. The launcher gets the most memorable, unshifted letter we can
spare, because it is the front door.

| Shortcut | Surface | Kind |
| --- | --- | --- |
| `⌘K` | Command palette (exists) | Modal |
| `⌘R` | **Prompt launcher** (the north star) | Full view |
| `⌘T` | Transcript browser | Full view |
| `⌘D` | Git diff viewer | Right panel |
| `⌘,` | Settings | Modal |
| `⌘⇧N` | Quick capture | Modal |
| `⌘N` | New memory file (exists) | Modal |
| `⌘F` | Focus search (exists) | — |
| `Esc` | Dismiss top-most surface | — |

`⌘R` for **R**un — the launcher's verb is Run, and "R" beats an obscure combo for
the door you want to open every morning. (`⌘N`/`⌘⇧N` keep the new-file family
together: file vs. quick capture.)

Global rules:
- `Esc` always dismisses the top-most surface, one layer at a time.
- Only one full view at a time; opening a second returns the first to home first.
- A modal may float over a full view (e.g. Settings over the launcher). A panel may
  not stack on a modal.
- `⌘↩` is the universal "commit this surface" (save capture, run launcher).
- Every shortcut is also a visible affordance (top-bar control or in-surface button);
  shortcuts are an accelerator, never the only door.

---

## C. The surfaces

Shared empty/loading/error voice (calm, no em-dashes, no red):

- **Loading**: a single quiet line in `--ink-soft`, e.g. `Reading…`, `Loading…`.
  No spinners larger than the existing `…`.
- **Empty**: one centered line in `--ink-faint` plus, where useful, a single next
  step. Never an illustration, never an exclamation.
- **Error**: recessive notice block — `--notice` text on `rgba(155,123,90,0.08)`,
  `--r-md`, no icon. Phrased as a fact and a way forward, not a failure.

---

### 1. Settings — `⌘,` — tall modal

A single scrolling cream card, ~560 wide, grouped into labeled sections. Title
`Settings` (`--t-title`). Sections separated by `--hair` rules, each headed with a
`--t-label`. No tabs — the whole thing fits one quiet column.

**Sections, in order:**

1. **Roots**
   - Memory root — path field + `Choose…` (native folder picker).
   - Prompts root — path field + `Choose…`.
   - Skills root — path field + `Choose…`.
   - Transcripts root — path field + `Choose…`.
   Each row: `--t-label` over a mono path field (`--t-mono`, read-leaning) with the
   picker button trailing.

2. **Embedding**
   - API key — masked field showing `••••••••••••` with a trailing `Reveal` text
     button (hold-to-reveal or toggle). Stored via the OS keychain, never in plain
     localStorage; the field shows `Set` / `Not set` status in `--ink-faint`.

3. **Agents** (registered coding agents)
   - A list of agent rows; each row: **name**, **command**, **args**, **default cwd**.
   - Row layout: name in `--t-body` weight 600, command+args in `--t-mono` `--ink-soft`
     beneath, cwd as a `--tan-tint` badge.
   - `+ Add agent` ghost row at the bottom; editing expands the row inline (no nested
     modal). A small `Remove` text button per row.
   - This list is the source of truth the launcher's agent picker reads from.

**Footer**: `Cancel` (secondary) and `Done` (primary). `Done` persists.

**The memory-root reindex moment.** When the memory root changes and the user
confirms the field (blur or Done), surface an inline confirm *within the modal*,
directly under that field — not a new dialog:

> Memory root changed.
> `Rebuild index now?`   [ Not now ]   [ Rebuild ]

`Rebuild` kicks the existing `search` rebuild and shows `Rebuilding index…` in
`--ink-soft` on that row until done, then `Index rebuilt` for a beat. `Not now`
leaves a persistent `--notice` line elsewhere: `Index may be out of date.` with a
`Rebuild` link, so the deferred state is honest but never alarming.

**States:** loading = `Loading settings…` centered. Error saving = recessive notice
under the footer: `Could not save settings. Your changes are still here.` Empty
agents list = a single `--ink-faint` line: `No agents yet. Add one to launch sessions.`

**Copy:**
- Title: `Settings`
- Labels: `Memory root` · `Prompts root` · `Skills root` · `Transcripts root` ·
  `Embedding API key` · `Agents`
- Key status: `Set` / `Not set` · button `Reveal` / `Hide`
- Agent fields: `Name` · `Command` · `Arguments` · `Default working directory`
- Buttons: `Choose…` · `+ Add agent` · `Remove` · `Cancel` · `Done`

---

### 2. Quick capture — `⌘⇧N` — small modal

The fastest path from a thought to memory. Tiny, centered, ~440 wide. Opens with
the content area already focused. You type, you `⌘↩`, you are back where you were
with a toast. It never navigates.

**Layout (top to bottom):**
- A whisper-quiet header: just `Quick capture` in `--t-label`, right-aligned keycap
  hint `⌘↩ to save`.
- **Content area** — autofocused multiline field, serif (`--t-display` at 15/1.6),
  borderless, generous. Placeholder: `What's on your mind?` This is the hero; it
  fills most of the card.
- **A single quiet control row** at the bottom:
  - Type selector — four chips: `feedback` `project` `user` `reference`.
    Default `feedback`. (Reuses `TypeChip`.)
  - Project selector — chips: `attic` `understory` `website` `studio` `shared`.
    Single-select, default to last used.
- That's all. No name, no tags, no slug field — capture is for speed; structure can
  come later in the editor.

**Save:** `⌘↩` writes a new memory file with frontmatter (`type`, `projects`,
`created`, `name` derived from the first line), closes the modal, and fires a toast.

**Toast** (new shared primitive): bottom-center, `--bg-raised`, `--r-md`, subtle
shadow, `--t-body`, auto-dismiss ~2.5s. Copy: `Saved to <project>.` with a trailing
`Open` text button that loads the new file in the editor. Toast uses `--add` for a
1px left accent — confirmation, not celebration.

**States:** empty content + `⌘↩` = no-op with the field gently shaking off focus,
no error text. Save failure = the modal stays open with a recessive notice above the
control row: `Could not save. Your text is still here.`

**Copy:**
- Title: `Quick capture`
- Placeholder: `What's on your mind?`
- Hint: `⌘↩ to save`
- Toast: `Saved to studio.` · button `Open`

---

### 3. Git diff viewer — `⌘D` — right panel

A read-only companion that shows what has changed in the working directory, slid in
from the right at 520 wide over whatever you're doing. Pure consultation.

**Header** (44px, matches `LinearPanel`): left = `Changes` title + the branch name
in `--ink-faint` mono; right = `Refresh` text button and the close `×`.

**Body, two stacked regions:**

1. **Status summary** — one calm line: `4 files changed` in `--ink-soft`, with small
   counts: `+128` in `--add`, `−40` in `--remove`. No totals bar graph, no red.

2. **File list** — rows, each: a status letter chip + the repo-relative path
   (`--t-mono`, truncated from the left so the filename stays visible).
   - `M` modified — `--ink-soft` chip on `rgba(38,35,32,0.06)`
   - `A` added — `--add` chip on `--add-wash`
   - `D` deleted — `--remove` chip on `--remove-wash`
   Letters only, never colored dots that read as traffic lights, never `⚠`.
   Selected row: `--forest-wash` + 2px `--forest` left border.

3. **Diff** — clicking a file expands its diff *below the list* (accordion) or in a
   lower split, whichever the build favors; default to accordion to keep it one
   scroll. Diff is `--t-mono`, syntax-highlighted using the existing `hljs` theme for
   the code, with line backgrounds: additions `--add-wash` + `+` gutter in `--add`,
   removals `--remove-wash` + `−` gutter in `--remove`, context plain. Hunk headers
   (`@@`) in `--ink-faint`. Read-only; selectable text.

**States:**
- Clean tree (empty): centered `--ink-faint` line: `Nothing changed yet.`
- Loading: `Reading changes…` in `--ink-soft`.
- Not a git repo: recessive notice: `This folder isn't a git repository.`
- Error running git: `Could not read git status.` with a `Refresh` retry.

**Copy:**
- Title: `Changes`
- Summary: `4 files changed` · `+128` · `−40`
- Buttons: `Refresh`
- Empty: `Nothing changed yet.`

The restraint here is the point: a diff viewer is where every other tool reaches for
red. We don't. Removals are a muted heather, additions are the house forest. It reads
as a document of change, not an alert.

---

### 4. Session transcript browser — `⌘T` — full view

Where you go to re-read what an agent and you actually said. Three-pane drill-down
inside the main content column, top bar shows `← Agent Studio`.

**Pane 1 — Projects** (narrow left rail, ~220): the project list (`attic`,
`understory`, …) with a session count per project in `--ink-faint`. A search field
pinned to the top of this rail runs **FTS across all transcripts** (reusing the
existing FTS infrastructure), and when active the rail switches to flat result rows
(project badge + snippet) instead of the project list.

**Pane 2 — Sessions** (middle, ~320): for the selected project, a list of sessions
newest-first. Each row: date (`--t-body`, e.g. `Jun 18`), and the **first human
message** as a one-line preview in `--ink-soft`. Selected row uses the standard
forest-wash treatment.

**Pane 3 — Conversation** (right, fills): the readable transcript.
- **Human turns**: serif (`--t-display`), full-width, a small `--tan` left rule and a
  quiet `you` label above. Warm, like reading your own notes.
- **Assistant turns**: serif body, a `--forest` left rule and `assistant` label.
  Clear visual difference from human turns without two competing bubble styles.
- **Tool-use blocks**: collapsed by default to a single `--t-mono` `--ink-faint` line:
  `▸ ran <tool>` (e.g. `▸ ran Edit · app/page.tsx`). Click to expand into a recessed
  `rgba(38,35,32,0.04)` block showing the call and result in mono. Keeps the
  conversation readable while the machinery stays one tap away.
- A search match (from pane 1) scrolls the conversation to the hit and gives it a
  brief `--forest-wash` highlight.

**States:**
- No transcripts root set: empty pane-2/3 with `Set a transcripts root in Settings to
  browse sessions.` and a `Settings` link.
- Empty project: `No sessions in this project yet.`
- Loading conversation: `Loading…` centered in pane 3.
- Search, no hits: `Nothing matched.` in the rail.

**Copy:**
- Title (top bar center): `Transcripts`
- Search placeholder: `Search transcripts…`
- Turn labels: `you` · `assistant`
- Collapsed tool line: `▸ ran Edit · app/page.tsx`
- Empty: `No sessions in this project yet.`

---

### 5. Prompt launcher + context picker — `⌘R` — full view — THE NORTH STAR

This is the reason the app exists now. You open Agent Studio, you press `⌘R`, and in
a few calm moves you have assembled exactly the right prompt, exactly the right
context, the right agent and directory, and you hit **Run**. The agent comes alive in
the terminal with everything it needs. It should feel like the obvious, inevitable way
to start every session — and so well composed that assembling context by hand
afterward feels primitive.

**The shape: a single composition canvas, three columns, one button.** Not a wizard.
You see the whole thing at once and refine any part in any order. The top bar persists
with `← Agent Studio`; the center reads `Launch`.

```
┌ Prompts ─────┐┌ Preview & Context ───────────────┐┌ Run ───────┐
│ search       ││  PROMPT TITLE          (serif)    ││ Agent  ▾   │
│ ▸ prompt a   ││  the prompt body, rendered serif, ││ Dir    ▾   │
│ ▸ prompt b   ││  exactly like reading a memory    ││            │
│   prompt c   ││  file. calm. legible.             ││ Context:   │
│ …            ││                                   ││  3 skills  │
│              ││  ── Context ──────────────────    ││  2 memory  │
│              ││  Persona / skills  [ pick ]       ││  1 file    │
│              ││  Memory            [ search ]     ││            │
│              ││  Project files     [ browse ]     ││ ╭────────╮ │
│              ││  selected items as removable chips││ │  Run   │ │
└──────────────┘└───────────────────────────────────┘└──────▲────┘
```

**Column 1 — Prompts** (~240): browse `~/Projects/tfl/prompts`. A search field on
top, then prompt rows (name + a `--ink-faint` one-line description from frontmatter).
Selecting a prompt loads it into the center. Standard forest-wash selection.

**Column 2 — Preview & Context** (fills, the heart):
- The selected prompt **rendered as you'd read it** — serif `--t-display`, the same
  reading treatment as the editor. This is what sells trust: you see the actual words
  the agent will receive, not a filename.
- Below a `── Context ──` rule, three pickers, each opening into the *existing*
  surfaces so the app stays coherent:
  - **Persona / skills** — pick skill files from the skills root (multi-select list).
  - **Memory** — opens the existing FTS search inline; add results as context.
  - **Project files** — optional file browser rooted at the working dir.
- Everything you add appears as a **removable chip** right here, grouped by kind
  (skill chips `--forest-tint`, memory chips `--tan-tint`, file chips neutral). The
  bundle is always visible and always editable. Nothing is hidden behind a count.

**Column 3 — Run** (~240): the launch console.
- **Agent** selector (reads the registered agents from Settings).
- **Working directory** selector (defaults to the agent's default cwd; recent dirs
  listed).
- A quiet **Context** tally mirroring the chips: `3 skills · 2 memory · 1 file`.
- The **Run** button — the single most important control in the app. Primary forest,
  larger than any other button (full-width of the column, `--r-md`, weight 600),
  with the keycap `⌘↩` beside it. It is the visual gravity well of the whole view.

**Run** composes the context bundle (prompt body + selected skill/memory/file
contents, concatenated with light headers) and spawns the chosen agent in the
`TerminalPanel` with the bundle injected — the terminal slides up and the session is
live. The launcher recedes to home; the work is now in the terminal.

**Memory of intent.** Per prompt, the launcher **remembers the last-used context
bundle, agent, and working dir** (keyed by prompt path in localStorage, like
`RECENTS_KEY`). Re-selecting a prompt restores its bundle instantly, with a quiet
`--ink-faint` line: `Restored your last setup.` and a `Start fresh` text button.
This is the detail that turns the launcher from a tool into a habit: your second run
of any prompt is one keystroke.

**States:**
- No prompt selected: center shows a single calm line, `Pick a prompt to begin.`,
  and Run is disabled (forest at 40% with no shadow).
- No prompts root set: `Set a prompts root in Settings.` + `Settings` link.
- No agents registered: Run disabled with a `--notice` line: `Add an agent in
  Settings to run.`
- Prompt with no body: still previews frontmatter; Run stays enabled.
- Launching: Run label becomes `Starting…`, terminal slides up underneath.

**Copy:**
- Title (top bar center): `Launch`
- Column heads: `Prompts` · `Context` · (column 3 is unlabeled, it's the console)
- Pickers: `Persona / skills` · `Memory` · `Project files`
- Run: button `Run` with `⌘↩`; disabled hint `Pick a prompt to begin.`
- Restore: `Restored your last setup.` · button `Start fresh`
- Tally: `3 skills · 2 memory · 1 file`

---

## D. House rules (enforce in review)

1. **Calm and present.** No alarm states, no red, no `⚠`, no exclamation marks in UI
   copy. Attention is earned with tan (`--notice`), never demanded. The diff viewer
   proves the rule: removals are heather, additions are forest.
2. **Tokens, not magic numbers.** Every color, space, radius, and type choice comes
   from §A. A literal hex or px in a new component is a review failure.
3. **Primitives, not raw HTML where it matters.** Reuse `TypeChip`, the badge, the
   list row, the modal card, the right panel, the new toast. Do not hand-roll a third
   button style.
4. **One mood.** Serif for ideas and reading (prompt preview, transcript, capture),
   sans for chrome, mono for machinery (paths, commands, diffs, keycaps). Never mix
   them within a single role.
5. **Inevitability over cleverness.** No animation longer than the existing 0.2–0.25s
   slides. No surface does two jobs. If a decision needs explaining in the UI, it's the
   wrong decision.
6. **Copy is quiet and human.** Facts and next steps, lower-stakes phrasing, no
   em-dashes in user-facing strings, no jargon, no "Oops".
7. **Shortcuts are accelerators, never the only door.** Every shortcut has a visible
   control.

---

## North star, in one breath

You wake up, open Agent Studio, press `⌘R`. Your morning prompt is already selected;
its words are right there in serif, and your last context bundle is restored — three
skills, two memory notes, the repo you're in. You glance, you adjust one chip, you
press `⌘↩`. The terminal rises and the agent is already working, fully briefed. You
never typed a path, never pasted a file, never explained yourself twice. That is the
moment: *this is how I want to start every session.*
