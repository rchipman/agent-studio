/**
 * GET /api/search
 *
 * Query params:
 *   q       - full-text search query (optional)
 *   type    - filter by memory type (optional)
 *   project - filter by project (optional)
 *   limit   - max results (optional, default 30)
 *   init    - if "true", rebuild the index before searching
 *
 * Lives in pages/api/ so it is excluded from output: 'export' static builds.
 * Runs via the Next.js dev server in tauri dev mode.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { buildIndex, searchIndex, getAllTypes, getAllProjects } from '@/lib/memoryIndex'
import { MemorySearchResult } from '@/lib/types'

// Build the index once on first request (module-level flag per process)
let indexBuilt = false

interface SearchResponse {
  results: MemorySearchResult[]
  types: string[]
  projects: string[]
  error?: string
}

export default function handler(req: NextApiRequest, res: NextApiResponse<SearchResponse | { error: string }>) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const type = typeof req.query.type === 'string' ? req.query.type : ''
    const project = typeof req.query.project === 'string' ? req.query.project : ''
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '30', 10)
    const init = req.query.init === 'true'

    if (!indexBuilt || init) {
      buildIndex()
      indexBuilt = true
    }

    const results = searchIndex({
      query: q,
      type: type || undefined,
      project: project || undefined,
      limit,
    })

    const types = getAllTypes()
    const projects = getAllProjects()

    res.status(200).json({ results, types, projects })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[search api]', message)
    res.status(500).json({ error: message } as { error: string })
  }
}
