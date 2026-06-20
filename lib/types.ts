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
