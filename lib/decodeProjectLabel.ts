/**
 * decodeProjectLabel.ts
 *
 * Turn a transcript project key into a human label for the Sessions view
 * (TIN-1751). Claude Code stores transcripts under a dash-encoded project dir
 * (e.g. `-Users-rob-Dev-agent-studio`); each session also carries a real `cwd`
 * from its first line. We prefer the real cwd basename and fall back to decoding
 * the slug only when no cwd is available.
 *
 * Both helpers are pure so they can be unit-tested without the Tauri shell.
 */

/**
 * Decode a single project into a display label.
 *
 *  1. Prefer the real cwd: if non-empty, the label is the basename of the path
 *     (`/Users/rob/Dev/agent-studio` → `agent-studio`).
 *  2. Else decode the slug: strip a single leading `-`, split the remainder on
 *     `-`, take the last segment. If that is empty, fall back to the raw
 *     project string.
 */
export function decodeProjectLabel(project: string, cwd: string): string {
  const realCwd = (cwd ?? '').trim()
  if (realCwd) {
    return basename(realCwd)
  }

  const raw = project ?? ''
  // Strip exactly one leading dash, then split on dashes.
  const body = raw.startsWith('-') ? raw.slice(1) : raw
  const segments = body.split('-')
  const last = segments[segments.length - 1]
  return last && last.length > 0 ? last : raw
}

/** Basename of a slash-separated path (no trailing-slash surprises). */
function basename(path: string): string {
  const parts = path.split('/').filter(seg => seg.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/**
 * The parent segment for a project, used to disambiguate colliding labels.
 * Prefers the cwd's parent dir; falls back to the slug's second-to-last
 * segment. Returns '' when there is no usable parent.
 */
function parentSegment(project: string, cwd: string): string {
  const realCwd = (cwd ?? '').trim()
  if (realCwd) {
    const parts = realCwd.split('/').filter(seg => seg.length > 0)
    return parts.length >= 2 ? parts[parts.length - 2] : ''
  }
  const raw = project ?? ''
  const body = raw.startsWith('-') ? raw.slice(1) : raw
  const segments = body.split('-')
  return segments.length >= 2 ? segments[segments.length - 2] : ''
}

/** A project's key plus the two source fields the decode rule reads. */
export interface ProjectSource {
  project: string
  cwd: string
}

/**
 * Decode a set of projects into labels, disambiguating collisions. When two
 * DISTINCT projects decode to the same base label, BOTH get their parent
 * segment prepended as `parent / base` (plain slash with spaces). Projects
 * whose labels are unique keep their plain base label.
 *
 * Returns a map keyed by the project string → final display label.
 */
export function disambiguate(sources: ProjectSource[]): Map<string, string> {
  // First pass: base label per project.
  const base = new Map<string, string>()
  for (const s of sources) {
    base.set(s.project, decodeProjectLabel(s.project, s.cwd))
  }

  // Count how many DISTINCT projects share each base label.
  const labelOwners = new Map<string, Set<string>>()
  for (const s of sources) {
    const label = base.get(s.project) as string
    if (!labelOwners.has(label)) labelOwners.set(label, new Set())
    labelOwners.get(label)!.add(s.project)
  }

  // Second pass: collide → "parent / base"; unique → base.
  const result = new Map<string, string>()
  for (const s of sources) {
    const label = base.get(s.project) as string
    const owners = labelOwners.get(label) as Set<string>
    if (owners.size > 1) {
      const parent = parentSegment(s.project, s.cwd)
      result.set(s.project, parent ? `${parent} / ${label}` : label)
    } else {
      result.set(s.project, label)
    }
  }
  return result
}
