/**
 * links.ts
 *
 * Frontend client for the wiki-linking layer (TIN-1639). Thin typed wrappers
 * over the Rust commands in `src-tauri/src/links.rs`:
 *   - `fileLinks`  — the Links tab for one open file (outbound, backlinks, tickets)
 *   - `linkSuggest` — `[[` autocomplete in the editor
 *   - `graphData`  — the full `⌘G` knowledge graph
 *   - `setTicketTitles` — cache resolved Linear ticket titles
 *
 * Types mirror the `Serialize` structs in links.rs exactly (note `type` is
 * serialised from Rust's `type_`).
 */

import { invoke } from '@tauri-apps/api/core'

// ── Types (mirror links.rs) ────────────────────────────────────────────────────

/** A memory file referenced by (or referencing) the open file — a link card. */
export interface LinkedFile {
  path: string
  name: string
  type: string
  projects: string[]
  excerpt: string
}

/** A Linear ticket mention: bare id plus a cached title (empty if unknown). */
export interface TicketRef {
  id: string
  title: string
}

/** The full link map for one file. */
export interface FileLinks {
  outbound: LinkedFile[]
  backlinks: LinkedFile[]
  tickets: TicketRef[]
}

/** One `[[` autocomplete suggestion. `slug` is what goes inside `[[ ]]`. */
export interface LinkSuggestion {
  name: string
  path: string
  slug: string
}

/** A node in the knowledge graph. `kind` is `'file'`, `'ticket'`, or `'epic'`. */
export interface GraphNode {
  id: string
  label: string
  kind: 'file' | 'ticket' | 'epic'
  /** First project, for domain colouring (empty for tickets/epics). */
  domain: string
  /** Edge count touching this node (drives node size). */
  degree: number
}

/** An edge between two graph nodes (by node id). */
export interface GraphEdge {
  from: string
  to: string
}

/** The whole graph. */
export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── Commands ────────────────────────────────────────────────────────────────

/** The full link map (outbound / backlinks / tickets) for one file. */
export async function fileLinks(path: string): Promise<FileLinks> {
  return invoke<FileLinks>('file_links', { payload: { path } })
}

/** Autocomplete suggestions for the `[[` editor picker. */
export async function linkSuggest(q: string, limit = 8): Promise<LinkSuggestion[]> {
  return invoke<LinkSuggestion[]>('link_suggest', { payload: { q, limit } })
}

/** The whole knowledge graph (files + tickets, with edges and degrees). */
export async function graphData(): Promise<GraphData> {
  return invoke<GraphData>('graph_data')
}

/** Cache resolved Linear ticket titles so the Links tab and graph can show them. */
export async function setTicketTitles(tickets: TicketRef[]): Promise<void> {
  return invoke('set_ticket_titles', { payload: { tickets } })
}

// ── Linear ticket helpers ─────────────────────────────────────────────────────

/** Match `TIN-1234` ticket ids in arbitrary text (mirrors the Rust scanner). */
export const TICKET_RE = /\bTIN-\d+\b/g

/** Build the Linear web URL for a ticket id (opened in the in-app browser). */
export function ticketUrl(id: string): string {
  return `https://linear.app/tiny-forest/issue/${id}`
}
