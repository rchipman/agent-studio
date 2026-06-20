/**
 * POST /api/files
 *
 * Creates a new memory file with frontmatter pre-filled.
 * Lives in pages/api/ so it is excluded from output: 'export' static builds.
 *
 * Body (JSON):
 *   name     - human name / title (required)
 *   slug     - file slug (required, becomes filename)
 *   type     - memory type (required)
 *   projects - string or string[] (required)
 *   tags     - string[] (optional)
 *
 * Returns: { path: string } on success
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import os from 'os'
import { buildIndex } from '@/lib/memoryIndex'

const MEMORY_ROOT = path.join(os.homedir(), 'Projects/tfl/memory')

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

interface CreateFileBody {
  name: string
  slug: string
  type: string
  projects: string | string[]
  tags?: string[]
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ path: string } | { error: string }>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = req.body as CreateFileBody

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' })
      return
    }

    const { name, slug, type, projects, tags = [] } = body

    if (!name || !slug || !type || !projects) {
      res.status(400).json({ error: 'name, slug, type, and projects are required' })
      return
    }

    const projectList = Array.isArray(projects) ? projects : [projects]
    const firstProject = projectList[0]

    const dirPath = path.join(MEMORY_ROOT, firstProject)
    fs.mkdirSync(dirPath, { recursive: true })

    const filePath = path.join(dirPath, `${slug}.md`)

    if (fs.existsSync(filePath)) {
      res.status(409).json({ error: 'File already exists' })
      return
    }

    const frontmatter = {
      name: slug,
      type,
      projects: projectList.length === 1 ? firstProject : projectList,
      created: todayISO(),
      updated: todayISO(),
      tags,
      status: 'active',
    }

    const fileContent = matter.stringify(`\n${name}\n`, frontmatter)
    fs.writeFileSync(filePath, fileContent, 'utf-8')

    // Rebuild index to include the new file
    buildIndex()

    res.status(200).json({ path: filePath })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[files api]', message)
    res.status(500).json({ error: message })
  }
}
