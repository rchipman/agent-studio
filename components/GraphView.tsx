'use client'

/**
 * GraphView.tsx
 *
 * Full-canvas knowledge graph for the wiki-linking feature (TIN-1639, surface 3).
 * A full view in the transcript-browser family: top bar with `← Agent Studio` and
 * a centred `Graph` title, the canvas fills the content column on the app cream.
 *
 * Every memory file is a node, every `[[ ]]` or `TIN-` mention an edge. d3-force
 * computes positions only; we settle the simulation, PIN the nodes (no perpetual
 * jitter), then render nodes/edges ourselves as SVG with design tokens. Orphans
 * (degree 0) are excluded from the sim and laid out deterministically on a bottom
 * shelf under a `NOT YET LINKED` divider.
 *
 * Pan + zoom is a hand-rolled SVG `viewBox` transform (wheel = zoom, drag on empty
 * canvas = pan); no external zoom lib. Filter chips DIM non-matching nodes/edges to
 * ~18% (they never remove). The `Tickets` toggle hides/shows ticket nodes.
 *
 * Self-contained: the orchestrator wires ⌘G and view routing; this component does
 * not touch app/page.tsx.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from 'd3-force'
import { color, space, radius, type as typeToken, font } from '@/lib/tokens'
import { graphData, type GraphNode, type GraphEdge } from '@/lib/links'
import TypeChip from '@/components/TypeChip'
import Button from '@/components/Button'
import ViewBody from '@/components/ViewBody'
import { useTopBarSlot } from '@/components/TopBarSlot'

// ── Layout constants (not design tokens — graph geometry per the spec) ─────────

/** Node radius scales with degree: r = NODE_R_BASE + NODE_R_K * sqrt(degree). */
const NODE_R_BASE = 6
const NODE_R_K = 3
const NODE_R_MIN = 6
const NODE_R_MAX = 22
/** Ticket nodes are a fixed small hollow ring. */
const TICKET_R = 5

/** Force-sim canvas the layout is computed in (world units, before fit-all). */
const SIM_W = 1200
const SIM_H = 800
/** Orphan shelf geometry. */
const SHELF_GAP = 40 // horizontal step between orphan nodes
const SHELF_PAD = 40 // left/right inset of the shelf band
const SHELF_ROW_H = 44 // vertical step between wrapped shelf rows
/** Dim level for filtered-out nodes/edges (~18% per spec). */
const DIM = 0.18
/** Zoom below which file labels are hidden to avoid clutter. */
const LABEL_ZOOM_THRESHOLD = 1.1

const ZOOM_MIN = 0.3
const ZOOM_MAX = 4

// ── Domain hue table (cross-surface; mirrors the spec table) ───────────────────

interface Hue {
  fill: string
  stroke: string
}

function domainHue(domain: string): Hue {
  switch (domain) {
    case 'studio':
      return { fill: color.forestTint, stroke: color.forest }
    case 'shared':
      return { fill: color.tanTint, stroke: color.tan }
    case 'attic':
      return { fill: color.neutralTint, stroke: color.inkSoft }
    case 'understory':
      return { fill: color.forestWash, stroke: color.forest }
    case 'website':
      return { fill: color.removeWash, stroke: color.remove }
    default:
      // Unknown / empty domain reads as the warm neutral.
      return { fill: color.neutralTint, stroke: color.inkSoft }
  }
}

const KNOWN_TYPES = ['feedback', 'project', 'user', 'reference']
const KNOWN_PROJECTS = ['attic', 'understory', 'website', 'studio', 'shared']

function fileRadius(degree: number): number {
  const r = NODE_R_BASE + NODE_R_K * Math.sqrt(degree)
  return Math.max(NODE_R_MIN, Math.min(NODE_R_MAX, r))
}

// ── Positioned node (force output, pinned) ─────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string
  node: GraphNode
  x: number
  y: number
}

interface Positioned {
  node: GraphNode
  x: number
  y: number
}

// ── Component ──────────────────────────────────────────────────────────────────

interface GraphViewProps {
  /** node.id for kind 'file' is the file path. */
  onOpenFile: (path: string) => void
  /** node.id for kind 'ticket' is the TIN-XXXX id. */
  onOpenTicket: (id: string) => void
  onClose: () => void
}

export default function GraphView({ onOpenFile, onOpenTicket, onClose }: GraphViewProps) {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // Settled, pinned positions for connected nodes (degree > 0).
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map())

  // Filters. Empty set = all shown (matches the search view's chip behaviour).
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set())
  const [activeProjects, setActiveProjects] = useState<Set<string>>(new Set())
  const [showTickets, setShowTickets] = useState(true)

  // Hover.
  const [hoverId, setHoverId] = useState<string | null>(null)

  // Pan + zoom (a viewBox transform: world point worldCenter maps to canvas centre).
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 }) // world translation
  const svgRef = useRef<SVGSVGElement>(null)
  // Canvas size in state so render-time geometry (toCanvas) reads from state, not a
  // ref (refs must not be read during render). A mirror ref lets event handlers read
  // the latest size synchronously without re-binding.
  const [size, setSize] = useState({ w: 0, h: 0 })
  const sizeRef = useRef({ w: 0, h: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)

  // ── Load ─────────────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    graphData()
      .then(d => {
        if (!alive) return
        setNodes(d.nodes)
        setEdges(d.edges)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError(true)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // ── Force layout (positions only; settle then pin) ─────────────────────────────

  const connected = useMemo(() => nodes.filter(n => n.degree > 0), [nodes])
  const orphans = useMemo(() => nodes.filter(n => n.degree === 0), [nodes])

  useEffect(() => {
    if (connected.length === 0) {
      setPositions(new Map())
      return
    }

    // Seed from any previous settled layout so the map feels stable run to run.
    const prev = positions
    const simNodes: SimNode[] = connected.map((n, i) => {
      const seed = prev.get(n.id)
      return {
        id: n.id,
        node: n,
        x: seed?.x ?? SIM_W / 2 + Math.cos(i) * 120,
        y: seed?.y ?? SIM_H / 2 + Math.sin(i) * 120,
      }
    })
    const byId = new Map(simNodes.map(s => [s.id, s]))
    // Only edges between connected nodes participate in the link force.
    const simLinks = edges
      .filter(e => byId.has(e.from) && byId.has(e.to))
      .map(e => ({ source: e.from, target: e.to }))

    const sim = forceSimulation(simNodes)
      .force('charge', forceManyBody().strength(-220))
      .force(
        'link',
        forceLink(simLinks)
          .id((d: SimulationNodeDatum & { id?: string }) => d.id as string)
          .distance(70)
          .strength(0.6),
      )
      .force('center', forceCenter(SIM_W / 2, SIM_H / 2))
      .force('collide', forceCollide().radius((d: SimulationNodeDatum) => fileRadius((d as SimNode).node.degree) + 6))
      .stop()

    // Settle synchronously, then PIN — no perpetual ticking, the graph reads calm.
    const ticks = Math.ceil(Math.log(0.001) / Math.log(1 - 0.0228)) // alpha decay to alphaMin
    for (let i = 0; i < ticks; i++) sim.tick()
    sim.stop()

    const next = new Map<string, Positioned>()
    for (const s of simNodes) {
      next.set(s.id, { node: s.node, x: s.x, y: s.y })
    }
    setPositions(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, edges])

  // ── Orphan shelf layout (deterministic, bottom band) ───────────────────────────

  // Compute the world bounds of the connected layout so the shelf sits below it.
  const layoutBounds = useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of positions.values()) {
      const r = fileRadius(p.node.degree)
      minX = Math.min(minX, p.x - r)
      minY = Math.min(minY, p.y - r)
      maxX = Math.max(maxX, p.x + r)
      maxY = Math.max(maxY, p.y + r)
    }
    if (!isFinite(minX)) {
      // No connected nodes: shelf is the whole canvas.
      return { minX: 0, minY: 0, maxX: SIM_W, maxY: 0 }
    }
    return { minX, minY, maxX, maxY }
  }, [positions])

  const shelf = useMemo(() => {
    if (orphans.length === 0) return null
    const left = layoutBounds.minX + SHELF_PAD
    const right = layoutBounds.maxX - SHELF_PAD
    const width = Math.max(right - left, SHELF_GAP * 4)
    const perRow = Math.max(1, Math.floor(width / SHELF_GAP))
    const dividerY = layoutBounds.maxY + SHELF_ROW_H
    const items = orphans.map((n, i) => {
      const col = i % perRow
      const row = Math.floor(i / perRow)
      return {
        node: n,
        x: left + col * SHELF_GAP,
        y: dividerY + SHELF_ROW_H * 0.7 + row * SHELF_ROW_H,
      }
    })
    return { left, right: left + width, dividerY, items }
  }, [orphans, layoutBounds])

  // ── Fit-all (reset view) ───────────────────────────────────────────────────────

  const fitAll = useCallback(() => {
    const { w, h } = size
    if (!w || !h) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const consider = (x: number, y: number, r: number) => {
      minX = Math.min(minX, x - r)
      minY = Math.min(minY, y - r)
      maxX = Math.max(maxX, x + r)
      maxY = Math.max(maxY, y + r)
    }
    for (const p of positions.values()) consider(p.x, p.y, fileRadius(p.node.degree))
    if (shelf) {
      for (const it of shelf.items) consider(it.x, it.y, TICKET_R)
      consider(shelf.left, shelf.dividerY, 0)
      consider(shelf.right, shelf.dividerY, 0)
    }
    if (!isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = SIM_W
      maxY = SIM_H
    }

    const pad = 60
    const contentW = maxX - minX + pad * 2
    const contentH = maxY - minY + pad * 2
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(w / contentW, h / contentH)))
    setZoom(z)
    // Pan so the content centre maps to the canvas centre.
    setPan({ x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 })
  }, [positions, shelf, size])

  // Fit once positions and canvas size are known.
  const fitKey = `${positions.size}:${shelf?.items.length ?? 0}:${size.w > 0}`
  useEffect(() => {
    fitAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey])

  // ── Escape closes ──────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── Canvas size tracking ───────────────────────────────────────────────────────

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const apply = (w: number, h: number) => {
      sizeRef.current = { w, h }
      setSize({ w, h })
    }
    const ro = new ResizeObserver(entries => {
      for (const e of entries) apply(e.contentRect.width, e.contentRect.height)
    })
    ro.observe(el)
    apply(el.clientWidth, el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // ── World ↔ canvas transform ────────────────────────────────────────────────────
  // canvasPoint = (worldPoint + pan) * zoom + canvasCenter

  const toCanvas = useCallback(
    (x: number, y: number) => {
      const { w, h } = size
      return { x: (x + pan.x) * zoom + w / 2, y: (y + pan.y) * zoom + h / 2 }
    },
    [pan, zoom, size],
  )

  // ── Wheel zoom (about the cursor) ───────────────────────────────────────────────

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const el = svgRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const { w, h } = sizeRef.current
    // World point under the cursor before zoom.
    const wx = (cx - w / 2) / zoom - pan.x
    const wy = (cy - h / 2) / zoom - pan.y
    const factor = Math.exp(-e.deltaY * 0.0015)
    const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor))
    // Keep the same world point under the cursor after zoom.
    setPan({ x: (cx - w / 2) / nz - wx, y: (cy - h / 2) / nz - wy })
    setZoom(nz)
  }

  // ── Drag to pan ─────────────────────────────────────────────────────────────────

  function handleBgPointerDown(e: React.PointerEvent) {
    ;(e.currentTarget as SVGElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
    setDragging(true)
  }

  function handlePointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const dx = (e.clientX - d.startX) / zoom
    const dy = (e.clientY - d.startY) / zoom
    setPan({ x: d.panX + dx, y: d.panY + dy })
  }

  function handlePointerUp(e: React.PointerEvent) {
    dragRef.current = null
    setDragging(false)
    try {
      ;(e.currentTarget as SVGElement).releasePointerCapture(e.pointerId)
    } catch {
      // pointer capture may already be released
    }
  }

  // ── Filtering (dim, never remove) ────────────────────────────────────────────────

  const incident = useMemo(() => {
    if (!hoverId) return new Set<string>()
    const s = new Set<string>()
    for (const e of edges) {
      if (e.from === hoverId || e.to === hoverId) {
        s.add(`${e.from} ${e.to}`)
      }
    }
    return s
  }, [hoverId, edges])

  /**
   * A file node passes the filters when it matches the active project set (or none
   * active) and the active type set. The graph payload carries no per-file `type`
   * (GraphNode is { id, label, kind, domain, degree }), so the Type chips can only
   * narrow files that expose a type — none do here. We therefore treat type as
   * unknown = always-passes, so the Type chips never wrongly dim real notes. See the
   * ambiguity note in the component header / report. Project chips drive `domain`,
   * which the payload does provide, so they filter fully.
   */
  function nodeVisible(n: GraphNode): boolean {
    if (n.kind === 'ticket') return showTickets
    const projOk = activeProjects.size === 0 || activeProjects.has(n.domain)
    // Type is unknown on the payload, so the Type chips never narrow files here
    // (always passes — see note above). Reference activeTypes so the dependency is
    // honest if a future payload adds a per-file type.
    void activeTypes
    return projOk
  }

  const visibleMap = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const n of nodes) m.set(n.id, nodeVisible(n))
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeProjects, activeTypes, showTickets])

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  const showLabels = zoom >= LABEL_ZOOM_THRESHOLD

  function nodeOpacity(id: string): number {
    return visibleMap.get(id) ? 1 : DIM
  }

  // ── Chrome (top-bar right slot: Reset view) ────────────────────────────────────

  const { setRight } = useTopBarSlot()
  useEffect(() => {
    setRight(
      <Button variant="secondary" size="sm" onClick={fitAll}>
        Reset view
      </Button>,
    )
    return () => setRight(null)
  }, [setRight, fitAll])

  // ── States: loading / error / empty ────────────────────────────────────────────

  const hasAnyNode = nodes.length > 0
  // Empty state only when there is nothing at all. If there are nodes but no edges
  // (all orphans), the NOT YET LINKED shelf is the content — skip the empty state.
  const isEmpty = !loading && !error && !hasAnyNode

  if (loading) {
    return (
      <ViewBody>
        <Centered color={color.inkSoft}>Drawing your graph…</Centered>
      </ViewBody>
    )
  }

  if (error) {
    return (
      <ViewBody>
        <div
          style={{
            margin: 'auto',
            padding: `${space[4]}px ${space[5]}px`,
            // Error voice is the calm tan notice (§C), never the heather removal
            // hue — matches the Links tab error block.
            background: 'rgba(155,123,90,0.08)',
            borderRadius: radius.md,
            ...typeToken.body,
            color: color.notice,
          }}
        >
          Could not load the graph.
        </div>
      </ViewBody>
    )
  }

  if (isEmpty) {
    return (
      <ViewBody>
        <Centered color={color.inkFaint}>
          No connections yet. Link notes with{' '}
          <code style={{ ...typeToken.mono, color: color.inkSoft }}>[[</code> or mention a ticket, and your graph
          grows here.
        </Centered>
      </ViewBody>
    )
  }

  // ── Main canvas ─────────────────────────────────────────────────────────────────

  return (
    <ViewBody>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {/* SVG canvas */}
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ display: 'block', background: color.bgApp, cursor: dragging ? 'grabbing' : 'grab' }}
          onWheel={handleWheel}
          onPointerDown={handleBgPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Edges (beneath nodes) */}
          <g>
            {edges.map((e, i) => {
              const a = positions.get(e.from)
              const b = positions.get(e.to)
              if (!a || !b) return null
              const pa = toCanvas(a.x, a.y)
              const pb = toCanvas(b.x, b.y)
              const lit = hoverId != null && incident.has(`${e.from} ${e.to}`)
              const bothVisible = (visibleMap.get(e.from) ?? true) && (visibleMap.get(e.to) ?? true)
              return (
                <line
                  key={i}
                  x1={pa.x}
                  y1={pa.y}
                  x2={pb.x}
                  y2={pb.y}
                  stroke={lit ? color.forestLine : color.hair}
                  strokeWidth={1}
                  opacity={bothVisible ? 1 : DIM}
                />
              )
            })}
          </g>

          {/* Connected nodes */}
          <g>
            {connected.map(n => {
              const p = positions.get(n.id)
              if (!p) return null
              if (n.kind === 'ticket' && !showTickets) return null
              const c = toCanvas(p.x, p.y)
              return renderNode(n, c.x, c.y)
            })}
          </g>

          {/* Orphan shelf */}
          {shelf && (
            <g>
              {/* Divider line */}
              {(() => {
                const a = toCanvas(shelf.left, shelf.dividerY)
                const b = toCanvas(shelf.right, shelf.dividerY)
                return (
                  <>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color.hair} strokeWidth={1} />
                    <text
                      x={a.x}
                      y={a.y - 8}
                      style={{
                        ...typeToken.label,
                        fill: color.inkFaint,
                      }}
                    >
                      NOT YET LINKED
                    </text>
                  </>
                )
              })()}
              {shelf.items.map(it => {
                if (it.node.kind === 'ticket' && !showTickets) return null
                const c = toCanvas(it.x, it.y)
                return renderNode(it.node, c.x, c.y)
              })}
            </g>
          )}
        </svg>

        {/* Filter chip strip (top-left, floats over the canvas) */}
        <div
          style={{
            position: 'absolute',
            top: space[4],
            left: space[4],
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: space[2],
            maxWidth: '70%',
            background: color.bgField,
            border: `1px solid ${color.hair}`,
            borderRadius: radius.field,
            padding: `${space[2]}px ${space[3]}px`,
          }}
        >
          {KNOWN_TYPES.map(t => (
            <TypeChip
              key={t}
              label={t}
              active={activeTypes.has(t)}
              onClick={() => toggle(activeTypes, t, setActiveTypes)}
            />
          ))}
          <div style={{ width: 1, background: color.hair, margin: '0 2px', alignSelf: 'stretch' }} />
          {KNOWN_PROJECTS.map(p => (
            <TypeChip
              key={p}
              label={p}
              active={activeProjects.has(p)}
              onClick={() => toggle(activeProjects, p, setActiveProjects)}
            />
          ))}
          <div style={{ width: 1, background: color.hair, margin: '0 2px', alignSelf: 'stretch' }} />
          <TypeChip label="Tickets" active={showTickets} onClick={() => setShowTickets(v => !v)} />
        </div>
      </div>
    </ViewBody>
  )

  // ── Node renderer (closure: needs hover + transform state) ─────────────────────

  function renderNode(n: GraphNode, cx: number, cy: number) {
    const isHover = hoverId === n.id
    const op = nodeOpacity(n.id)

    if (n.kind === 'ticket') {
      // Hollow mono ring — a ticket's identity, no domain hue.
      return (
        <g
          key={n.id}
          opacity={op}
          style={{ cursor: 'pointer' }}
          onPointerEnter={() => setHoverId(n.id)}
          onPointerLeave={() => setHoverId(prev => (prev === n.id ? null : prev))}
          onClick={() => onOpenTicket(n.id)}
        >
          <circle
            cx={cx}
            cy={cy}
            r={TICKET_R * zoom}
            fill={color.bgRaised}
            stroke={color.inkFaint}
            strokeWidth={1.5}
          />
          {(showLabels || isHover) && (
            <text
              x={cx}
              y={cy + TICKET_R * zoom + 12}
              textAnchor="middle"
              style={{ ...typeToken.mono, fontSize: 10, fill: isHover ? color.ink : color.inkSoft }}
            >
              {n.label}
            </text>
          )}
        </g>
      )
    }

    // File node — filled circle, domain hue, size by degree.
    const hue = domainHue(n.domain)
    const r = fileRadius(n.degree) * zoom
    return (
      <g
        key={n.id}
        opacity={op}
        style={{ cursor: 'pointer' }}
        onPointerEnter={() => setHoverId(n.id)}
        onPointerLeave={() => setHoverId(prev => (prev === n.id ? null : prev))}
        onClick={() => onOpenFile(n.id)}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill={hue.fill}
          stroke={hue.stroke}
          strokeWidth={1}
          strokeOpacity={isHover ? 1 : 0.6}
        />
        {(showLabels || isHover) && (
          <text
            x={cx}
            y={cy + r + 12}
            textAnchor="middle"
            style={{ ...typeToken.meta, fill: isHover ? color.ink : color.inkSoft }}
          >
            {n.label}
          </text>
        )}
      </g>
    )
  }
}

// ── Small shell helpers ──────────────────────────────────────────────────────────

function Centered({ children, color: c }: { children: React.ReactNode; color: string }) {
  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 420,
        textAlign: 'center',
        ...typeToken.body,
        color: c,
        fontFamily: font.sans,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  )
}
