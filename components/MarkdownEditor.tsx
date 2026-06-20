'use client'

import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

interface MarkdownEditorProps {
  initialContent: string
  onChange: (markdown: string) => void
  onSave: () => void
}

export default function MarkdownEditor({ initialContent, onChange, onSave }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  // Keep a stable ref to onSave so the keydown handler doesn't go stale
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  // Mount the editor once on load; initialContent is the mount-time value only.
  // The parent remounts this component (via key={activePath}) when a new file loads.
  useEffect(() => {
    if (!containerRef.current) return

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: initialContent,
    })

    // Listen for markdown changes
    crepe.on((api) => {
      api.markdownUpdated((_, markdown) => {
        onChange(markdown)
      })
    })

    crepe.create().then(() => {
      crepeRef.current = crepe
    })

    return () => {
      crepe.destroy()
      crepeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty — initialContent is mount value only

  // Cmd+S / Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSaveRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      ref={containerRef}
      className="milkdown-editor-host"
    />
  )
}
