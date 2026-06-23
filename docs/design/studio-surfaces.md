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

### Document tabs

*Ticket TIN-1672. Extends the two-panel workspace (TIN-1640).*

Today a panel holds exactly one document. Opening a second from search replaces the
first, and the only way back to search is to clear the panel. That is the bug Rob
felt: the panel forgets where you were. The fix is to let a panel hold *several* open
documents, with Search always one click away, never closed.

**The hard question: two kinds of tabs.** A panel already has surface tabs
(Content / Links / Diff). We are adding document tabs (one per open file). They do
not compete, because they answer different questions:

- **Document tabs say *which note*** you are looking at. They live in a tab strip at
  the very top of the panel.
- **Surface tabs say *which face of that note*** — its Content, its Links, its Diff.
  They become a quiet sub-selector that belongs to the active document tab.

So the panel reads top to bottom: **document strip → surface strip → body.** Search
is not a fourth surface and not a separate mode; it is the **leftmost, permanent
document tab**. Selecting it shows the search/results view in the body and hides the
surface strip (search has no Content/Links/Diff). Selecting any document tab shows
that document and reveals the surface strip. This keeps one mental model — "tabs are
the things this panel holds, and Search is always the first one" — and means the
return to search costs exactly one click, with every open doc still sitting beside it.

This replaces the old rule where the Content surface-tab *was* either search or the
doc. Content is now always a document surface; search has graduated to its own pinned
tab. Links and Diff are unchanged in meaning, they now simply scope to the active
document tab.

**Tab-strip anatomy** (the new top row of each panel, height 36, `--hair-soft`
bottom border, `--bg-app`, horizontal, `--sp-1` gap):

```
┌ left panel ──────────────────────────────────────────────┐
│ ⌕ Search │ eas-build-gate │ launcher-spec ✕ │  + │      ✕ │
│ ───────── │  ▔▔▔▔▔▔▔▔▔▔▔▔▔ active                          │
├───────────────────────────────────────────────────────────┤
│ Content   Links   Diff                  ← surface strip    │
├───────────────────────────────────────────────────────────┤
│ … document body …                                          │
```

- **Order:** `[ ⌕ Search ] [ doc-a ] [ doc-b ] … [ + ]`, then the panel-close `✕`
  pushed to the far right (right panel only, unchanged behaviour).
- **Search tab:** leftmost, permanent, cannot be closed. A `⌕` glyph plus the word
  `Search` at the first open and whenever the panel is narrow it may collapse to the
  glyph alone (the tooltip carries `Search`). Active when no document is focused.
- **Document tab:** the file's `name` (frontmatter, falling back to the filename
  without `.md`), `--t-body`, truncated with ellipsis at ~140px, full name in the
  `title`. A close `✕` appears on hover and when active (see below). Click selects;
  it never opens search.
- **`+` new-doc affordance:** a single `+` ghost button after the last document tab.
  It selects the Search tab and focuses the search field — "add a document" means
  "go find one." (It does not open the New-file modal; that stays on `⌘N`. The `+`
  is about *opening*, not *creating*, matching what the row holds.)
- **Active / inactive / hover:**
  - *Active* — `--ink` text weight 600, a 2px `--forest` bottom rule (reuses the
    existing surface-tab active treatment, lifted to this row), background transparent.
  - *Inactive* — `--ink-soft` weight 400, transparent, no rule.
  - *Hover (inactive)* — background `--bg-field-strong`, text `--ink`. 0.1s ease,
    matching `ResultCard`.
  - The Search tab uses the same three states; it simply can't show a close `✕`.
- **Close `✕`:** `--ink-faint`, 12px, reusing the panel-close glyph. Shown on the
  active tab always and on any tab while hovered (so closing is discoverable without
  cluttering the resting row). Closing the active tab selects its **right neighbour**,
  or its left if it was last, falling back to the Search tab when no documents remain.
  Never red, never a confirm — the editor autosaves, so closing a tab loses nothing.
- **Overflow (many tabs):** the strip **scrolls horizontally**, it does not wrap and
  does not collapse into a menu. The Search tab and the `+` are *pinned* (Search left,
  `+` and panel-`✕` right) while the document tabs between them scroll under them.
  Selecting a tab off-screen (via `⌃Tab` or a click in another surface) scrolls it
  into view. No scrollbar chrome; a 12px `--bg-app` fade mask on each scrolling edge
  signals more. We choose scroll over an overflow menu because tab count per panel is
  expected in the low single digits and a menu would hide the very thing the row
  exists to show. (Revisit only if real use regularly exceeds ~8 per panel.)
- **At one document:** strip reads `⌕ Search │ note-name`. Calm, two items, the doc
  active. No `✕` until hover. This is barely louder than today's single-doc panel.
- **At zero documents (fresh panel):** strip reads `⌕ Search` plus a faint `+`.
  Search is active, the body is the search view. This is the default and the empty
  state in one — identical in feel to today's clean search-first panel. No regression.

**Surface strip (Content / Links / Diff).** Unchanged visually — same 36px row, same
forest underline — but it now renders **only when a document tab is active**, directly
beneath the document strip, and it scopes to that document. When Search is active the
surface strip is absent (search has no surfaces), so a fresh panel shows exactly one
strip, as today. Each document tab remembers its own active surface, so a doc opened
to its Diff stays on Diff when you tab away and back.

**Per-panel independence.** Each panel owns its own `tabs` list and its own
`activeTabId`. Opening, closing, reordering (future), and surface selection in the
left panel never touch the right. The shared `files` cache (keyed by path) is
unchanged: a document open in both panels still shares one set of contents and edits,
so autosave stays correct.

**⌘-click to the other panel.** Unchanged intent, new target. ⌘-clicking a search
result (or a future cross-link) opens that document as a **tab in the other panel**
and selects it there, revealing the right panel if it was closed — exactly the current
`makeOpenResult` routing, except it *appends a tab* instead of replacing the panel's
single doc. A plain click opens (or re-selects, if already open) the document as a tab
in the **same** panel. Opening a path already present in a panel selects its existing
tab rather than duplicating it.

**States.**
- *Empty* (no docs) → Search tab active, search view in the body. The resting state.
- *Dirty / unsaved* → **none.** The editor autosaves on a 300ms debounce
  (`makeEditorChange`), so there is no unsaved state to indicate and therefore no dot
  on a tab. We confirm this deliberately: adding a dirty dot would imply a save action
  the app doesn't have, and a `✕`-becomes-dot swap is exactly the kind of cleverness
  §D forbids. The `isSaving` word in the top bar remains the only save signal, and
  that is enough.
- *Loading a tab's document* → the body shows the existing `Loading…` line; the tab
  itself shows its name immediately (we have it from the search result / recents).

**Keyboard** (minimal, additive, consistent with §B's map — no new global chords that
collide):
- `⌘W` — **close the active document tab** in the focused panel. If Search is the
  active tab, `⌘W` is a no-op (Search is unclosable; we do not repurpose it to close
  the panel — `⌘\` already owns that). This is the one genuinely new binding and it
  earns its place: closing tabs is the new frequent act.
- `⌃Tab` / `⌃⇧Tab` — cycle to the next / previous tab in the focused panel, wrapping,
  Search included in the cycle. Non-`⌘` so it never fights the OS or the existing
  `⌘`-letter family.
- `⌘F` — unchanged, now means "select this panel's Search tab and focus the field"
  (previously it cleared the panel; same felt result, no doc is closed).
- No tab-numbering chords (`⌘1..9`). They would be a fourth way to do what click and
  `⌃Tab` already do, and the row is short. Restraint over completeness.

**Persistence.** Extends `agent-studio-layout` only; no new key. `PanelState` grows
from one path to a tab list:

```ts
type PanelTab = 'content' | 'links' | 'diff'        // unchanged: surface ids
interface OpenDoc { path: string; surface: PanelTab } // one open document tab
interface PanelState {
  tabs: OpenDoc[]            // open documents, left→right strip order
  activeTabId: string | null // a path, or null = Search tab is active
}
```

The Search tab is implicit (always present, leftmost) and so is *not* stored in
`tabs`; `activeTabId: null` is its selected state. On hydrate, restore every tab's
document into the `files` cache (today we restore one `activePath` per panel; now we
restore the union of both panels' `tabs`). A one-time migration reads any legacy
`{ activePath, activeTab }`: if `activePath` is set it becomes
`tabs: [{ path: activePath, surface: activeTab }], activeTabId: activePath`; if null it
becomes `tabs: [], activeTabId: null`. `rightOpen` and `leftWidth` are unchanged.

This keeps the whole feature inside the existing layout object, so a user who reopens
the app finds both panels with the same documents open, the same tab active, and the
same surface showing — the panel finally remembers where you were.

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

---

## Wiki-linking (TIN-1639)

Three surfaces that make a memory file a node in a graph, not a file in a folder:
the **Links tab** (who this note talks to, and who talks about it), the editor's
**`[[wiki-link]]`** rendering and autocomplete, and the full-canvas **Graph view**
(`⌘G`). They share the house voice exactly: forest on cream, serif for reading,
sans for chrome, mono for paths, calm and present, no alarm. Every value below is
a named token from §A. There is no new mood and no new primitive that an existing
one could carry.

The backend is built. A `file_links` command returns
`{ outbound: LinkedFile[], backlinks: LinkedFile[], tickets: { id, title }[] }`
where `LinkedFile = { path, name, type, projects[], excerpt }` — note this is the
same shape the link cards render, and a near-superset of `MemorySearchResult`, so
**link cards reuse `ResultCard`** verbatim. A `link_suggest` command returns
`{ name, path, slug }[]` for `[[` autocomplete. A `graph_data` command returns
`{ nodes: { id, label, kind: 'file' | 'ticket', domain, degree }[], edges: { from, to }[] }`.
Ticket titles may be empty; when a title is empty, show the bare ID.

One cross-surface rule, stated once: **a domain has one hue, everywhere.** The five
project domains map to tokens as follows, and this mapping is used identically by
the Links tab project chips, the editor link colour is domain-agnostic, and the
graph node fills:

| Domain | Fill token | Text/stroke token | Notes |
| --- | --- | --- | --- |
| `studio` | `--forest-tint` | `--forest` | The house accent. |
| `shared` | `--tan-tint` | `--tan` | The second accent. |
| `attic` | `--neutral-tint` | `--ink-soft` | Warm neutral. |
| `understory` | `--forest-wash` | `--forest` | Lighter forest, distinct from `studio`. |
| `website` | `--remove-wash` | `--remove` | Muted heather. The only place heather reads as identity, not removal; it is calm, never alarm, and there is still no red. |

This is the full palette for domains. No new colour is introduced. Tickets are not
a domain; they get their own treatment (below), never a domain hue.

---

### 1. Links tab (per open file)

Replaces the `links` stub in `WorkspacePanel.tsx` (`activeSurface === 'links'`,
~line 600). It renders inside the existing scroll body, under the surface strip,
scoped to the active document tab. It reuses the search column's geometry and the
`ResultCard` / `MetaBar` rhythm so it reads as the same app turned to look sideways.

**Container.** The same centered reading column the editor and search use:
`maxWidth: 680`, `width: 100%`, `margin: 0 auto`, `padding: 32px 24px 80px`
(literal values already established for `SearchView`; expressed in tokens this is
`padding: '${space[8]}px ${space[7]}px 80px'`, the trailing `80px` matching the
existing search/editor bottom gutter).

**Section order (top to bottom), each a labeled group:**

1. **Mentions** — Linear ticket mentions. First because they are the smallest,
   highest-signal payload and they answer "what work is this tied to?"
2. **Links out** — outbound links (this note points at these).
3. **Linked from** — backlinks ("who talks about this?").

This order goes near to far: the tickets this note names, then the notes it names,
then the notes that name it. A section with zero items is **omitted entirely** (no
empty headers); the all-empty case is the single calm empty state below.

**Section header.** Reuse the `--t-label` treatment (11 / 600 / sans, uppercase,
`0.04em`), colour `--ink-soft`, with a trailing count in `--ink-faint` at the same
size, e.g. `LINKS OUT  3`. Header sits on its own line, `marginBottom: space[3]`,
and each section after the first gets `marginTop: space[7]` for the established
section rhythm. No rule line between sections; the label and spacing carry it.

**1. Mentions (tickets).** A wrapped row of ticket chips, `gap: space[2]`,
`marginBottom` per the rhythm above. Each chip is a button:

- Layout: `padding: '3px 10px'`, `borderRadius: radius.chip`, `border:
  1px solid ${color.line}`, `background: transparent`, `color: color.inkSoft`,
  `fontFamily: font.mono`, `fontSize: 11`. Mono because a ticket ID (`TIN-1639`)
  is machinery, and this visually separates a ticket chip from a `TypeChip`.
- Content: the bare ID always, then, when `title` is non-empty, the title after a
  middot in `--ink-soft` sans at `--t-meta`: `TIN-1639 · Wiki-linking`. When
  `title` is empty, the chip is just `TIN-1639` and nothing else (never a dangling
  middot, never a placeholder like "Untitled").
- Hover: `background: color.forestWash`, `borderColor: color.forestLine`,
  `color: color.ink`, `transition: 'all 0.12s ease'` (matches `TypeChip`).
- Click: opens that ticket in the in-app Linear browser (the existing `LinearPanel`
  route). Title hint: `Open in Linear`.

**2 & 3. Links out / Linked from (cards).** Each item renders as a `ResultCard`,
unchanged: `padding: '12px 16px'`, `background: color.bgCard` resting /
`color.bgFieldStrong` on hover, `border: 1px solid ${color.hairSoft}` resting /
`color.line` on hover, `borderRadius: radius.card`, `marginBottom: space[2]`. The
card's `MetaBar` shows the type chip (`--forest-tint`/`--forest`) and project
chips (`--tan-tint`/`--tan`) exactly as in search; the title is `LinkedFile.name`
at 13 / 600 / `--ink`; the `LinkedFile.excerpt` is the one-line `--ink-soft`
preview. Because `LinkedFile` carries no `updated`/`created`, the `MetaBar` date
slot is simply absent (it already guards on an empty date string).

- **Active/selected state:** none persists in this tab — a link card is a
  navigation affordance, not a selection. Resting and hover only.
- **Click:** opens that file. Plain click opens it as a tab in **this** panel
  (re-selecting if already open); `⌘`-click opens it in the **other** panel,
  reusing the exact `onOpenResult` routing the search cards already use. Title
  hint reuses the card's existing string:
  `Click to open here · ⌘-click to open in the other panel`.

**Empty state (file has zero links of any kind).** The single existing `CalmEmpty`
primitive, replacing the current stub copy. Verbatim:

> Nothing links here yet. Mention a note with `[[` or a ticket like `TIN-1639`, and it shows up here.

(One calm line plus the next step. The `[[` and `TIN-1639` render in the line as
plain text; do not style them as live links inside the empty state.)

**Loading state.** While `file_links` is in flight, the shared loading voice:
a centered `--ink-soft` `--t-body` line, `paddingTop: 60`, copy `Reading links…`.

**Error state.** If `file_links` fails, the recessive notice block from §C:
`--notice` text on `rgba(155,123,90,0.08)`, `radius.md`, no icon, copy
`Could not read links for this note.` No retry button is required (re-selecting
the tab re-runs the query); if one is added it is a `Refresh` text button in
`--ink-soft`, never styled as alarm.

---

### 2. `[[wiki-link]]` in the editor

Three behaviours inside the Milkdown (Crepe) editor in `MarkdownEditor.tsx`:
inline rendering of resolved links, inline `TIN-XXXX` auto-linking, and the `[[`
autocomplete dropdown. All three stay inside the editor's serif reading frame and
borrow the existing `.ProseMirror a` colour so links never shout.

**Inline `[[slug]]` rendering (rendered/preview mode).** A resolved wiki-link
renders as inline text, not a button:

- Colour `--forest` (`#3E5641`), the same as `.ProseMirror a` already uses, so it
  sits in the forest-link family.
- **No underline at rest.** Instead a 1px bottom border in `--forest-line`
  (`rgba(62,86,65,0.30)`) — a quiet dotted-feel underline that reads as "linked"
  without the loud web-link underline. `text-decoration: none`,
  `border-bottom: 1px solid var(--forest-line)`, `cursor: pointer`.
- **Hover:** border strengthens to `--forest` (full strength) and `background:
  --forest-wash` with a `2px` horizontal padding and `--r-sm` so it reads as a
  soft chip on hover only. `transition: background 0.12s ease, border-color 0.12s ease`.
- The link displays the target's **name** (resolved via the slug), not the raw
  slug, when resolvable; an **unresolved** `[[slug]]` (no matching file) renders in
  `--ink-faint` with a `--hair` bottom border and `cursor: default` — present and
  legible, never a red "broken link." Title hint on unresolved: `No note named "slug" yet.`
- Click (resolved): opens that file as a tab in this panel (same routing as a link
  card, plain vs `⌘`-click).

**Inline `TIN-XXXX` auto-linking.** Any bare `TIN-` followed by digits in rendered
text becomes a link with the **same forest treatment as `[[ ]]`**, except the glyph
is mono (it is an ID): wrap the matched text in `font.mono` at the surrounding size,
`--forest`, `--forest-line` bottom border, same hover. Click opens the ticket in the
in-app Linear browser. This is the inline twin of the Mentions chip; one ID, two
calm presentations. Do not auto-link inside code spans or code blocks.

**The `[[` autocomplete dropdown.** Typing `[[` opens a picker driven by
`link_suggest`. It is a small floating menu, the calmest possible:

- **Surface:** `background: --bg-raised`, `border: 1px solid --hair`,
  `borderRadius: --r-lg`, `boxShadow: --shadow-toast` (the smallest house shadow,
  `0 4px 20px rgba(38,35,32,0.16)`), `padding: space[1]` around the rows,
  `overflow: hidden`.
- **Position:** anchored to the caret, opening **below** the `[[` by `space[2]`;
  if it would clip the viewport bottom, flip to open above. Left edge aligns to the
  `[` of `[[`. Width: `min(320px, …)` — wide enough for a name plus a type tag,
  capped at `320`.
- **Row:** `height: 32`, `padding: '0 ${space[3]}px'`, `borderRadius: --r-md`,
  `display: flex`, `alignItems: center`, `gap: space[3]`,
  `cursor: pointer`. Left: the suggestion **name** in `--t-body` (13/sans) `--ink`,
  truncated with ellipsis. Right (pushed with `marginLeft: auto`): a quiet type
  tag — reuse the `MetaBar` type-chip style (`--forest-tint` fill, `--forest` text,
  `1px 7px`, `--r-chip`, fontSize 10). The `slug`/`path` is **not** shown on the
  row (it is machinery the user does not pick by); the name and type are enough.
- **Selected / keyboard-focused row:** `background: --forest-wash`, text stays
  `--ink`. This is the established selected-row treatment (minus the 2px left
  border, which a floating menu doesn't need). Mouse hover sets the same state and
  moves the keyboard selection to that row, so mouse and keys never disagree.
- **Keyboard nav:** `↑`/`↓` move selection (wrapping), `↩` or `Tab` inserts the
  selected link and closes, `Esc` closes and leaves the literal `[[` typed text
  untouched. The first row is selected by default so `[[ + ↩` is a two-key insert.
- **Max rows:** **7** visible; beyond that the list scrolls (no count footer, no
  "more" affordance — 7 calm rows, the rest on scroll). Match against the typed
  query is the backend's job; the dropdown just renders what `link_suggest` returns.
- **Empty:** if `link_suggest` returns nothing for the current fragment, show a
  single non-interactive row, `--ink-faint` `--t-meta`, copy
  `No matches. Keep typing to name a new note.` (Naming a not-yet-existing note is
  valid; the link resolves once that note exists.)
- **Loading:** if suggestions lag, the menu shows one `--ink-faint` `--t-meta` row,
  `Searching…`, rather than flashing empty.

No animation beyond the 0.12s row transition; the menu appears and dismisses
instantly, like the command palette.

---

### 3. Graph view (`⌘G`) — full-canvas knowledge graph

A **full view** (per §B), in the same family as the transcript browser: it replaces
the main content column, the top bar persists with `← Agent Studio`, and the centre
reads `Graph`. It is the map of the whole memory: every file a node, every `[[ ]]`
or `TIN-` mention an edge. Add `⌘G` to the shortcut map (Graph, full view); it gets
a visible top-bar affordance like every other surface.

**Canvas.** Fills the content column. `background: --bg-app` (the app cream, so the
graph feels embedded, not in a dark "graph app" box). Pan by drag on empty canvas,
zoom by scroll/pinch, both with the standard 0.2s feel at most; a small `Reset view`
text button (`--ink-soft`, top-right of the canvas) returns to fit-all. No grid, no
axes, no minimap — calm, empty space.

**File nodes.** A filled circle per file:

- **Fill/stroke by domain** per the cross-surface table above (`studio` forest-tint
  fill + forest stroke, `shared` tan, `attic` neutral, `understory` forest-wash,
  `website` heather). Stroke is `1px` in the domain's text/stroke token. A node
  whose file spans multiple projects takes its **first** project's domain (one node,
  one hue); a tiny detail, but it keeps the field readable.
- **Size by degree.** Radius scales with `degree`: `r = 6 + 3 * sqrt(degree)`,
  clamped to `[6, 22]` px (at zoom 1). Degree 0 (orphan) is the floor, 6px. These
  are layout constants, not design tokens, and may live as named constants in the
  graph module; the **visible** sizes read as "bigger = more connected."
- **Label:** the node `label` in `--t-meta` (11/sans) `--ink-soft`, placed below the
  node, shown only when the node is large enough or zoomed in (hide labels below a
  zoom threshold to avoid clutter); the active/hovered node always shows its label
  in `--ink`.
- **Hover:** node stroke goes to full-strength domain colour, label brightens to
  `--ink`, and incident edges lift to `--forest-line`. Cursor pointer.
- **Click:** opens that file (same panel routing as a link card).

**Ticket nodes (distinct treatment).** Smaller, and clearly not a file: a small
**ring** (hollow circle), `r = 5` fixed, `stroke: --ink-faint` `1.5px`, `fill:
--bg-raised` (so it reads as an outlined token on the cream). Label is the ticket ID
in `--t-mono` (10–11/mono) `--ink-soft`. Tickets carry **no domain hue** — the
hollow-mono treatment is their identity. Click opens the ticket in the in-app Linear
browser. This keeps "file vs ticket" legible at a glance without a legend: filled +
serif-domain-hue = a note, hollow + mono = a ticket.

**Edges.** Thin lines, `stroke: --hair` (`rgba(38,35,32,0.10)`), `1px`, no
arrowheads (links are browsable both ways via the Links tab; the graph shows
relatedness, not direction — arrowheads would add alarming visual noise). On node
hover, that node's incident edges lift to `--forest-line`. Edges render beneath
nodes.

**Orphan nodes (degree 0).** Never hidden. They are laid out in a calm **shelf
along the bottom of the canvas**: a single horizontal band, left-aligned, wrapping,
under a faint `--t-label` `--ink-faint` divider labelled `NOT YET LINKED`. They use
the normal file-node treatment at floor size (6px) so they are discoverable and one
click from being opened and linked. This makes orphans a gentle to-do ("these notes
are waiting to be connected"), not an error. The shelf is omitted when there are no
orphans.

**Filter chips.** Reuse the search view's chip row exactly: a wrapped
`gap: space[2]` row pinned to the top-left of the canvas (in a `--bg-field` pill
strip so it floats legibly over nodes), using `TypeChip`. Two groups separated by
the same 1px `--hair` divider the search view uses:

- **Type** chips (`feedback` `project` `user` `reference`, from `knownTypes`) — dim
  nodes whose file type is deselected.
- **Project** chips (`attic` `understory` `website` `studio` `shared`) — dim nodes
  outside the selected project.

Filtering **dims** (drops to ~18% opacity) rather than removes, so the graph's shape
stays stable and you see what you're excluding; their edges dim with them. A `Tickets`
toggle chip at the end of the row shows/hides ticket nodes (default on). All
multi-select, all-off = all-shown (matches search filter behaviour).

**Layout: recommendation.** Use **d3-force** (MIT licensed). A knowledge graph's
whole value is legible clustering, neighbours near neighbours, and a hand-rolled
deterministic layout (radial/grid) cannot surface the community structure that makes
this view worth opening; it would look tidy and say nothing. d3-force gives that for
~a few hundred nodes with no perf concern, it is a tiny, well-trodden, permissively
licensed dependency, and it pairs cleanly with a plain `<canvas>` or `<svg>` render
(we draw the nodes ourselves with tokens; d3-force only computes positions). **Add
the `d3-force` dependency** (just `d3-force`, not all of `d3`). Pin the simulation
after it settles (stop ticking once `alpha` decays) so the graph is calm and still,
not perpetually jittering, and seed positions from the previous layout when
re-opening so the map feels stable run to run. Orphans are excluded from the force
sim and placed on the shelf deterministically.

**Empty state (no links anywhere yet).** The shared calm full-view empty: a single
centered `--ink-faint` `--t-body` line plus one next step, no illustration. Verbatim:

> No connections yet. Link notes with `[[` or mention a ticket, and your graph grows here.

If there are nodes but **no edges** (all orphans), skip the empty state and show the
`NOT YET LINKED` shelf as the whole canvas — the orphans are the content, and the
shelf's own label already says what's going on.

**Loading.** Centered `--ink-soft` `--t-body` `Drawing your graph…` while
`graph_data` loads. **Error:** the recessive notice block, `Could not load the graph.`

**States summary (graph):** default (settled force layout) · hover (node + incident
edges lift) · selected (none persists; click navigates) · filtered (deselected nodes
dim to ~18%) · orphan-shelf · empty · loading · error. No state uses red, an icon
alarm, or motion longer than 0.2s.

---

### Wiki-linking copy (verbatim, collected)

Curly apostrophes in prose; no em-dashes; mono for IDs and the `[[` token where shown.

**Links tab**
- Section headers: `MENTIONS` · `LINKS OUT` · `LINKED FROM` (each with a trailing count)
- Ticket chip (with title): `TIN-1639 · Wiki-linking` · (no title): `TIN-1639`
- Ticket chip hint: `Open in Linear`
- Card hint (reused): `Click to open here · ⌘-click to open in the other panel`
- Empty: `Nothing links here yet. Mention a note with [[ or a ticket like TIN-1639, and it shows up here.`
- Loading: `Reading links…`
- Error: `Could not read links for this note.`

**Editor**
- Unresolved link hint: `No note named “slug” yet.`
- Autocomplete empty: `No matches. Keep typing to name a new note.`
- Autocomplete loading: `Searching…`

**Graph**
- Top-bar centre title: `Graph`
- Orphan shelf label: `NOT YET LINKED`
- Tickets toggle chip: `Tickets`
- Reset button: `Reset view`
- Empty: `No connections yet. Link notes with [[ or mention a ticket, and your graph grows here.`
- Loading: `Drawing your graph…`
- Error: `Could not load the graph.`

---

SELF-REPORT: confidence: high; model-fit: right (design judgment + token discipline + reuse mapping across a large existing spec; a cheaper model would likely have invented primitives or missed the no-red / no-em-dash-in-copy nuance).

---

## Frontmatter manager (TIN-1638)

Three surfaces that make a memory file's frontmatter feel *taken care of* rather
than *demanded*: **smart generation on create** (the file arrives already
described), the **import flow** (existing `.md` files come in already described),
and the **audit view** (`⌘⇧A` — the library's quiet self-portrait of what's still
loose). They share the house voice exactly: forest on cream, serif for reading,
sans for chrome, mono for paths, calm and present, no alarm. Every value below is
a named token from §A. No new primitive is introduced that an existing one
(`ResultCard`/`MetaBar`, `TypeChip`, the modal card, `CalmEmpty`, the full-view top
bar, the recessive `--notice` block) cannot carry.

The backend is built (`lib/frontmatter.ts`):

- `suggestFrontmatter(content)` → `Suggestion = { name, title, type, projects[],
  tags[], created, status }` — rule-based, instant, local. Drives Surfaces 1 and 2.
- `auditFrontmatter()` → `AuditEntry[] = { path, status:
  'complete'|'partial'|'missing', type, projects[], created, docStatus, missing[] }`,
  unhealthy first. Drives Surface 3.
- `importMarkdown(content, frontmatter)` → writes `{root}/{firstProject}/{slug}.md`,
  returns the path. Commits Surface 2.

**One cross-surface decision, stated once: the result-card preview is the trust
device.** In every surface where a user edits frontmatter (create, import, audit
fix), we render a live `ResultCard` showing exactly how this note will read in
search, built from the current field values. The fields edit the card you can see;
nothing is abstract. This reuses `ResultCard` / `MetaBar` verbatim by adapting the
`Suggestion`/`AuditEntry` to the `MemorySearchResult` shape the card already
renders (the `linkedToResult` adapter from §Wiki-linking is the established
pattern; add a sibling `suggestionToResult` / `auditToResult`). The preview is
never a separate styled box — it is the actual search card, so "the card will look
like this" is literally true.

**The health language, stated once (the no-alarm core).** A file is never
"invalid," never "wrong," never flagged. Three calm states, one hue each, plain
words:

| Audit status | Dot | Word | Token (dot + text) | Reading |
| --- | --- | --- | --- | --- |
| `complete` | ● filled | `Described` | `--forest` on `--forest-wash` | Quietly affirmed. The note is taken care of. |
| `partial` | ◐ half | `Needs a little` | `--notice` (tan) on `rgba(155,123,90,0.08)` | An invitation, not a fault. |
| `missing` | ○ ring | `Not described yet` | `--ink-faint` dot, `--ink-soft` text | Simply undone, like an empty field. The calmest of the three, never the loudest. |

The dots are drawn glyphs (`●` / `◐` / `○`) in the status hue, 8px, never traffic
lights, never `✗`/`⚠`. The deliberate inversion of the usual alarm grammar:
`missing` — the "worst" state — is rendered the *quietest* (faint ring, no colour),
because a note nobody has described yet is not an emergency, it is just a note
waiting. `partial` carries the one warm accent (tan) because it is the most
*actionable* state: one field away from done, the place a gentle nudge actually
helps. Nothing red, nothing demands; tan invites, faint recedes.

---

### Surface 1 — Smart generation on create

Upgrades the existing `NewFileModal` (in `app/page.tsx`) and the `handleFileCreated`
flow. The principle: **the modal must not get heavier.** Today's modal already
asks for Name, Type, Project(s), Tags. Smart generation does not *add* a step — it
**fills the fields that are already there** and adds one quiet preview. The user's
job shrinks from "describe this note" to "glance, maybe adjust, confirm."

**Shape: the same 480-wide cream modal card** (`--bg-raised`, `--r-lg`,
`--shadow-modal`, padding `--sp-7`, scrim `--scrim`), same title treatment, same
field rhythm and the same `Cancel` / primary-button footer. We change three things:

1. **A body field becomes the seed.** Below `Name`, add one borderless serif
   textarea (the `QuickCapture` content treatment: `--font-serif`, 15 / 1.6,
   transparent, no border, `rows={4}`), placeholder `Paste or write the note. We
   will describe it for you.` This is optional — the modal still works name-only —
   but it is the input `suggestFrontmatter` reads.

2. **Suggestion fills the existing fields, live.** As the user types into Name or
   the body (debounced 300ms, matching the editor autosave debounce), call
   `suggestFrontmatter(content)` and **pre-select** the suggested `type`, the
   suggested `projects` chips, and populate `tags`. These are not a separate
   "suggestion panel" — they land *in the Type / Project(s) / Tags rows that
   already exist*, as the active `TypeChip` selections. The suggestion is invisible
   as a mechanism; it simply means the fields arrive correct. A single quiet line
   sits under the field group, `--t-meta` `--ink-faint`: `Described from your
   note.` with a trailing `Regenerate` text button (`--ink-soft`, hover `--ink`).
   The user never has to know a model ran; they only notice the fields were already
   right.

3. **The preview card sits at the bottom**, above the footer, under a `--hair`
   rule: a live `ResultCard` (resting state, not interactive — `cursor: default`,
   no hover lift) built from the current field values via `suggestionToResult`.
   Headed by a `--t-label` `--ink-soft` line: `HOW THIS WILL LOOK`. This replaces
   the old standalone `Slug:` hint line (the slug now reads inside the card's
   path/name); keep the slug visible as the card's `name`. The preview is the proof
   that the fields mean something.

**Layout, top to bottom:** title `New memory file` → `Name` field (unchanged) →
the serif body seed → `Type` chip row (pre-selected) → `Project(s)` chip row
(pre-selected) → `Tags` field (pre-filled) → `Described from your note.
Regenerate` line → `--hair` rule → `HOW THIS WILL LOOK` + preview `ResultCard` →
footer (`Cancel` secondary, `Create file` primary).

**Regenerate.** Re-runs `suggestFrontmatter` against the current body and **resets
the fields to the fresh suggestion**, discarding manual edits to type/projects/tags
(Name is never touched — it is the user's). It is a deliberate "start the
description over" act, so it does not silently clobber on every keystroke; the
debounced auto-fill only runs while a field is still at its suggested value
(untouched). Once the user edits a field by hand, auto-fill stops touching *that*
field — their choice wins — and `Regenerate` is the explicit way to ask again.

**States:**
- *Default (empty)* — name-only flow, fields at their existing defaults, no
  `Described from…` line yet, preview card shows the empty-ish note (name
  placeholder italic in `--ink-faint`). Identical in weight to today's modal.
- *Suggesting* — while the debounced call is in flight, the `Described from your
  note.` line reads `Describing…` in `--ink-faint`. No spinner.
- *Suggested* — fields populated, line reads `Described from your note.` +
  `Regenerate`.
- *Editing (manual)* — a user-touched chip/field stays as the user set it; the
  line drops the participle and reads `Described, with your edits.`
- *Creating* — primary button reads `Creating…`, disabled, per today's modal.
- *Error* — the existing recessive notice (`--notice` on `rgba(155,123,90,0.08)`,
  `--r-md`): copy unchanged from today for validation (`Name is required.` etc.),
  and `Could not create the file. Your work is still here.` for a write failure.

**Copy (verbatim):**
- Body placeholder: `Paste or write the note. We’ll describe it for you.`
- Describe line: `Describing…` · `Described from your note.` · `Described, with
  your edits.`
- Regenerate button: `Regenerate`
- Preview label: `HOW THIS WILL LOOK`
- Buttons (unchanged): `Cancel` · `Create file` / `Creating…`
- Write error: `Could not create the file. Your work is still here.`

---

### Surface 2 — Import flow

A modal to bring existing `.md` files into memory. Triggered two ways, both with a
visible affordance: **drag-and-drop** of `.md` files onto the window, and **`⌘O`**
(native file picker, `open` from `@tauri-apps/plugin-dialog`, `multiple: true`,
`.md` filter). Add `⌘O` to the §B shortcut map (Import, modal) with a top-bar
control.

**The drag affordance (what the window shows while dragging).** No modal yet — the
whole window gets a calm drop veil: a `--scrim`-light wash (`rgba(38,35,32,0.06)`,
the `--neutral-tint` value) over the content, and a centered floating card
(`--bg-raised`, `--r-lg`, `--shadow-modal`, padding `--sp-7`) with one serif line
`--t-display` `--ink`: `Drop Markdown files to import.` and one `--t-meta`
`--ink-faint` sub-line: `We’ll describe each one before anything is saved.` A
`2px dashed --forest-line` inset border on the card edge signals the target. No
icon, no bounce; the veil fades in over 0.15s. On drop, the veil becomes the import
modal. Dragging non-`.md` files shows the same veil with the sub-line replaced by
`Only .md files come in here.` in `--ink-faint` (calm, not a rejection buzz).

**The modal shell.** The 560-wide cream card (matching `SettingsModal`'s width,
since import is the heavier of the two — it carries a preview and a queue), title
`Import notes` (`--t-title`). Two arrangements by count:

**Single file** — the modal *is* one per-file editor (see below), footer
`Cancel` / `Import` (primary). Quiet, no queue chrome.

**Multiple files (bulk)** — a **left queue rail (~200) + right per-file editor**,
inside the same card:

- **Queue rail.** A vertical list, one row per dropped file. Each row: the filename
  (`--t-body`, truncated from the left so the stem stays visible, `--font-mono` for
  the name since it is a path leaf) over a status line. Status uses the **same calm
  dot grammar as the audit** but scoped to the import lifecycle:
  - `○ Pending` — `--ink-faint` ring + `--ink-soft` text. Not yet reviewed.
  - `◐ Reviewed` — `--notice` half-dot + text. Looked at, edits made, ready.
  - `● Imported` — `--forest` filled dot + `--forest` text. Written to disk.
  The active row uses the standard list-row selected treatment (`--forest-wash`
  fill, 2px `--forest` left border). Rows are click-to-select; selecting loads that
  file into the editor on the right. A `--t-meta` `--ink-faint` tally pinned to the
  rail bottom: `2 of 5 imported.`
- **Per-file editor (right).** Identical fields to Surface 1, but seeded by *the
  file*: if the dropped file **already has frontmatter**, parse it and show it for
  review (fields pre-filled from the file, the describe-line reads `From this
  file’s frontmatter.`); if it has **none**, run `suggestFrontmatter` on the body
  and show the suggestion (`Described from the note.`). Below the fields, the same
  `HOW THIS WILL LOOK` preview `ResultCard`. Above the fields, the source path in
  `--t-mono` `--ink-faint`, truncated from the left.

**Step-through + bulk-confirm.** The footer carries both rhythms:
- A primary `Import this one` button commits the active file (calls
  `importMarkdown`), marks it `● Imported`, and **auto-advances to the next
  `Pending` file** — the step-through. When the last is done, the button becomes
  `Done`.
- A secondary `Import all 5` button (count live) bulk-commits every `Pending` /
  `Reviewed` file in sequence, each row flipping to `● Imported` as it lands, then
  closes to a toast. This is the "I trust the suggestions, take them all" path.
- `Cancel` closes without writing; already-imported files stay imported (writing is
  per-file and committed, never rolled back — honest, never a surprise).

**Toast on completion** (the shared toast primitive): `Imported 5 notes.` with a
trailing `Show in search` text button that runs a search scoped to the imported
paths. Single-file: `Imported to {project}.` + `Open` (matches QuickCapture's
toast).

**States:**
- *Dragging* — the drop veil (above).
- *Empty queue / picker cancelled* — modal does not open; no-op.
- *Reviewing* — default, per-file editor populated.
- *Importing one* — that row’s dot animates from `◐` to `●` (opacity cross-fade
  0.15s, no motion); primary button reads `Importing…` briefly.
- *Importing all* — rows flip top-down; the `Import all` button reads `Importing 3
  of 5…`.
- *Per-file import error* — the row keeps its pre-import status and gains a
  `--notice` sub-line `Could not import this one. Still here to retry.`; the bulk
  run continues past it (honest partial success), and the final toast reads
  `Imported 4 notes. One is still waiting.`
- *Duplicate target path* — if `importMarkdown` would overwrite, the editor shows a
  recessive `--notice` line under the path: `A note already lives at this path.
  Change the name or project to keep both.` (calm, names the fix, never blocks
  loudly).

**Copy (verbatim):**
- Drag veil: `Drop Markdown files to import.` · sub `We’ll describe each one before
  anything is saved.` · non-md sub `Only .md files come in here.`
- Title: `Import notes`
- Source path label: (the path itself, no label)
- Describe line: `From this file’s frontmatter.` · `Described from the note.`
- Preview label: `HOW THIS WILL LOOK`
- Queue statuses: `Pending` · `Reviewed` · `Imported`
- Queue tally: `2 of 5 imported.`
- Buttons: `Import this one` · `Import all 5` · `Importing…` · `Importing 3 of 5…`
  · `Done` · `Cancel`
- Single-file buttons: `Import` · `Cancel`
- Duplicate notice: `A note already lives at this path. Change the name or project
  to keep both.`
- Per-file error: `Could not import this one. Still here to retry.`
- Toast (bulk): `Imported 5 notes.` + `Show in search`
- Toast (single): `Imported to studio.` + `Open`
- Toast (partial): `Imported 4 notes. One is still waiting.`

---

### Surface 3 — Audit view (`⌘⇧A`)

A **full view** (per §B), same family as the transcript browser: it replaces the
main content column, the top bar persists with `← Agent Studio`, and the centre
reads `Frontmatter`. Add `⌘⇧A` to the §B shortcut map (Audit, full view) with a
visible top-bar affordance. This is the surface that literally surfaces "problems,"
so it is where the no-alarm rule earns its keep: it must read as a **calm
self-portrait of the library**, a gentle to-do, never a list of errors.

**Top bar.** `← Agent Studio` left, `Frontmatter` centred (`--t-title`), and on the
right a single quiet summary line in `--t-meta` `--ink-soft`: `48 described · 6
need a little · 2 not yet.` This headline is the whole emotional frame — it leads
with the *good* count, names the loose ones in plain words, and never totals them
as a "problem count."

**Filter chips.** Below the top bar, a `--bg-field` pill strip (matching the search
filter row and the graph filter strip), `gap: --sp-2`, using `TypeChip`:
`All` · `Need a little` · `Not yet`. Default `All`. (Three chips only — these map
to `complete`+`partial`+`missing` / `partial` / `missing`. There is no lone
"described/complete" filter because a library of finished notes is not something
you go *looking* for; you filter to find what is still loose.) A trailing
`Fix all` text button (`--forest`, weight 600) sits at the right of the strip when
any partial-or-missing file exists.

**The list (rows, not a dense table).** `auditFrontmatter()` returns unhealthy
first; render in that order. Each row reuses the **list-row** primitive (`8px 16px`,
hover `--bg-field-strong`, selected `--forest-wash` + 2px `--forest` left border) —
*not* a spreadsheet grid, because a grid of statuses reads as a defect report. A
row, left to right:

- **Health dot + word** (fixed ~150 left column): the calm dot (`●` / `◐` / `○`)
  in its status hue + the word `Described` / `Needs a little` / `Not yet`
  (`--t-body`, the dot's text hue). This is the only "status" the eye lands on, and
  it reads as a state of grace, not a grade.
- **Name** (`--t-body` 13 / 600 `--ink`) over the **path** (`--t-mono` `--ink-faint`,
  truncated from the left). The note's identity.
- **Type chip + project chips** — the `MetaBar` treatment exactly (`--forest-tint`
  type, `--tan-tint` projects). When `type` is absent, *no* empty chip — instead a
  `--t-meta` `--ink-faint` italic word in the type slot: `no type yet`. Same for
  projects: `no project yet`. Plain language fills the gap; nothing is blank-and-red.
- **Created** (`--t-meta` `--ink-faint`, right-aligned) — the date, or the word
  `undated` in `--ink-faint` when absent.
- **What's loose** (only on `partial`/`missing` rows, a trailing `--t-meta`
  `--notice` phrase built from `missing[]`): `needs a type` · `needs a project` ·
  `needs a created date`, joined naturally — `needs a type and a created date`.
  This is the actionable heart, in the one warm accent, phrased as a need not a
  fault. `complete` rows show nothing here — silence is the affirmation.

**Click a row** → opens that file's frontmatter editor. Reuse the **per-file editor
from Surface 2** presented as a centered modal over the audit view (the modal-over-
full-view stacking §B allows): same fields, same `HOW THIS WILL LOOK` preview, but
seeded from the existing file and committing an in-place rewrite (not a new
`importMarkdown` — a `save`/update of the same path). Footer `Cancel` / `Save`. On
save, the row's health dot re-resolves live (a `◐`→`●` cross-fade) and the
top-bar summary recounts. The library heals in front of you, one calm dot at a time.

**Fix all.** The `Fix all` button **steps through the unhealthy files** in order:
it opens the first partial/missing file in that same editor modal, and the footer
gains a `Save and next →` primary (alongside `Skip` secondary). Saving advances to
the next unhealthy file; `Skip` advances without writing. A `--t-meta` `--ink-faint`
progress line in the modal header: `2 of 8.` When the last is handled, the modal
closes and the summary updates. This turns the chore into a quiet, finite pass —
the same step-through rhythm as the bulk import, so the two "work through a list"
moments feel identical.

**States:**
- *Default* — the list, unhealthy first, filter `All`.
- *Loading* — centered `--ink-soft` `--t-body`: `Reading your library…`
- *Filtered to empty* (e.g. `Not yet` with none missing) — `CalmEmpty`: `Nothing
  here needs that. Try another filter.`
- *All-healthy (the reward state)* — when every file is `complete`, the whole view
  becomes a single `CalmEmpty`, centered, no list, no chips: a `--t-display`
  `--ink` line `Every note is described.` and a `--t-meta` `--ink-faint` sub-line
  `Your library is tidy. Nothing to do here.` The `Fix all` button is absent. This
  is the only place the manager celebrates, and it does so by going quiet — the
  most affirming state is an empty, restful screen.
- *Error* — recessive notice block: `Could not read the library just now.` with a
  `Refresh` text button (`--ink-soft`).
- *Empty library (no files at all)* — `CalmEmpty`: `No notes yet. Create one with
  ⌘N and it shows up here.`

**Copy (verbatim):**
- Top-bar centre title: `Frontmatter`
- Summary: `48 described · 6 need a little · 2 not yet.`
- Health words: `Described` · `Needs a little` · `Not yet`
- Filter chips: `All` · `Need a little` · `Not yet`
- Missing-field gap words: `no type yet` · `no project yet` · `undated`
- What's-loose phrases: `needs a type` · `needs a project` · `needs a created date`
  (joined with `and`, e.g. `needs a type and a created date`)
- Fix-all button: `Fix all`
- Editor step-through: `Save and next →` · `Skip` · header `2 of 8.`
- Editor (single): `Save` · `Cancel`
- Loading: `Reading your library…`
- Filtered-empty: `Nothing here needs that. Try another filter.`
- All-healthy: `Every note is described.` · sub `Your library is tidy. Nothing to
  do here.`
- Empty library: `No notes yet. Create one with ⌘N and it shows up here.`
- Error: `Could not read the library just now.` + `Refresh`

---

### How the audit stays calm (the no-alarm design, stated plainly)

The audit's job is to surface incomplete files. Every instinct in tooling says:
red badges, a `⚠` per row, a "12 errors" count, a sortable Status column that reads
like a build failure. We do none of it, and the file is *more* legible for it:

1. **Lead with the good number.** The summary is `48 described · 6 need a little ·
   2 not yet` — the eye lands on 48, not on a problem count. The library is mostly
   fine, and the frame says so.
2. **Invert the alarm grammar.** The "worst" state (`missing`) is rendered the
   *quietest* — a faint ring, `--ink-faint`, no colour. The most *actionable* state
   (`partial`) carries the one warm accent (tan `--notice`), because that is where a
   nudge pays off. Nothing recedes harder than red would shout.
3. **Plain words, never glyphs of alarm.** `Needs a little`, `Not yet`, `needs a
   type`. A blank field becomes `no type yet`, not an empty-red cell. The dots are
   `●◐○`, never `✗`/`⚠`. No exclamation marks anywhere.
4. **No red, by token.** There is no red token to reach for (§D); `partial` uses
   `--notice` (tan), `complete` uses `--forest`, `missing` uses `--ink-faint`. The
   strongest colour on the screen is the calm forest of a *finished* note.
5. **The reward is silence.** A fully-described library is an empty, restful screen
   (`Every note is described.`), not a green check-laden dashboard. Done looks like
   peace.
6. **Every loose file is an invitation, made finite.** `Fix all` turns the list
   into a short, countable pass (`2 of 8`), the same gentle step-through as import.
   The user is never confronted with a wall of red; they are offered a calm
   sequence and a clear end.

---

SELF-REPORT: confidence: high; model-fit: right (cross-surface design judgment, token discipline, and reuse mapping over a large existing spec, plus the load-bearing nuance of inverting alarm grammar so `missing` reads quietest while staying honest; a cheaper model would likely have reached for a status grid, a red/✗ vocabulary, or invented a new preview primitive instead of reusing ResultCard).

---

## Dark theme (TIN-1673)

The same room at night. Not a second app — the cream room with the lights down: a
warm near-black instead of paper, a soft warm off-white instead of ink, the forest
still the accent, heather and tan re-tuned so they read against dark instead of
disappearing into it. Every house rule carries over unchanged: no red, no alarm,
removals stay calm, attention is earned in tan not demanded. The light theme is
forest-on-cream; this is forest-on-ember.

Two anchors set the whole mood and everything else hangs off them:

- **`--bg-app` = `#1A1815`** — a warm near-black. Brown-black, not slate; it is the
  cream `#F2F0ED` taken down to embers, keeping the same hue family so the room is
  recognisably ours. (Cold `#0F1115`-style slates are explicitly rejected.)
- **`--ink` = `#ECE7DF`** — a soft warm off-white, never `#FFF`. It is the light
  theme's cream lifted to a text weight; pure white on a warm dark reads clinical
  and buzzes, this reads like warm paper at night.

### Inversion principle (how the light values map)

The light theme builds backgrounds from **white at low alpha over cream** and lines
from **ink at low alpha over light**. In dark, both invert: backgrounds are **warm
white at low alpha over the near-black** (so raised surfaces get *lighter*, as they
must), and hairlines/tints are **warm white at low alpha** (light-on-dark overlays),
*not* the light theme's dark-on-light. The forest/tan/heather hues lighten and
slightly desaturate so they sit on dark without glowing. Alphas are nudged up a
touch because overlays read fainter on dark than on light.

### Token → dark value (every `color` key)

Paste-ready for a `[data-theme="dark"]` block. Names match `lib/tokens.ts` /
`globals.css` exactly.

| Token | Dark value | Note |
| --- | --- | --- |
| `bgApp` / `--bg-app` | `#1A1815` | Warm near-black. App background, top bar. |
| `bgRaised` / `--bg-raised` | `#23211D` | Modals, panels, menus. One warm step up from bgApp. |
| `bgField` / `--bg-field` | `rgba(255,250,242,0.06)` | Inputs, search fields. Warm-white veil, not white-white. |
| `bgFieldStrong` / `--bg-field-strong` | `rgba(255,250,242,0.10)` | Hovered cards, inline inputs. |
| `bgCard` / `--bg-card` | `rgba(255,250,242,0.04)` | Resting result cards. Barely-there lift. |
| `ink` / `--ink` | `#ECE7DF` | Primary text. Soft warm off-white. |
| `inkSoft` / `--ink-soft` | `#A8A199` | Secondary text, labels. |
| `inkFaint` / `--ink-faint` | `#766F66` | Tertiary text, timestamps, hints. |
| `forest` / `--forest` | `#8FB089` | Primary accent. Sage-lifted forest — the dark-room forest. |
| `forestTint` / `--forest-tint` | `rgba(143,176,137,0.16)` | Type chips, forest badges. |
| `forestLine` / `--forest-line` | `rgba(143,176,137,0.36)` | Active card border. |
| `forestWash` / `--forest-wash` | `rgba(143,176,137,0.10)` | Active card fill, selected row. |
| `tan` / `--tan` | `#C9A57E` | Project accent. Warmer, lighter tan. |
| `tanTint` / `--tan-tint` | `rgba(201,165,126,0.16)` | Project chips, project badges. |
| `hair` / `--hair` | `rgba(255,250,242,0.10)` | Standard hairline / divider. |
| `hairSoft` / `--hair-soft` | `rgba(255,250,242,0.07)` | Card border, lighter divider. |
| `neutralTint` / `--neutral-tint` | `rgba(255,250,242,0.06)` | Neutral badge, `attic` domain. |
| `line` / `--line` | `rgba(255,250,242,0.18)` | Input border, control border. |
| `scrim` / `--scrim` | `rgba(8,7,6,0.60)` | Modal overlay. Darkens the dark — must read as a layer below the raised card. |
| `termBg` / `--term-bg` | `#15140F` | Terminal surface. Nudged *below* bgApp so the terminal still reads as its own well. |
| `termFg` / `--term-fg` | `#D4D0CB` | Terminal text. Unchanged — already warm, still clears AA on the new termBg. |
| `add` / `--add` | `#8FB089` | Diff additions, "saved". Same as forest. Forest, not green-LED. |
| `addWash` / `--add-wash` | `rgba(143,176,137,0.14)` | Added-line background. Light-on-dark. |
| `remove` / `--remove` | `#B9A6C6` | Diff removals. Lifted heather, never red. |
| `removeWash` / `--remove-wash` | `rgba(185,166,198,0.14)` | Removed-line background. Light-on-dark. |
| `notice` / `--notice` | `#C9A57E` | "Out of date", "unsaved". Same as tan. Attention without alarm. |

Shadows also need re-tuning for dark (the light theme's `rgba(38,35,32,…)` ink
shadows vanish on a near-black). Deepen them and lean on the `bgRaised` step +
hairline for separation rather than the shadow alone:

| Token | Dark value |
| --- | --- |
| `--shadow-modal` | `0 20px 60px rgba(0,0,0,0.55)` |
| `--shadow-panel` | `-4px 0 24px rgba(0,0,0,0.40)` |
| `--shadow-toast` | `0 4px 20px rgba(0,0,0,0.45)` |

The `globals.css` hard-coded bits move into the theme blocks too: the
`::-webkit-scrollbar-thumb` (`rgba(255,250,242,0.14)` / hover `0.24` in dark), the
`html, body` background (`#1A1815`), and the Milkdown/ProseMirror `color`,
`caret-color`, link, and blockquote values, which currently hard-code `#262320` /
`#3E5641` / `#6B6760` — these should reference the ink/forest/inkSoft tokens so they
follow the theme. The `hljs` code-highlight block is already a dark theme and stays.

### Contrast checks (verified, sRGB WCAG 2.x)

Computed against the anchors above. AA is 4.5:1 for body text, 3:1 for large text
and UI accents.

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `ink` `#ECE7DF` on `bgApp` `#1A1815` | **14.4 : 1** | AAA — body text. The anchor pair. |
| `ink` on `bgRaised` `#23211D` | 13.1 : 1 | AAA — text on modals/panels. |
| `inkSoft` `#A8A199` on `bgApp` | **6.9 : 1** | AA (passes AAA for large). Secondary text, labels. |
| `inkSoft` on `bgRaised` | 6.3 : 1 | AA. |
| `inkFaint` `#766F66` on `bgApp` | 3.6 : 1 | Passes AA for large/non-essential (timestamps, hints, placeholders) by design — same role as in light. |
| `forest` `#8FB089` on `bgApp` | **7.4 : 1** | AA. Accent text, active state, `add` gutter. |
| `forest` on `bgRaised` | 6.7 : 1 | AA. |
| `tan` `#C9A57E` (= `notice`) on `bgApp` | 7.7 : 1 | AA. Project accent, notice text. |
| `remove` `#B9A6C6` heather on `bgApp` | 7.9 : 1 | AA. Diff removals — calm, never red. |
| `add` text on `addWash`-over-`bgApp` | 5.8 : 1 | AA. The diff add line reads. |
| `remove` text on `removeWash`-over-`bgApp` | 6.1 : 1 | AA. The diff remove line reads. |
| `termFg` `#D4D0CB` on `termBg` `#15140F` | 11.5 : 1 | AAA. Terminal unaffected. |

Body ink on app background clears AA (and AAA) with wide margin; every accent used
as text clears AA. `inkFaint` intentionally sits at the large-text AA threshold for
its tertiary role, matching its light-theme counterpart (`#9B9490` on cream ≈ 2.7:1
there, so dark `inkFaint` is in fact *more* legible than light's).

### Washes, tints, and overlays (the light-on-dark rule)

The single rule: **on dark, every tint/wash/hairline is a light overlay, never a
dark one.** The light theme's `rgba(38,35,32,…)` (ink-over-light) values would paint
*darker* smudges on the near-black and read as holes. They all flip to warm-white or
the lifted-accent hue:

- **Neutral structure** (`hair`, `hairSoft`, `neutralTint`, `line`, the three
  `bg*` field surfaces, scrollbar): warm white `rgba(255,250,242,α)`. Alpha bumped
  ~+0.04 over the obvious inversion because a light veil reads fainter on a dark base
  than a dark veil reads on a light one. `line` (control borders) is the strongest
  at `0.18`; `bgCard` the faintest at `0.04`.
- **Forest washes/tints** use the *lifted* forest `143,176,137`, not the light
  `62,86,65` (which would barely register). `forestTint` `0.16`, `forestLine`
  `0.36`, `forestWash` / `addWash` `0.10`–`0.14`.
- **Heather/tan washes** likewise use the lifted hues (`185,166,198` /
  `201,165,126`) at `0.14`–`0.16`.
- **`scrim` is the one overlay that stays dark** (`rgba(8,7,6,0.60)`) — its job is
  to push the underlying view *down* a layer beneath a raised card, and on a dark
  base that still means darkening + the modal's own `bgRaised` lift carries the
  separation. Alpha is raised from light's `0.45` to `0.60` so the modal still reads
  as floating.

The recessive notice block (hard-coded `rgba(155,123,90,0.08)` in `DiffView.tsx`,
`WorkspacePanel.tsx`, etc.) should become a token-or-theme value; in dark use
`rgba(201,165,126,0.12)` (lifted tan, slightly higher alpha) under `--notice` text.

### Cross-surface domain hues still resolve

The §Wiki-linking rule "a domain has one hue, everywhere" must survive the dark
re-tune — the five graph/Links domains key off existing tokens, so they move with
them and stay mutually distinguishable on `bgApp`: `studio` (forestTint/forest),
`shared` (tanTint/tan), `attic` (neutralTint/inkSoft), `understory`
(forestWash/forest — still a lighter forest than studio), `website`
(removeWash/remove — heather as identity, still calm, still no red). Verified the
five fills read as distinct washes against `#1A1815`.

### Implementation: theme selector strategy

**Recommendation: keep `:root` as the light theme (the default), add
`:root[data-theme="dark"]` as the override.** Reasons:

1. The app ships light today; an unset/legacy state must stay light, so light is the
   natural base. A bare `:root` = light keeps that true with zero migration.
2. Builders override only what changes inside one `[data-theme="dark"]` block — the
   non-color tokens (space, radii, type, fonts) never fork.
3. Add an explicit `:root[data-theme="light"]` block too, but only as an *alias of
   the base values*, so "System → light" and "System → dark" are both addressable
   and a future third theme has a clean slot. The base `:root` and
   `[data-theme="light"]` hold identical color values (light); `[data-theme="dark"]`
   holds the table above. `lib/tokens.ts` gains a parallel `darkColor` export (or a
   `colorFor(theme)` helper) so inline-styled React — which reads JS tokens, not CSS
   vars — can switch too; the components consume it via a `useTheme()` hook rather
   than importing `color` directly. (This JS side is the real work; the CSS side is a
   paste.)

For **System**, resolve `prefers-color-scheme` to set `data-theme` on the root at
load and on change; never leave it unset when System is chosen, so the JS token
object and the CSS vars always agree.

### Toggle UI

**In Settings: a Light / Dark / System segmented control.** A new first row in a
small **Appearance** section (above Roots), three segments reusing the `TypeChip`
active/resting treatment (active = forest fill / ink-on-forest, resting =
transparent / `inkSoft` with `line` border) so it introduces no new primitive.
Default **System**. Label `Theme` (`--t-label`), the segment under it. This is the
canonical, discoverable home for the choice — calm, explained once, set and
forgotten.

**Top-bar sun/moon: no.** It fails house rule 5 (a top-bar control that does one tiny
job, permanently spending the calmest real estate in the app on a setting most users
flip once). Theme is not a per-session act like search or run; it does not earn a
persistent chrome affordance.

**A command-palette action: yes, quietly.** Add a single `⌘K` entry —
`Switch theme` (cycles Light → Dark → System, or opens the Settings row) — so power
users who live in the palette can reach it without a mouse, and it stays an
accelerator with a visible door (the Settings control), exactly per house rule 7. No
new global chord: a dedicated theme keybinding would clutter the §B map for a
once-a-month act. So: **segmented control in Settings (the door) + one command-
palette entry (the accelerator), no top-bar glyph, no global shortcut.**

---

SELF-REPORT: confidence: high; model-fit: right (palette design with measured WCAG verification, token-name fidelity for a paste-in builder, and the load-bearing nuances — warm-not-cold near-black, light-on-dark overlay inversion, scrim staying dark, terminal nudged below bgApp, and the five cross-surface domain hues surviving the re-tune; a cheaper model would likely have produced a cold slate palette, inverted overlays as dark-on-dark smudges, or broken the no-red / domain-hue constraints).

## Consistency Audit (TIN-1695)

An on-demand scan that reads the whole memory base looking for places where two
notes quietly disagree, then tells you about them in plain language: "`pricing.md`
says $9/mo; `pricing-decision.md` says $12/mo." Embeddings cluster related notes, a
local reasoning model judges each related pair, and the matches come back as
`Finding[]` (`{ files, names, summary }`) from `consistencyAudit()`, with live
progress from `onAuditProgress(({ done, total }) => …)`.

The whole design problem is one sentence: **surface contradictions without ever
sounding the alarm.** A finding is an invitation to look, never an accusation that
something is broken. We borrow the inverted-alarm grammar the frontmatter audit
proved (`§ Frontmatter manager audit view`): the thing other tools would paint red,
we paint calm. Here there is no severity ladder at all, because a contradiction is
not a defect with a fix; it is two true-sounding notes that deserve a human glance.
So findings are uniform, quiet, and equal. The reward state is the loud one, the way
"Every note is described." is the reward in the frontmatter audit.

This surface is a **full view**, same family as the Graph (`§ Graph view`) and
Frontmatter audit: it replaces the main content column, the top bar persists with
`← Agent Studio`, and the centre reads **Consistency**. It reuses the shared `Shell`
+ top-bar chrome verbatim (44px bar, `--hair` bottom border, `--bg-app`).

### Entry point

| Shortcut | Surface | Kind |
| --- | --- | --- |
| `⌘⇧C` | **Consistency audit** | Full view |

`⌘⇧C` for **C**onsistency. It is free (verified against the live map: `⌘K` `⌘R`
`⌘T` `⌘G` `⌘D` `⌘,` `⌘\` `⌘F` `⌘W` `⌘N`/`⌘⇧N` `⌘O` `⌘⇧A` `⌃Tab` are all taken),
and it deliberately rhymes with `⌘⇧A`, the frontmatter audit: both are `⌘⇧`
deliberate, run-when-you-mean-it library inspections, not constant reaches, so the
shift-modifier "this is a considered act" reading is correct. Command-palette entry
label: **`Run consistency audit`**. Both are doors to the same view; the shortcut is
an accelerator, never the only way in (house rule 7).

### Layout

One centered reading column, matching the search/editor/links geometry so it reads
as the same app turned to look at itself: `maxWidth: 680`, `width: 100%`,
`margin: 0 auto`, `padding: ${space[8]}px ${space[7]}px 80px` (the trailing `80px`
is the established bottom gutter). Inside that column the view is vertical and quiet:
a short header block (one line of orientation), then the state-dependent body. No
left rail, no filter chips, no sidebars. A consistency report is a thing you read
top to bottom once, not a workspace you dwell in.

The top-bar right slot (the 240px region the Frontmatter audit uses for its tally)
carries a single calm count only in the findings state: `3 worth a look.` in
`--t-meta` `--ink-soft`. Idle, running, all-clear, and the notice states leave it
empty, the bar stays calm.

### State 1 — Intro / idle

The resting state when you arrive and have not run a scan yet. Centered in the column,
generous vertical air:

- A serif orientation line, `--t-display` `--ink`:
  **`Look for notes that disagree.`**
- One `--t-body` `--ink-soft` line beneath, `maxWidth: 440`, `lineHeight: 1.5`,
  setting expectations honestly (it is local, it takes a moment):
  **`This reads your whole library with the local model and points out places where two notes seem to say different things. It can take a minute.`**
- The single primary action, the house primary button (`--forest` fill, `--on-accent`
  text, `radius.md`, `7px ${space[5]}px`, weight 600): **`Run audit`**.

That is the entire idle surface. One sentence of what, one sentence of how long, one
button. Nothing to configure, because there is nothing to configure.

### State 2 — Running

Triggered by `Run audit`. The button is replaced in place by a calm progress line,
driven by `onAuditProgress`:

- Before the first progress event arrives (clustering, model warm-up), a single
  `--ink-soft` `--t-body` line: **`Reading your library…`** (the shared loading voice).
- Once `{ done, total }` ticks, the line becomes, `--ink-soft` `--t-body`:
  **`Checking 12 of 40 related notes…`** (`Checking ${done} of ${total} related
  notes…`). When `total` is 0, fall back to the warm-up line rather than show
  `0 of 0`.
- No spinner, no bar graph, no percentage. The moving numerals are motion enough,
  consistent with house rule 5 and the "no spinners larger than `…`" rule.

**Re-run is disabled while running.** A second concurrent scan would be wasteful
(local model, many pairs) and would muddle one progress line into two. The button is
simply absent during the run, replaced by the progress line, so there is nothing to
double-press. `← Agent Studio` and `Esc` still leave at any time; leaving abandons
the in-flight scan quietly (no "are you sure", per house rule 1).

### State 3 — Findings

The scan returned one or more `Finding`s. The column shows a quiet header then the
list:

- **Header**, `--t-display` `--ink`: **`A few notes to look at.`** with a `--t-meta`
  `--ink-soft` second line: **`Each pair below seems to say different things. Open
  them side by side and decide.`** This framing is load-bearing: "to look at," "seems
  to," "you decide." We never say "conflict," "error," "problem," "wrong," or
  "mismatch." The model found a resemblance worth a human eye, nothing more.
- A trailing `Run again` text button at the header's right (`--ink-soft`, ghost,
  hover `--ink`), so a fresh scan after edits is one click. Re-enabled here (we are
  no longer running).

**The finding row.** A purpose-built calm row rather than a `ResultCard`, because a
finding is a *pair plus a sentence*, not a single document — but it borrows the
`ResultCard` rhythm exactly so it reads as kin: `padding: '12px 16px'`,
`background: color.bgCard` resting / `color.bgFieldStrong` hover,
`border: 1px solid ${color.hairSoft}` resting / `color.line` hover,
`borderRadius: radius.card`, `marginBottom: space[2]`, `transition: 'all 0.1s ease'`.

Anatomy, top to bottom inside the row:

1. **The summary**, the hero, in serif `--t-body`-weight reading voice: the
   `Finding.summary` sentence at `fontSize: 13`, `color: color.ink`, `lineHeight:
   1.5`. This is the one line the user actually reads: "`pricing.md` says $9/mo;
   `pricing-decision.md` says $12/mo." It is a statement of fact, not a verdict.
2. **The two notes**, beneath the summary, `marginTop: space[3]`: a row of exactly
   two **note pills**, `gap: space[2]`, wrapping. Each pill is a button that opens
   that file:
   - Layout: `padding: '3px 10px'`, `borderRadius: radius.chip`, `border: 1px solid
     ${color.line}`, `background: 'transparent'`, `color: color.inkSoft`,
     `fontFamily: font.sans`, `fontSize: 11`, `fontWeight: 500`. (Sans, not mono:
     these are notes you read, identified by `names[i]`, not paths you operate on.
     This is what separates a note pill from a `TicketChip`.)
   - Content: the display `names[i]`. The `files[i]` path is the open target and the
     `title` hint, never shown inline (it is machinery).
   - Hover (matches `TicketChip`): `background: color.forestWash`, `borderColor:
     color.forestLine`, `color: color.ink`, `transition: 'all 0.12s ease'`.
   - Click: opens that file as a tab in the focused panel; `⌘`-click opens it in the
     other panel, reusing the exact `onOpenResult`/`onOpenFile` routing the search
     and link cards already use. Title hint: `Open here · ⌘-click to open in the
     other panel`. Opening the two pills into the two panels is the natural gesture:
     `pricing.md` left, `pricing-decision.md` right, read them together, decide.

There is **no accept / dismiss / resolve / ignore action on a row.** Deliberately. A
finding is not a task with a done-state the app can own; resolving it means editing a
note, which happens in the editor, after which `Run again` re-checks. Adding "Dismiss"
would imply the app is accusing the note of an error the user must clear, which is
exactly the accusatory grammar this surface refuses. The row's only verbs are "open
this note" and "open that note." (Revisit only if real use shows people want to mute a
known-fine pair; even then it would be a quiet `--ink-faint` `Not a conflict` text
button, never a red `✗`.)

No severity, no sort by confidence, no count badges per row, no `⚠`. Findings render
in the order the client returns them. Every finding looks identical, because to the
app they are equal: all "worth a look."

### State 4 — All clear (the reward)

The scan ran and found nothing contradictory. This is the state we make feel good,
the way "Every note is described." rewards the frontmatter audit. Centered in the
column, the same two-line treatment as that view:

- `--t-display` `--ink`: **`Your notes agree.`**
- `--t-meta` `--ink-faint`: **`Nothing in your library contradicts itself. Run this
  again whenever you have written a lot.`**
- A trailing `Run again` text button (`--ink-soft`, ghost), low and quiet, so the
  reward reads first and the re-run is available without competing with it.

`Your notes agree.` is the inverse of an alarm: the absence of a finding is stated as
a small, earned calm, not a bland "0 results."

### State 5 — No reasoning model

`consistencyAudit()` rejects because Ollama is not running or no model is pulled. We
treat this as a setup fact with a named fix, not a failure. The recessive notice block
(`§C`): `--notice` text on `tanTint`, `radius.md`, no icon, inside the reading column,
with the fix on its own line in mono so it is copy-pasteable:

> The audit needs a local reasoning model.
> Start Ollama, or pull one with `ollama pull llama3.1:8b`, then run the audit again.

The model name (`ollama pull llama3.1:8b`) renders in `--t-mono` `--ink-soft` so it
reads as a command you can copy. A `Run audit` primary button sits beneath the notice
(not a bare retry link) so the path forward after starting Ollama is the same affordance
as the idle state. Distinguishing this from a generic error matters: this one has a
specific, nameable fix, so we name it. (The client should reject with a recognizable
reason for "no model reachable" vs. a generic failure so the view can pick this state
over State 6; if it cannot yet, State 6's copy is the safe superset.)

### State 6 — Error

The scan failed for any other reason (the model choked, an IO error mid-scan). The same
recessive notice block, calm and forward-looking, with a retry:

> The audit could not finish just now.

A `Run audit` primary button beneath it (same affordance as idle), and any findings
already on screen from a previous successful run are **kept** beneath the notice rather
than wiped, so a failed re-run never costs you the report you already had. No stack
trace, no "Oops," no red. A fact and a way forward (house rule 6).

### Named tokens used

| Element | Tokens |
| --- | --- |
| Shell / top bar | `--bg-app`, `--hair`, `--t-title` (centre `Consistency`), `--t-body` (`← Agent Studio`), reused `Shell` |
| Reading column | `maxWidth: 680`, `space[8]`/`space[7]` padding, `80px` bottom gutter |
| Idle headline | `--t-display` `--ink` |
| Idle / state body copy | `--t-body` `--ink-soft`, `--t-meta` `--ink-faint` |
| Primary action (`Run audit`) | `--forest` fill, `--on-accent` text, `radius.md`, weight 600 |
| `Run again` ghost button | `--t-body` `--ink-soft`, hover `--ink` |
| Progress line | `--t-body` `--ink-soft` |
| Finding row | `--bg-card`/`--bg-field-strong`, `--hair-soft`/`--line`, `radius.card`, `space[2]` gap |
| Finding summary | serif `--t-body` size, `--ink`, `lineHeight: 1.5` |
| Note pill | `--line` border, `--ink-soft` text, `radius.chip`, hover `--forest-wash`/`--forest-line`/`--ink` |
| Top-bar count | `--t-meta` `--ink-soft` |
| All-clear | `--t-display` `--ink`, `--t-meta` `--ink-faint` |
| Notice (no-model / error) | `--notice` on `--tan-tint`, `radius.md`, mono fix in `--t-mono` `--ink-soft` |

No raw hex, no magic numbers; the two literals (`680`, `80px`) are the established
reading-column constants already used by search, the editor, and the Links tab.

### Verbatim copy (curly apostrophes, no em-dashes)

- Top-bar title: `Consistency`
- Command-palette entry: `Run consistency audit`
- Top-bar count (findings only): `3 worth a look.`
- Idle headline: `Look for notes that disagree.`
- Idle body: `This reads your whole library with the local model and points out places where two notes seem to say different things. It can take a minute.`
- Idle / notice button: `Run audit`
- Running, warming up: `Reading your library…`
- Running, with progress: `Checking 12 of 40 related notes…`
- Findings headline: `A few notes to look at.`
- Findings subhead: `Each pair below seems to say different things. Open them side by side and decide.`
- Re-run button: `Run again`
- Note pill hint: `Open here · ⌘-click to open in the other panel`
- All-clear headline: `Your notes agree.`
- All-clear body: `Nothing in your library contradicts itself. Run this again whenever you have written a lot.`
- No-model notice line 1: `The audit needs a local reasoning model.`
- No-model notice line 2: `Start Ollama, or pull one with ollama pull llama3.1:8b, then run the audit again.`
- Error notice: `The audit could not finish just now.`

How this stays calm and non-accusatory, in one line: the surface has **no severity,
no defect language, and no resolve/dismiss action** — a finding only ever says "these
two seem to say different things, open them and decide," the reward state ("Your notes
agree.") is the loud one, and the worst case (a setup gap) is the one with a named,
copy-pasteable fix. No red, no `⚠`, no `✗`, anywhere.

SELF-REPORT: confidence: high; model-fit: right.
