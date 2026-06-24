'use client'

/**
 * ChangesView.tsx
 *
 * The "Changes" rail destination — review what agents changed in your working
 * directories. Decoupled from notes entirely (a diff is repo state, not a face
 * of a document). Because Studio is used across several projects at once, it
 * carries a tab per working directory, seeded from the configured agents and
 * your recent launch directories, with an affordance to add more. Each tab shows
 * that repo's git diff.
 */

import { useEffect, useState } from 'react'
import { color, space, radius, font, type as typeRamp } from '@/lib/tokens'
import { getSettings } from '@/lib/settings'
import { getRecentDirs } from '@/lib/launcher'
import ViewShell from '@/components/ViewShell'
import DiffView from '@/components/DiffView'
import Button from '@/components/Button'

const SAVED_KEY = 'agent-studio-changes-dirs'

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const dedupe = (xs: string[]) => Array.from(new Set(xs.filter((x) => x && x.trim())))

function loadSaved(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function saveSaved(dirs: string[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(dirs))
  } catch {
    /* ignore */
  }
}

interface ChangesViewProps {
  onClose: () => void
}

export default function ChangesView({ onClose }: ChangesViewProps) {
  const [dirs, setDirs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)

  // Seed once: a saved curated list if present, else the agents' working dirs +
  // recent launch dirs. After that the list is the user's to curate.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const saved = loadSaved()
      if (saved.length > 0) {
        if (!cancelled) {
          setDirs(saved)
          setActive(saved[0])
        }
        return
      }
      let agentDirs: string[] = []
      try {
        const s = await getSettings()
        agentDirs = (s.agents ?? []).map((a) => a.cwd).filter(Boolean)
      } catch {
        /* no settings */
      }
      const seed = dedupe([...agentDirs, ...getRecentDirs()])
      if (cancelled) return
      setDirs(seed)
      setActive(seed[0] ?? null)
      if (seed.length > 0) saveSaved(seed)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const addDir = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, multiple: false })
    if (typeof picked !== 'string') return
    setDirs((prev) => {
      const next = dedupe([...prev, picked])
      saveSaved(next)
      return next
    })
    setActive(picked)
  }

  const removeDir = (dir: string) => {
    setDirs((prev) => {
      const next = prev.filter((d) => d !== dir)
      saveSaved(next)
      setActive((cur) => (cur === dir ? next[0] ?? null : cur))
      return next
    })
  }

  return (
    <ViewShell
      title="Changes"
      onBack={onClose}
      right={
        <Button variant="secondary" size="sm" onClick={addDir} title="Add a working directory">
          + Directory
        </Button>
      }
    >
      {/* Working-directory tabs */}
      <div
        role="tablist"
        aria-label="Working directories"
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'stretch',
          gap: space[1],
          padding: `0 ${space[5]}px`,
          borderBottom: `1px solid ${color.hairSoft}`,
          background: color.bgApp,
          overflowX: 'auto',
        }}
      >
        {dirs.map((dir) => {
          const isActive = dir === active
          return (
            <button
              key={dir}
              role="tab"
              aria-selected={isActive}
              title={dir}
              onClick={() => setActive(dir)}
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: space[2],
                alignSelf: 'flex-end',
                height: 30,
                padding: `0 ${space[3]}px`,
                background: isActive ? color.bgRaised : 'transparent',
                border: isActive ? `1px solid ${color.hair}` : '1px solid transparent',
                borderBottom: 'none',
                borderTop: isActive ? `2px solid ${color.forest}` : '2px solid transparent',
                borderTopLeftRadius: radius.md,
                borderTopRightRadius: radius.md,
                marginBottom: -1,
                color: isActive ? color.ink : color.inkSoft,
                fontFamily: font.sans,
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {basename(dir)}
              <span
                role="button"
                aria-label="Remove directory"
                onClick={(e) => { e.stopPropagation(); removeDir(dir) }}
                style={{ color: color.inkFaint, fontSize: 13, lineHeight: 1, padding: '0 2px' }}
              >
                ×
              </span>
            </button>
          )
        })}
      </div>

      {/* Active directory's diff, or a calm empty state */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: color.bgRaised }}>
        {active ? (
          <DiffView workingDir={active} />
        ) : (
          <div style={{ ...typeRamp.body, textAlign: 'center', color: color.inkFaint, paddingTop: 80 }}>
            Add a working directory to see what changed there.
          </div>
        )}
      </div>
    </ViewShell>
  )
}
