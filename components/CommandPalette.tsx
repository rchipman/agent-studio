'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { MemorySearchResult } from '@/lib/types'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onSelect: (path: string) => void
  memoryRoot: string
}

async function searchViaApi(q: string): Promise<MemorySearchResult[]> {
  const url = new URL('/api/search', window.location.origin)
  if (q) url.searchParams.set('q', q)
  url.searchParams.set('limit', '30')
  try {
    const res = await fetch(url.toString())
    const data = await res.json() as { results?: MemorySearchResult[] }
    return data.results ?? []
  } catch {
    return []
  }
}

export default function CommandPalette({ open, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focus and reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      setResults([])
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
      // Load default results immediately
      searchViaApi('').then((r) => setResults(r))
    }
  }, [open])

  // Search on query change (debounced)
  useEffect(() => {
    if (!open) return
    setSelected(0)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setLoading(true)
    searchTimer.current = setTimeout(async () => {
      const r = await searchViaApi(query)
      setResults(r)
      setLoading(false)
    }, 200)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, open])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(s => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(s => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      const r = results[selected]
      if (r) { onSelect(r.path); onClose() }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }, [results, selected, onSelect, onClose])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(38,35,32,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 120,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to file"
        style={{
          width: 560, maxHeight: 420,
          background: '#FCFAF4',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(38,35,32,0.25)',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        {/* Search input */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(38,35,32,0.10)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="16" height="16" fill="none" stroke="#6B6760" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Jump to file…"
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              fontSize: 15, color: '#262320', fontFamily: 'inherit',
            }}
          />
          {loading ? (
            <span style={{ fontSize: 11, color: '#9B9890' }}>…</span>
          ) : (
            <span style={{ fontSize: 11, color: '#9B9890', fontFamily: 'monospace' }}>ESC</span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} style={{ overflowY: 'auto', maxHeight: 360 }}>
          {results.length === 0 && !loading ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#9B9890', fontSize: 13 }}>
              No files found
            </div>
          ) : results.map((r, i) => (
            <div
              key={r.path}
              onClick={() => { onSelect(r.path); onClose() }}
              style={{
                padding: '8px 16px',
                cursor: 'pointer',
                background: i === selected ? '#3E564115' : 'transparent',
                borderLeft: i === selected ? '2px solid #3E5641' : '2px solid transparent',
                display: 'flex', flexDirection: 'column', gap: 3,
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: '#262320', fontWeight: 500 }}>
                  {r.name}
                </span>
                {r.type && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 8,
                    background: 'rgba(62,86,65,0.10)',
                    color: '#3E5641',
                    fontWeight: 600,
                  }}>
                    {r.type}
                  </span>
                )}
                {r.projects.map((p) => (
                  <span key={p} style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 8,
                    background: 'rgba(155,123,90,0.10)',
                    color: '#9B7B5A',
                  }}>
                    {p}
                  </span>
                ))}
              </div>
              {r.excerpt && (
                <span style={{ fontSize: 11, color: '#9B9890', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.excerpt}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
