/**
 * launcher.ts
 *
 * Frontend client + composition logic for the Prompt launcher (TIN-1633).
 *
 * The launcher's job, end to end:
 *   1. Browse prompts (`listPrompts`) and skills (`listSkills`) from the roots.
 *   2. Read prompt/skill/memory/file bodies (`readPrompt` and the fs plugin).
 *   3. Compose those into a single briefing bundle (`composeBundle`).
 *   4. Write the bundle to a temp file (`writeBundle`) and hand the path to the
 *      agent so it launches fully briefed (see TerminalPanel's run path).
 *
 * Injection method: the composed bundle is written to a temp markdown file and
 * its path is substituted into the agent's args wherever the `{bundle}` token
 * appears (falling back to appending the path as a trailing arg). A `claude`-style
 * CLI then reads it via a flag like `--file {bundle}`; the bundle is also piped to
 * the process stdin so prompt-only agents still receive it. One place owns this:
 * `composeAgentArgs` + the stdin write in TerminalPanel.
 */

import { invoke } from '@tauri-apps/api/core'
import type { Agent } from './settings'

// ── Backend-facing types ──────────────────────────────────────────────────────

/** A prompt file from the prompts root. */
export interface PromptEntry {
  path: string
  name: string
  description: string
}

/** A skill file from the skills root. */
export interface SkillEntry {
  path: string
  name: string
  description: string
}

/** The three kinds of context an item can be. Drives chip tint + bundle header. */
export type ContextKind = 'skill' | 'memory' | 'file'

/** A single piece of selected context, before its body is read. */
export interface ContextItem {
  kind: ContextKind
  /** Absolute path on disk. Also the dedupe key. */
  path: string
  /** Display label (skill name, memory name, or filename). */
  label: string
  /** When true, this item rides in the SYSTEM context tier, not the user prompt. */
  system?: boolean
}

// ── System auto-facts (TIN-1764) ───────────────────────────────────────────────

/**
 * The four ambient facts the agent can be told about a launch. Each is opt-in
 * per prompt; `time` defaults on. Persisted alongside the per-prompt setup and,
 * on "Save current setup", into the prompt's `system_facts:` frontmatter.
 */
export interface SystemFacts {
  /** Time of input — stamped at the moment Run fires. Default ON. */
  time: boolean
  /** Date — the calendar date at launch. */
  date: boolean
  /** Working directory — the launch cwd. */
  cwd: boolean
  /** Agent name — the chosen agent. */
  agent: boolean
}

export function defaultSystemFacts(): SystemFacts {
  return { time: true, date: false, cwd: false, agent: false }
}

/** The auto-facts, in display + bundle order, with their human labels. */
export const SYSTEM_FACT_ORDER: { id: keyof SystemFacts; label: string }[] = [
  { id: 'time', label: 'Time of input' },
  { id: 'date', label: 'Date' },
  { id: 'cwd', label: 'Working directory' },
  { id: 'agent', label: 'Agent name' },
]

/** Serialize on-facts to the `system_facts:` frontmatter list (e.g. `['time']`). */
export function systemFactsToList(facts: SystemFacts): string[] {
  return SYSTEM_FACT_ORDER.filter((f) => facts[f.id]).map((f) => f.id)
}

/** Parse a `system_facts:` list back into a SystemFacts (missing keys → off). */
export function systemFactsFromList(list: string[]): SystemFacts {
  const set = new Set(list)
  return {
    time: set.has('time'),
    date: set.has('date'),
    cwd: set.has('cwd'),
    agent: set.has('agent'),
  }
}

// ── Backend commands ──────────────────────────────────────────────────────────

/** List prompt files (name + frontmatter description) under the prompts root. */
export async function listPrompts(dir: string): Promise<PromptEntry[]> {
  return invoke<PromptEntry[]>('list_prompts', { payload: { dir } })
}

/** List skill files (name + description) under the skills root. */
export async function listSkills(dir: string): Promise<SkillEntry[]> {
  return invoke<SkillEntry[]>('list_skills', { payload: { dir } })
}

/** Read the raw text of a prompt or skill file (frontmatter included). */
export async function readPrompt(path: string): Promise<string> {
  return invoke<string>('read_prompt', { payload: { path } })
}

// ── Prompt authoring (TIN-1764) ────────────────────────────────────────────────

/** A portable default-context reference, as carried in a prompt's frontmatter. */
export interface PromptContextRef {
  kind: ContextKind
  /** Root-relative (skill/memory) or absolute/relative (file) reference. */
  ref: string
}

/** Arguments for `write_prompt`. Mirrors the Rust `WritePromptInput`. */
export interface WritePromptArgs {
  dir: string
  slug: string
  name: string
  description?: string
  body: string
  /** false = new file (refuses to clobber); true = rewrite in place. */
  overwrite: boolean
  context?: PromptContextRef[]
  systemFacts?: string[]
}

/**
 * Write or rewrite a prompt `.md` in the prompts root. Returns the absolute path.
 * NEW writes refuse to clobber (caller suffixes the slug and retries); EDIT
 * rewrites in place, preserving other frontmatter keys. See `launcher.rs`.
 */
export async function writePrompt(args: WritePromptArgs): Promise<string> {
  const res = await invoke<{ path: string }>('write_prompt', { payload: args })
  return res.path
}

// ── Frontmatter stripping (for the serif preview + clean bundle bodies) ────────

/**
 * Strip a leading YAML frontmatter block. Mirrors what gray-matter does, but
 * without pulling the dependency into a hot path: the preview only needs the body.
 */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  const after = raw.indexOf('\n', end + 1)
  return after === -1 ? '' : raw.slice(after + 1).replace(/^\s*\n/, '')
}

/** The inner YAML text of a leading `---`-fenced frontmatter block, or ''. */
function frontmatterBlock(raw: string): string {
  if (!raw.startsWith('---')) return ''
  const firstNl = raw.indexOf('\n')
  if (firstNl === -1) return ''
  const end = raw.indexOf('\n---', firstNl)
  if (end === -1) return ''
  return raw.slice(firstNl + 1, end)
}

/**
 * Parse a prompt's `context:` frontmatter block into `PromptContextRef[]`.
 * Tolerant of the small subset of YAML we emit: a `context:` key followed by
 * `- kind: <k>` / `ref: <r>` pairs. Unparseable / unknown-kind items are dropped.
 * No YAML dependency — this is a hot path and the shape is fixed.
 */
export function parseFrontmatterContext(raw: string): PromptContextRef[] {
  const block = frontmatterBlock(raw)
  if (!block) return []
  const lines = block.split('\n')
  const out: PromptContextRef[] = []
  let inContext = false
  let cur: Partial<PromptContextRef> | null = null
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim()

  const flush = () => {
    if (cur && cur.kind && cur.ref && (cur.kind === 'skill' || cur.kind === 'memory' || cur.kind === 'file')) {
      out.push({ kind: cur.kind, ref: cur.ref })
    }
    cur = null
  }

  for (const line of lines) {
    const indented = /^\s/.test(line)
    if (!indented) {
      // A new top-level key ends the context block.
      flush()
      inContext = line.replace(/\s+$/, '') === 'context:'
      continue
    }
    if (!inContext) continue
    const trimmed = line.trim()
    const itemMatch = trimmed.match(/^-\s*kind:\s*(.+)$/)
    if (itemMatch) {
      flush()
      cur = { kind: unquote(itemMatch[1]) as ContextKind }
      continue
    }
    const refMatch = trimmed.match(/^ref:\s*(.+)$/)
    if (refMatch && cur) {
      cur.ref = unquote(refMatch[1])
      continue
    }
    const kindMatch = trimmed.match(/^kind:\s*(.+)$/)
    if (kindMatch) {
      flush()
      cur = { kind: unquote(kindMatch[1]) as ContextKind }
    }
  }
  flush()
  return out
}

/** Parse a `system_facts: [a, b]` (or block-list) frontmatter value. */
export function parseFrontmatterSystemFacts(raw: string): string[] {
  const block = frontmatterBlock(raw)
  if (!block) return []
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^system_facts:\s*(.*)$/)
    if (!m) continue
    const inline = m[1].trim()
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
        .filter(Boolean)
    }
    // Block list form: subsequent `  - item` lines.
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const im = lines[j].match(/^\s+-\s*(.+)$/)
      if (!im) break
      out.push(im[1].trim().replace(/^['"]|['"]$/g, '').trim())
    }
    return out
  }
  return []
}

/**
 * Resolve a default-context `ref` (from frontmatter) to a `ContextItem` by
 * locating it under the right root. skill→skillsRoot, memory→memoryRoot,
 * file→absolute as-is. Returns null when the target does not exist (the caller
 * silently drops unresolvable refs — no alarm).
 */
export async function resolveContextRef(
  ref: PromptContextRef,
  roots: { skillsRoot: string; memoryRoot: string },
): Promise<ContextItem | null> {
  const join = (root: string, rel: string) => {
    const r = root.replace(/\/+$/, '')
    return rel.startsWith('/') ? rel : `${r}/${rel}`
  }
  let path: string
  if (ref.kind === 'skill') path = join(roots.skillsRoot, ref.ref)
  else if (ref.kind === 'memory') path = join(roots.memoryRoot, ref.ref)
  else path = ref.ref
  try {
    const { exists } = await import('@tauri-apps/plugin-fs')
    if (!(await exists(path))) return null
  } catch {
    return null
  }
  return { kind: ref.kind, path, label: filename(path) }
}

/** The root-relative ref for a context item, given the roots (for frontmatter). */
export function contextItemToRef(
  item: ContextItem,
  roots: { skillsRoot: string; memoryRoot: string },
): PromptContextRef {
  const rel = (root: string) => {
    const r = root.replace(/\/+$/, '')
    return item.path.startsWith(r + '/') ? item.path.slice(r.length + 1) : item.path
  }
  if (item.kind === 'skill') return { kind: 'skill', ref: rel(roots.skillsRoot) }
  if (item.kind === 'memory') return { kind: 'memory', ref: rel(roots.memoryRoot) }
  return { kind: 'file', ref: item.path }
}

// ── Bundle composition ─────────────────────────────────────────────────────────

const filename = (p: string) => p.split('/').pop() ?? p

/** A read context item: its metadata plus the file body. */
interface LoadedContext extends ContextItem {
  body: string
}

const KIND_HEADING: Record<ContextKind, string> = {
  skill: 'Persona / skill',
  memory: 'Memory',
  file: 'Project file',
}

/** Capitalized kind label for the SYSTEM tier (`## SYSTEM — <Kind>: <label>`). */
const KIND_CAP: Record<ContextKind, string> = {
  skill: 'Skill',
  memory: 'Memory',
  file: 'File',
}

/** A resolved auto-fact: its label and the literal value to emit. */
export interface ResolvedFact {
  label: string
  value: string
}

/**
 * The framing sentence atop the SYSTEM CONTEXT block. Kept as one source of truth
 * so the bundle and the human-facing preview agree.
 */
export const SYSTEM_FRAMING =
  'The following is ambient context for you, the agent, not part of the user’s request.'

/**
 * Compose the launch bundle. The prompt body first, then the USER-tier context
 * grouped by kind (skills, memory, files). If there is any system-tier context or
 * any auto-fact, a single clearly-delimited `# SYSTEM CONTEXT` block is appended
 * AFTER all user content — never interleaved with the user's request.
 *
 * This is the single source of truth for what the agent receives.
 */
export function composeBundle(
  promptName: string,
  promptBody: string,
  context: LoadedContext[],
  facts: ResolvedFact[] = [],
): string {
  const order: ContextKind[] = ['skill', 'memory', 'file']
  const userItems = context.filter((c) => !c.system)
  const systemItems = context.filter((c) => c.system)

  const parts: string[] = []
  parts.push(`# ${promptName}`)
  parts.push('')
  parts.push(stripFrontmatter(promptBody).trim())

  for (const kind of order) {
    for (const item of userItems.filter((c) => c.kind === kind)) {
      parts.push('')
      parts.push('---')
      parts.push('')
      parts.push(`## ${KIND_HEADING[kind]}: ${item.label}`)
      parts.push('')
      parts.push(stripFrontmatter(item.body).trim())
    }
  }

  // ── System tier — one fenced block, after all user content. ──
  if (systemItems.length > 0 || facts.length > 0) {
    parts.push('')
    parts.push('---')
    parts.push('')
    parts.push('# SYSTEM CONTEXT')
    parts.push('')
    parts.push(SYSTEM_FRAMING)
    for (const f of facts) {
      parts.push('')
      parts.push(`${f.label}: ${f.value}`)
    }
    for (const kind of order) {
      for (const item of systemItems.filter((c) => c.kind === kind)) {
        parts.push('')
        parts.push(`## SYSTEM — ${KIND_CAP[kind]}: ${item.label}`)
        parts.push('')
        parts.push(stripFrontmatter(item.body).trim())
      }
    }
  }

  parts.push('')
  return parts.join('\n')
}

/**
 * Read the bodies of every selected context item, then compose the bundle.
 * Memory and file items are read through the fs plugin; skills through the
 * backend (same as the preview) — all by absolute path, so one read fn suffices.
 *
 * `facts` carries the resolved auto-facts (time-of-input stamped at Run); they
 * land in the SYSTEM CONTEXT block.
 */
export async function buildBundle(
  promptName: string,
  promptBody: string,
  context: ContextItem[],
  facts: ResolvedFact[] = [],
): Promise<string> {
  const loaded: LoadedContext[] = await Promise.all(
    context.map(async (item) => {
      let body = ''
      try {
        body = await readPrompt(item.path)
      } catch {
        body = ''
      }
      return { ...item, body }
    }),
  )
  return composeBundle(promptName, promptBody, loaded, facts)
}

/**
 * Stamp the on auto-facts into resolved label/value lines, at the moment Run
 * fires. Time-of-input format: `YYYY-MM-DD HH:MM TZ` (e.g. `2026-06-25 09:14 PST`).
 */
export function resolveFacts(
  facts: SystemFacts,
  ctx: { cwd: string; agentName: string },
  now: Date = new Date(),
): ResolvedFact[] {
  const out: ResolvedFact[] = []
  if (facts.time) out.push({ label: 'time of input', value: formatStamp(now) })
  if (facts.date) out.push({ label: 'date', value: formatDate(now) })
  if (facts.cwd) out.push({ label: 'working directory', value: ctx.cwd })
  if (facts.agent) out.push({ label: 'agent name', value: ctx.agentName })
  return out
}

/** `YYYY-MM-DD` from a Date (local). */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `YYYY-MM-DD HH:MM TZ` from a Date (local), e.g. `2026-06-25 09:14 PST`. */
export function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = formatDate(d)
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  let tz = ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d)
    tz = parts.find((x) => x.type === 'timeZoneName')?.value ?? ''
  } catch {
    tz = ''
  }
  return tz ? `${date} ${time} ${tz}` : `${date} ${time}`
}

/**
 * Write the composed bundle to a markdown file and return its absolute path.
 * Lives under ~/.agent-studio/launches so it stays inside the app's filesystem
 * scope (the OS temp dir is outside $HOME and is denied by the fs capability).
 */
export async function writeBundle(bundle: string): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path')
  const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs')
  const dir = await homeDir()
  const sep = dir.endsWith('/') ? '' : '/'
  const folder = `${dir}${sep}.agent-studio/launches`
  try {
    await mkdir(folder, { recursive: true })
  } catch {
    /* already exists */
  }
  const path = `${folder}/launch-${Date.now()}.md`
  await writeTextFile(path, bundle)
  return path
}

/**
 * Substitute the bundle path into an agent's args. If any arg contains the
 * `{bundle}` token it is replaced; otherwise the path is appended as a trailing
 * arg. This is the one place that owns argument-level injection.
 */
export function composeAgentArgs(agent: Agent, bundlePath: string): string[] {
  const args = agent.args ?? []
  const hasToken = args.some((a) => a.includes('{bundle}'))
  if (hasToken) {
    return args.map((a) => a.replaceAll('{bundle}', bundlePath))
  }
  return [...args, bundlePath]
}

// ── Per-prompt memory of intent (localStorage) ─────────────────────────────────

/** A remembered setup for one prompt: its context bundle, agent, and dir. */
export interface RememberedSetup {
  context: ContextItem[]
  agentName: string
  cwd: string
  /** The per-prompt auto-fact toggles (TIN-1764). Absent on legacy entries. */
  systemFacts?: SystemFacts
}

const SETUP_KEY = 'agent-studio-launcher-setups'

type SetupMap = Record<string, RememberedSetup>

function loadSetupMap(): SetupMap {
  try {
    const raw = localStorage.getItem(SETUP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as SetupMap) : {}
  } catch {
    return {}
  }
}

/** The remembered setup for a prompt path, or null if none. */
export function getSetup(promptPath: string): RememberedSetup | null {
  return loadSetupMap()[promptPath] ?? null
}

/** Remember the last-used setup for a prompt path. */
export function saveSetup(promptPath: string, setup: RememberedSetup): void {
  try {
    const map = loadSetupMap()
    map[promptPath] = setup
    localStorage.setItem(SETUP_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota / serialization errors */
  }
}

/** Forget a prompt's remembered setup ("Start fresh"). */
export function clearSetup(promptPath: string): void {
  try {
    const map = loadSetupMap()
    delete map[promptPath]
    localStorage.setItem(SETUP_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

// ── Recent working directories ─────────────────────────────────────────────────

const RECENT_DIRS_KEY = 'agent-studio-launcher-dirs'
const RECENT_DIRS_MAX = 6

/** Recent working dirs, most-recent first. */
export function getRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_DIRS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Record a working dir as recently used. */
export function pushRecentDir(dir: string): void {
  if (!dir) return
  try {
    const next = [dir, ...getRecentDirs().filter((d) => d !== dir)].slice(0, RECENT_DIRS_MAX)
    localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export { filename }
