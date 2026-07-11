'use client'

/**
 * ChangesView.tsx
 *
 * The "Changes" rail destination — review what agents changed in your working
 * directories. Decoupled from notes entirely (a diff is repo state, not a face
 * of a document). Because Studio is used across several projects at once, it
 * carries a tab per working directory, curated by the user via "Add" and
 * persisted locally. Each tab shows that repo's git diff.
 */

import { useEffect, useState } from 'react'
import { color, space, radius, font, type as typeRamp } from '@/lib/tokens'
import ViewBody from '@/components/ViewBody'
import DiffView from '@/components/DiffView'
import Button from '@/components/Button'
import { useTopBarSlot } from '@/components/TopBarSlot'

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

export default function ChangesView({}: ChangesViewProps) {
  const [dirs, setDirs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  // Bumping this remounts the active directory's DiffView, re-reading its git
  // status — the calm "Refresh" the top bar offers. (TIN-1708)
  const [refreshKey, setRefreshKey] = useState(0)

  // Load the user's curated, locally-persisted list. Empty on first run — the
  // user adds working directories with "Add". (Before TIN-1793 this also seeded
  // from the registered agents / recent launch dirs; that surface is gone.)
  useEffect(() => {
    const saved = loadSaved()
    if (saved.length > 0) {
      setDirs(saved)
      setActive(saved[0])
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

  // Top-bar right slot: a calm Refresh that re-reads the active diff. (TIN-1708)
  const { setRight } = useTopBarSlot()
  useEffect(() => {
    setRight(
      <Button
        variant="tertiary"
        size="sm"
        onClick={() => setRefreshKey((k) => k + 1)}
        title="Refresh"
        disabled={!active}
      >
        Refresh
      </Button>,
    )
    return () => setRight(null)
  }, [setRight, active])

  return (
    <ViewBody>
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
                // All-longhand borders (no `border` shorthand to reconcile on rerender).
                borderLeft: isActive ? `1px solid ${color.hair}` : '1px solid transparent',
                borderRight: isActive ? `1px solid ${color.hair}` : '1px solid transparent',
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

        {/* Add a working directory (moved off the top bar, which now holds Refresh). */}
        <button
          onClick={addDir}
          title="Add a working directory"
          aria-label="Add a working directory"
          style={{
            flexShrink: 0,
            alignSelf: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            marginLeft: space[1],
            background: 'transparent',
            border: 'none',
            borderRadius: radius.md,
            color: color.inkSoft,
            fontFamily: font.sans,
            fontSize: 16,
            lineHeight: 1,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = color.bgFieldStrong; e.currentTarget.style.color = color.ink }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = color.inkSoft }}
        >
          +
        </button>
      </div>

      {/* Active directory's diff, or a calm empty state */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: color.bgRaised }}>
        {active ? (
          <DiffView key={`${active}:${refreshKey}`} workingDir={active} />
        ) : (
          <div style={{ ...typeRamp.body, textAlign: 'center', color: color.inkFaint, paddingTop: 80 }}>
            Add a working directory to see what changed there.
          </div>
        )}
      </div>
    </ViewBody>
  )
}
