/**
 * slug.ts
 *
 * Turn a human title into a filename slug. Shared by the new-file modal and
 * quick capture so the two stay in lockstep.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}
