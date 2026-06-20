'use client'

import { useState, useRef, useEffect } from 'react'
import { FileNode } from '@/lib/types'

interface FileTreeProps {
  nodes: FileNode[]
  activePath: string | null
  onSelect: (path: string) => void
  onCreate: (parentPath: string, type: 'file' | 'folder', name: string) => void
  defaultExpanded?: boolean
  collapseSignal?: number
  pinnedPaths?: string[]
  onPin?: (path: string) => void
  onUnpin?: (path: string) => void
}

interface TreeNodeProps {
  node: FileNode
  activePath: string | null
  onSelect: (path: string) => void
  onCreate: (parentPath: string, type: 'file' | 'folder', name: string) => void
  depth: number
  defaultExpanded: boolean
  collapseSignal?: number
  pinnedPaths?: string[]
  onPin?: (path: string) => void
  onUnpin?: (path: string) => void
}

interface ContextMenuState {
  x: number
  y: number
  path: string
  isDir: boolean
}

function countFiles(node: FileNode): number {
  if (node.type === 'file') return 1
  return (node.children || []).reduce((acc, child) => acc + countFiles(child), 0)
}

function InlineInput({
  type,
  onConfirm,
  onCancel,
  depth,
}: {
  type: 'file' | 'folder'
  onConfirm: (name: string) => void
  onCancel: () => void
  depth: number
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div
      style={{
        paddingLeft: `${16 + depth * 16}px`,
        paddingRight: '8px',
        paddingTop: '2px',
        paddingBottom: '2px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <span style={{ fontSize: '11px', color: '#9B9490', flexShrink: 0 }}>
        {type === 'file' ? '◻' : '▷'}
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={type === 'file' ? 'filename.md' : 'folder-name'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            const trimmed = value.trim()
            if (trimmed) onConfirm(trimmed)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        onBlur={onCancel}
        style={{
          flex: 1,
          background: 'rgba(255,255,255,0.85)',
          border: '1px solid rgba(62,86,65,0.5)',
          borderRadius: '3px',
          padding: '2px 5px',
          fontSize: '12px',
          color: '#262320',
          outline: 'none',
          fontFamily: 'system-ui, sans-serif',
          minWidth: 0,
        }}
      />
    </div>
  )
}

// Singleton context menu — rendered at page level via portal-like approach
function ContextMenu({
  state,
  onNewFile,
  onNewFolder,
  onClose,
  isPinned,
  onPin,
  onUnpin,
}: {
  state: ContextMenuState
  onNewFile: () => void
  onNewFolder: () => void
  onClose: () => void
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
}) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      onClose()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  const items: { label: string; action: () => void }[] = state.isDir
    ? [
        { label: 'New file here', action: onNewFile },
        { label: 'New folder here', action: onNewFolder },
      ]
    : [
        { label: 'New file in parent', action: onNewFile },
        { label: 'New folder in parent', action: onNewFolder },
      ]

  if (state.isDir && onPin && onUnpin) {
    items.push({
      label: isPinned ? 'Unpin folder' : 'Pin folder',
      action: isPinned ? onUnpin : onPin,
    })
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: state.y,
        left: state.x,
        zIndex: 9999,
        background: '#FCFAF4',
        border: '1px solid rgba(38,35,32,0.15)',
        borderRadius: '7px',
        boxShadow: '0 6px 20px rgba(38,35,32,0.18)',
        padding: '4px',
        minWidth: '160px',
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => { item.action(); onClose() }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            border: 'none',
            background: 'transparent',
            fontSize: '13px',
            color: '#262320',
            cursor: 'pointer',
            borderRadius: '4px',
            fontFamily: 'system-ui, sans-serif',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = '#3E56411A' }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent' }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function TreeNode({ node, activePath, onSelect, onCreate, depth, defaultExpanded, collapseSignal, pinnedPaths, onPin, onUnpin }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [inlineCreate, setInlineCreate] = useState<'file' | 'folder' | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const prevSignalRef = useRef<number | undefined>(collapseSignal)
  useEffect(() => {
    if (collapseSignal !== undefined && collapseSignal !== prevSignalRef.current) {
      prevSignalRef.current = collapseSignal
      setExpanded(false)
      setInlineCreate(null)
    }
  }, [collapseSignal])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const isDir = node.type === 'dir'
    setContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isDir })
  }

  // For files, parent path = strip last segment
  const parentPath = node.type === 'file'
    ? node.path.slice(0, node.path.lastIndexOf('/'))
    : node.path

  const handleNewFile = () => {
    if (node.type === 'dir') {
      setExpanded(true)
      setInlineCreate('file')
    } else {
      const name = window.prompt('New file name:')
      if (name?.trim()) {
        const n = name.trim()
        onCreate(parentPath, 'file', n.endsWith('.md') ? n : n + '.md')
      }
    }
  }

  const handleNewFolder = () => {
    if (node.type === 'dir') {
      setExpanded(true)
      setInlineCreate('folder')
    } else {
      const name = window.prompt('New folder name:')
      if (name?.trim()) onCreate(parentPath, 'folder', name.trim())
    }
  }

  const handleConfirm = (name: string) => {
    let finalName = name
    if (inlineCreate === 'file' && !finalName.endsWith('.md')) {
      finalName = finalName + '.md'
    }
    onCreate(node.path, inlineCreate!, finalName)
    setInlineCreate(null)
  }

  if (node.type === 'file') {
    const isActive = activePath === node.path
    const label = node.name.replace(/\.md$/, '')

    return (
      <>
        <button
          onClick={() => onSelect(node.path)}
          onContextMenu={handleContextMenu}
          className="w-full text-left flex items-center gap-1 py-[3px] pr-2 rounded-sm transition-colors group"
          style={{
            paddingLeft: `${16 + depth * 16}px`,
            background: isActive ? '#3E564115' : 'transparent',
            borderLeft: isActive ? '2px solid #3E5641' : '2px solid transparent',
            color: isActive ? '#3E5641' : '#262320',
            fontWeight: isActive ? 500 : 400,
          }}
        >
          <span className="truncate" style={{ fontSize: '13px', lineHeight: '1.4' }}>
            {label}
          </span>
        </button>
        {contextMenu && (
          <ContextMenu
            state={contextMenu}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onClose={() => setContextMenu(null)}
            isPinned={false}
          />
        )}
      </>
    )
  }

  // Directory
  const fileCount = countFiles(node)

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        onContextMenu={handleContextMenu}
        className="w-full text-left flex items-center gap-1 py-[3px] pr-2 rounded-sm transition-colors hover:bg-black/5"
        style={{
          paddingLeft: `${12 + depth * 16}px`,
          fontSize: '13px',
          lineHeight: '1.4',
          color: '#262320',
        }}
      >
        {/* Folder open/closed icon */}
        <span className="flex-shrink-0 flex items-center justify-center" style={{ width: '14px', height: '14px' }}>
          {expanded ? (
            // Open folder: body + lifted front flap
            <svg width="14" height="13" viewBox="0 0 14 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* back panel */}
              <rect x="0.5" y="3.5" width="13" height="9" rx="1" fill="#8A7F74" opacity="0.55" />
              {/* tab on top-left */}
              <path d="M0.5 3.5 L0.5 2.5 Q0.5 2 1 2 L4.5 2 Q5 2 5.5 2.5 L6 3.5Z" fill="#8A7F74" opacity="0.55" />
              {/* lifted front flap */}
              <path d="M0.5 6 L13.5 6 L13.5 3.5 Q13.5 3 13 3 L7 3 L6 3.5 Z" fill="#8A7F74" opacity="0.75" />
            </svg>
          ) : (
            // Closed folder: body + tab on top-left
            <svg width="14" height="13" viewBox="0 0 14 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* main body */}
              <rect x="0.5" y="3.5" width="13" height="9" rx="1" fill="#8A7F74" opacity="0.65" />
              {/* tab on top-left */}
              <path d="M0.5 3.5 L0.5 2.5 Q0.5 2 1 2 L4.5 2 Q5 2 5.5 2.5 L6 3.5Z" fill="#8A7F74" opacity="0.65" />
            </svg>
          )}
        </span>
        <span className="truncate font-medium flex-1">{node.name}</span>
        <span style={{ fontSize: '11px', color: '#6B6760', flexShrink: 0 }}>{fileCount}</span>
      </button>

      {expanded && (
        <div>
          {inlineCreate && (
            <InlineInput
              type={inlineCreate}
              onConfirm={handleConfirm}
              onCancel={() => setInlineCreate(null)}
              depth={depth + 1}
            />
          )}
          {node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              onSelect={onSelect}
              onCreate={onCreate}
              depth={depth + 1}
              defaultExpanded={false}
              collapseSignal={collapseSignal}
              pinnedPaths={pinnedPaths}
              onPin={onPin}
              onUnpin={onUnpin}
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onClose={() => setContextMenu(null)}
          isPinned={pinnedPaths?.includes(node.path) ?? false}
          onPin={onPin ? () => onPin(node.path) : undefined}
          onUnpin={onUnpin ? () => onUnpin(node.path) : undefined}
        />
      )}
    </div>
  )
}

export default function FileTree({ nodes, activePath, onSelect, onCreate, defaultExpanded = true, collapseSignal, pinnedPaths, onPin, onUnpin }: FileTreeProps) {
  return (
    <div className="py-1">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          activePath={activePath}
          onSelect={onSelect}
          onCreate={onCreate}
          depth={0}
          defaultExpanded={defaultExpanded}
          collapseSignal={collapseSignal}
          pinnedPaths={pinnedPaths}
          onPin={onPin}
          onUnpin={onUnpin}
        />
      ))}
    </div>
  )
}
