/**
 * wikiLinkPlugin.ts
 *
 * ProseMirror plugins that add `[[wiki-link]]` support to the Milkdown (Crepe)
 * editor (TIN-1639, surface 2). Three behaviours, each a plain ProseMirror
 * plugin so they inject cleanly into Crepe via `editor.use($prose(...))`:
 *
 *   1. `wikiAutocompletePlugin` — the `[[` autocomplete dropdown. Key handling
 *      lives in the plugin; the menu is a DOM node positioned at the caret.
 *   2. `wikiDecorationPlugin` — inline decorations that STYLE `[[slug]]` and
 *      `TIN-XXXX` ranges without mutating the document. Resolved vs unresolved
 *      `[[ ]]` and forest+mono `TIN-XXXX` per the blessed spec.
 *
 * Click-to-open is handled by both plugins' `handleClickOn` props.
 *
 * All colours/sizes come from `lib/tokens.ts` (the typed mirror of the CSS
 * custom properties); there are no raw hex values or magic numbers here. No red.
 * User-facing copy uses curly apostrophes and the exact spec strings.
 */

import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { color, font, radius, space, shadow, type as typeRamp } from '@/lib/tokens'
import { linkSuggest, type LinkSuggestion } from '@/lib/links'

// ── Shared matching ───────────────────────────────────────────────────────────

/** `[[slug]]` — slug is anything that is not `]`. */
const WIKI_RE = /\[\[([^\]]+)\]\]/g
/** `TIN-1234` ticket ids (mirrors lib/links TICKET_RE / the Rust scanner). */
const TICKET_RE = /\bTIN-\d+\b/g
/** `[[` immediately before the caret, capturing the fragment typed so far. */
const TRIGGER_RE = /\[\[([^\]\n]*)$/

/** A slug → display-name resolver. Returns undefined while unknown/unresolved. */
export type LinkResolver = (slug: string) => string | undefined

export interface WikiCallbacks {
  onOpenWikiLink?: (slug: string) => void
  onOpenTicket?: (id: string) => void
  /** Resolve a slug to a note name, or undefined if no such note. */
  resolve: LinkResolver
  /** Called when a `[[slug]]` is seen so the host can warm its resolver cache. */
  onSeenSlug?: (slug: string) => void
}

// ── Decoration plugin (behaviour 2 + 3: styling + click) ───────────────────────

export const wikiDecorationKey = new PluginKey('wiki-decoration')

const resolvedLinkStyle = [
  `color: ${color.forest}`,
  'text-decoration: none',
  `border-bottom: 1px solid ${color.forestLine}`,
  'cursor: pointer',
  'transition: background 0.12s ease, border-color 0.12s ease',
].join(';')

const unresolvedLinkStyle = [
  `color: ${color.inkFaint}`,
  'text-decoration: none',
  `border-bottom: 1px solid ${color.hair}`,
  'cursor: default',
].join(';')

const ticketLinkStyle = [
  `color: ${color.forest}`,
  `font-family: ${font.mono}`,
  'text-decoration: none',
  `border-bottom: 1px solid ${color.forestLine}`,
  'cursor: pointer',
  'transition: background 0.12s ease, border-color 0.12s ease',
].join(';')

/** True if any mark on this text node is a code mark (skip auto-linking there). */
function isCodeText(node: ProseNode): boolean {
  return node.marks.some((m) => m.type.name === 'inlineCode' || m.type.name === 'code')
}

function buildDecorations(doc: ProseNode, resolve: LinkResolver, onSeenSlug?: (s: string) => void): DecorationSet {
  const decos: Decoration[] = []

  doc.descendants((node, pos) => {
    // Only style inside non-code text; code blocks have node.type.spec.code.
    if (node.type.spec.code) return false
    if (!node.isText || !node.text) return
    if (isCodeText(node)) return

    const text = node.text

    WIKI_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKI_RE.exec(text)) !== null) {
      const slug = m[1].trim()
      const from = pos + m.index
      const to = from + m[0].length
      onSeenSlug?.(slug)
      const name = resolve(slug)
      const resolved = name !== undefined
      decos.push(
        Decoration.inline(from, to, {
          class: resolved ? 'wiki-link wiki-link-resolved' : 'wiki-link wiki-link-unresolved',
          style: resolved ? resolvedLinkStyle : unresolvedLinkStyle,
          'data-wiki-slug': slug,
          ...(resolved
            ? {}
            : { title: `No note named “${slug}” yet.` }),
        })
      )
    }

    TICKET_RE.lastIndex = 0
    while ((m = TICKET_RE.exec(text)) !== null) {
      const id = m[0]
      const from = pos + m.index
      const to = from + id.length
      decos.push(
        Decoration.inline(from, to, {
          class: 'ticket-link',
          style: ticketLinkStyle,
          'data-ticket-id': id,
        })
      )
    }
  })

  return DecorationSet.create(doc, decos)
}

export function wikiDecorationPlugin(cb: WikiCallbacks): Plugin {
  return new Plugin({
    key: wikiDecorationKey,
    state: {
      init: (_, state) => buildDecorations(state.doc, cb.resolve, cb.onSeenSlug),
      apply(tr, old, _oldState, newState) {
        // Rebuild on doc change OR when the host signals resolutions updated.
        if (tr.docChanged || tr.getMeta(wikiDecorationKey)) {
          return buildDecorations(newState.doc, cb.resolve, cb.onSeenSlug)
        }
        return old.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const target = (event.target as HTMLElement)?.closest?.(
          '[data-wiki-slug],[data-ticket-id]'
        ) as HTMLElement | null
        if (!target) return false
        const slug = target.getAttribute('data-wiki-slug')
        if (slug !== null) {
          // Only navigate for resolved links.
          if (cb.resolve(slug) !== undefined) {
            cb.onOpenWikiLink?.(slug)
            return true
          }
          return false
        }
        const ticket = target.getAttribute('data-ticket-id')
        if (ticket) {
          cb.onOpenTicket?.(ticket)
          return true
        }
        return false
      },
    },
  })
}

// ── Autocomplete plugin (behaviour 1) ──────────────────────────────────────────

export const wikiAutocompleteKey = new PluginKey('wiki-autocomplete')

const MAX_VISIBLE_ROWS = 7
const ROW_HEIGHT = 32
const MENU_WIDTH = 320
const DEBOUNCE_MS = 120

interface MenuState {
  /** Doc position of the `[` of `[[` (left edge anchor). */
  triggerFrom: number
  fragment: string
}

type Suggestions =
  | { kind: 'loading' }
  | { kind: 'ready'; items: LinkSuggestion[] }

/**
 * The dropdown is a single DOM element managed imperatively (the standard
 * ProseMirror autocomplete pattern). It is styled inline from tokens.
 */
class WikiMenu {
  dom: HTMLDivElement
  private rows: HTMLDivElement[] = []
  selected = 0
  private items: LinkSuggestion[] = []
  visible = false

  constructor(private onPick: (s: LinkSuggestion) => void) {
    this.dom = document.createElement('div')
    Object.assign(this.dom.style, {
      position: 'absolute',
      zIndex: '50',
      background: color.bgRaised,
      border: `1px solid ${color.hair}`,
      borderRadius: `${radius.lg}px`,
      boxShadow: shadow.toast,
      padding: `${space[1]}px`,
      overflowX: 'hidden',
      overflowY: 'auto',
      width: `min(${MENU_WIDTH}px, 90vw)`,
      maxHeight: `${MAX_VISIBLE_ROWS * ROW_HEIGHT + space[1] * 2}px`,
      display: 'none',
      boxSizing: 'border-box',
    } as Partial<CSSStyleDeclaration>)
  }

  private renderInfoRow(text: string) {
    this.dom.replaceChildren()
    this.rows = []
    const row = document.createElement('div')
    Object.assign(row.style, {
      height: `${ROW_HEIGHT}px`,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${space[3]}px`,
      color: color.inkFaint,
      fontFamily: typeRamp.meta.fontFamily,
      fontSize: `${typeRamp.meta.fontSize}px`,
    } as Partial<CSSStyleDeclaration>)
    row.textContent = text
    this.dom.appendChild(row)
  }

  setSuggestions(s: Suggestions) {
    if (s.kind === 'loading') {
      this.items = []
      this.renderInfoRow('Searching…')
      return
    }
    this.items = s.items
    if (s.items.length === 0) {
      this.renderInfoRow('No matches. Keep typing to name a new note.')
      return
    }
    this.dom.replaceChildren()
    this.rows = []
    this.selected = 0
    s.items.forEach((item, i) => {
      const row = document.createElement('div')
      Object.assign(row.style, {
        height: `${ROW_HEIGHT}px`,
        display: 'flex',
        alignItems: 'center',
        gap: `${space[3]}px`,
        padding: `0 ${space[3]}px`,
        borderRadius: `${radius.md}px`,
        cursor: 'pointer',
      } as Partial<CSSStyleDeclaration>)

      const name = document.createElement('span')
      Object.assign(name.style, {
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: color.ink,
        fontFamily: typeRamp.body.fontFamily,
        fontSize: `${typeRamp.body.fontSize}px`,
      } as Partial<CSSStyleDeclaration>)
      name.textContent = item.name
      row.appendChild(name)

      const tag = document.createElement('span')
      Object.assign(tag.style, {
        marginLeft: 'auto',
        flex: '0 0 auto',
        background: color.forestTint,
        color: color.forest,
        padding: '1px 7px',
        borderRadius: `${radius.chip}px`,
        fontFamily: typeRamp.body.fontFamily,
        fontSize: '10px',
      } as Partial<CSSStyleDeclaration>)
      tag.textContent = noteType(item)
      row.appendChild(tag)

      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.onPick(item)
      })
      row.addEventListener('mouseenter', () => {
        this.selected = i
        this.paint()
      })

      this.rows.push(row)
      this.dom.appendChild(row)
    })
    this.paint()
  }

  private paint() {
    this.rows.forEach((row, i) => {
      row.style.background = i === this.selected ? color.forestWash : 'transparent'
    })
    const active = this.rows[this.selected]
    active?.scrollIntoView({ block: 'nearest' })
  }

  move(delta: number) {
    if (this.rows.length === 0) return
    this.selected = (this.selected + delta + this.rows.length) % this.rows.length
    this.paint()
  }

  current(): LinkSuggestion | undefined {
    return this.items[this.selected]
  }

  hasItems() {
    return this.items.length > 0
  }

  show(left: number, top: number, flipAbove: boolean, anchorTop: number) {
    this.dom.style.display = 'block'
    this.dom.style.left = `${left}px`
    if (flipAbove) {
      // Position the menu's bottom just above the line.
      const h = this.dom.offsetHeight
      this.dom.style.top = `${anchorTop - h - space[2]}px`
    } else {
      this.dom.style.top = `${top + space[2]}px`
    }
    this.visible = true
  }

  hide() {
    this.dom.style.display = 'none'
    this.visible = false
  }
}

/**
 * Hover styling for resolved links / tickets. Decorations set the rest state
 * inline; `:hover` can only come from a stylesheet, so the host injects this
 * once. All values are tokens. The hover lifts to a full-strength forest border
 * and a soft `--forest-wash` chip (2px horizontal padding, `--r-sm`).
 */
export const WIKI_HOVER_CSS = `
.milkdown-editor-host .ProseMirror .wiki-link-resolved:hover,
.milkdown-editor-host .ProseMirror .ticket-link:hover {
  border-bottom-color: ${color.forest};
  background: ${color.forestWash};
  padding: 0 2px;
  border-radius: ${radius.sm}px;
}
`.trim()

/** Derive a short type tag from a suggestion path (folder under memory root). */
function noteType(s: LinkSuggestion): string {
  const parts = s.path.split('/').filter(Boolean)
  // Use the parent folder name when present; else fall back to "note".
  if (parts.length >= 2) return parts[parts.length - 2]
  return 'note'
}

export function wikiAutocompletePlugin(): Plugin {
  let menu: WikiMenu | null = null
  let menuState: MenuState | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let reqId = 0

  function close() {
    menuState = null
    menu?.hide()
    if (debounce) clearTimeout(debounce)
  }

  function insert(view: EditorView, s: LinkSuggestion) {
    if (!menuState) return
    const { triggerFrom } = menuState
    const to = view.state.selection.from
    const text = `[[${s.slug}]]`
    const tr = view.state.tr.insertText(text, triggerFrom, to)
    const caret = triggerFrom + text.length
    tr.setSelection(TextSelection.create(tr.doc, caret))
    view.dispatch(tr)
    close()
    view.focus()
  }

  function reposition(view: EditorView) {
    if (!menu || !menuState) return
    const coords = view.coordsAtPos(menuState.triggerFrom)
    const parent = menu.dom.offsetParent as HTMLElement | null
    const base = parent?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const left = coords.left - base.left
    const top = coords.bottom - base.top
    const anchorTop = coords.top - base.top
    // Flip up if the menu would clip the viewport bottom.
    const wouldClip =
      coords.bottom + MAX_VISIBLE_ROWS * ROW_HEIGHT + space[2] > window.innerHeight
    menu.show(left, top, wouldClip, anchorTop)
  }

  function query(view: EditorView, fragment: string) {
    if (!menu) return
    menu.setSuggestions({ kind: 'loading' })
    reposition(view)
    if (debounce) clearTimeout(debounce)
    const id = ++reqId
    debounce = setTimeout(() => {
      linkSuggest(fragment, MAX_VISIBLE_ROWS)
        .then((items) => {
          if (id !== reqId || !menu || !menuState) return
          menu.setSuggestions({ kind: 'ready', items })
          reposition(view)
        })
        .catch(() => {
          if (id !== reqId || !menu || !menuState) return
          menu.setSuggestions({ kind: 'ready', items: [] })
          reposition(view)
        })
    }, DEBOUNCE_MS)
  }

  /** Recompute whether the caret currently sits in a `[[fragment` trigger. */
  function detect(view: EditorView): MenuState | null {
    const { selection } = view.state
    if (!selection.empty) return null
    const $from = selection.$from
    // Text before the caret within the current text block.
    const textBefore = $from.parent.textBetween(
      0,
      $from.parentOffset,
      undefined,
      '￼'
    )
    const match = TRIGGER_RE.exec(textBefore)
    if (!match) return null
    const fragment = match[1]
    // No `]` allowed inside the fragment (regex guarantees), and bail on newlines.
    const triggerFrom = selection.from - fragment.length - 2 // back over `[[`
    return { triggerFrom, fragment }
  }

  return new Plugin({
    key: wikiAutocompleteKey,
    view(editorView) {
      menu = new WikiMenu((s) => insert(editorView, s))
      // Mount inside the editor host so absolute positioning is relative to it.
      const host = editorView.dom.parentElement ?? document.body
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative'
      }
      host.appendChild(menu.dom)
      return {
        update(v) {
          if (!menu) return
          const next = detect(v)
          if (!next) {
            if (menuState) close()
            return
          }
          const changed =
            !menuState ||
            menuState.fragment !== next.fragment ||
            menuState.triggerFrom !== next.triggerFrom
          menuState = next
          if (changed) query(v, next.fragment)
          else reposition(v)
        },
        destroy() {
          close()
          menu?.dom.remove()
          menu = null
        },
      }
    },
    props: {
      handleKeyDown(view, event) {
        if (!menu || !menuState || !menu.visible) return false
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault()
            menu.move(1)
            return true
          case 'ArrowUp':
            event.preventDefault()
            menu.move(-1)
            return true
          case 'Enter':
          case 'Tab': {
            const cur = menu.current()
            if (cur && menu.hasItems()) {
              event.preventDefault()
              insert(view, cur)
              return true
            }
            return false
          }
          case 'Escape':
            event.preventDefault()
            close()
            return true
          default:
            return false
        }
      },
    },
  })
}
