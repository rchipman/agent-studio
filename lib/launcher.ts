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

/**
 * Compose the launch bundle: the prompt body first, then each context item under
 * a light, labeled header grouped by kind (skills, then memory, then files). This
 * is the single source of truth for what the agent receives.
 *
 * Bodies have their frontmatter stripped so the agent reads prose, not YAML.
 */
export function composeBundle(
  promptName: string,
  promptBody: string,
  context: LoadedContext[],
): string {
  const parts: string[] = []
  parts.push(`# ${promptName}`)
  parts.push('')
  parts.push(stripFrontmatter(promptBody).trim())

  const order: ContextKind[] = ['skill', 'memory', 'file']
  for (const kind of order) {
    const items = context.filter((c) => c.kind === kind)
    for (const item of items) {
      parts.push('')
      parts.push('---')
      parts.push('')
      parts.push(`## ${KIND_HEADING[kind]}: ${item.label}`)
      parts.push('')
      parts.push(stripFrontmatter(item.body).trim())
    }
  }
  parts.push('')
  return parts.join('\n')
}

/**
 * Read the bodies of every selected context item, then compose the bundle.
 * Memory and file items are read through the fs plugin; skills through the
 * backend (same as the preview) — all by absolute path, so one read fn suffices.
 */
export async function buildBundle(
  promptName: string,
  promptBody: string,
  context: ContextItem[],
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
  return composeBundle(promptName, promptBody, loaded)
}

/**
 * Write the composed bundle to a temp markdown file and return its absolute path.
 * Uses the OS temp dir so it survives the spawn but is not littered into the repo.
 */
export async function writeBundle(bundle: string): Promise<string> {
  const { tempDir } = await import('@tauri-apps/api/path')
  const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs')
  const dir = await tempDir()
  const sep = dir.endsWith('/') ? '' : '/'
  const folder = `${dir}${sep}agent-studio`
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
