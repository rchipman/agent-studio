'use client'

import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { $prose } from '@milkdown/kit/utils'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { linkSuggest } from '@/lib/links'
import {
  wikiAutocompletePlugin,
  wikiDecorationPlugin,
  wikiDecorationKey,
  WIKI_HOVER_CSS,
} from './wikiLinkPlugin'

// Inject the resolved-link / ticket hover styles once (rest state is inline on
// the decorations; `:hover` must come from a stylesheet). Tokens only.
let hoverStyleInjected = false
function ensureHoverStyles() {
  if (hoverStyleInjected || typeof document === 'undefined') return
  hoverStyleInjected = true
  const el = document.createElement('style')
  el.dataset.wikiLinkHover = 'true'
  el.textContent = WIKI_HOVER_CSS
  document.head.appendChild(el)
}

interface MarkdownEditorProps {
  initialContent: string
  onChange: (markdown: string) => void
  onSave: () => void
  /** Click a `[[slug]]` → open that note. */
  onOpenWikiLink?: (slug: string) => void
  /** Click a `TIN-XXXX` → open the ticket in the Linear browser. */
  onOpenTicket?: (id: string) => void
}

export default function MarkdownEditor({
  initialContent,
  onChange,
  onSave,
  onOpenWikiLink,
  onOpenTicket,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  // Keep a stable ref to onSave so the keydown handler doesn't go stale
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])
  // Stable refs for the link callbacks so the (mount-once) plugins see fresh values.
  const onOpenWikiLinkRef = useRef(onOpenWikiLink)
  const onOpenTicketRef = useRef(onOpenTicket)
  useEffect(() => { onOpenWikiLinkRef.current = onOpenWikiLink }, [onOpenWikiLink])
  useEffect(() => { onOpenTicketRef.current = onOpenTicket }, [onOpenTicket])

  // Mount the editor once on load; initialContent is the mount-time value only.
  // The parent remounts this component (via key={activePath}) when a new file loads.
  useEffect(() => {
    if (!containerRef.current) return
    ensureHoverStyles()

    // ── Slug → name resolution cache for [[ ]] decorations ────────────────────
    // `resolve` is synchronous (decorations are built synchronously). On a cache
    // miss we kick off an async lookup and, when it lands, ask the editor to
    // rebuild decorations via a plugin meta transaction.
    const resolved = new Map<string, string | null>() // null = looked up, no match
    const inFlight = new Set<string>()

    const resolve = (slug: string): string | undefined => {
      const hit = resolved.get(slug)
      return hit == null ? undefined : hit
    }

    const refreshDecorations = () => {
      const crepe = crepeRef.current
      if (!crepe) return
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.setMeta(wikiDecorationKey, true))
      })
    }

    const onSeenSlug = (slug: string) => {
      if (resolved.has(slug) || inFlight.has(slug)) return
      inFlight.add(slug)
      linkSuggest(slug, 8)
        .then((items) => {
          const match = items.find((i) => i.slug === slug)
          resolved.set(slug, match ? match.name : null)
        })
        .catch(() => {
          resolved.set(slug, null)
        })
        .finally(() => {
          inFlight.delete(slug)
          refreshDecorations()
        })
    }

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: initialContent,
    })

    // Inject the wiki-link plugins before create() — Crepe exposes the underlying
    // Milkdown editor via `crepe.editor`, and ProseMirror plugins drop in cleanly
    // through `$prose`, so no custom nodes or Crepe forking is needed.
    crepe.editor
      .use(
        $prose(() =>
          wikiDecorationPlugin({
            resolve,
            onSeenSlug,
            onOpenWikiLink: (slug) => onOpenWikiLinkRef.current?.(slug),
            onOpenTicket: (id) => onOpenTicketRef.current?.(id),
          })
        )
      )
      .use($prose(() => wikiAutocompletePlugin()))

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
