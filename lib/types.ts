export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

export interface SearchResult {
  path: string
  filename: string
  excerpt: string
  root: string
}

// Frontmatter fields from the memory file schema
export interface MemoryFileMeta {
  name: string
  type: 'feedback' | 'project' | 'user' | 'reference' | string
  projects: string | string[]
  created: string
  updated: string
  tags?: string[]
  status?: 'active' | 'archived' | 'superseded' | string
  supersedes?: string
}

// ── Two-panel workspace (TIN-1640) ──────────────────────────────────────────

/** Which side of the split a panel is. */
export type PanelSide = 'left' | 'right'

/** The per-panel tabs. Content is always available; Links/Diff are stubs that
 *  TIN-1639 (backlinks) and TIN-1635 (git diff) will fill in later. */
export type PanelTab = 'content' | 'links' | 'diff'

/** Independent state for a single panel: what file it's showing and which tab
 *  is active. Persisted per side in localStorage. */
export interface PanelState {
  activePath: string | null
  activeTab: PanelTab
}

/** Cached, parsed contents of a loaded file, shared across both panels so a
 *  file open in both stays in sync and edits route by path. */
export interface LoadedFile {
  content: string
  raw: string
  meta: MemorySearchResult | null
  loading: boolean
}

// A single search result from the FTS5 API
export interface MemorySearchResult {
  path: string
  name: string
  type: string
  projects: string[]
  created: string
  updated: string
  tags: string[]
  status: string
  excerpt: string
}
