'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { color, radius, shadow, type as typeTokens, space, font } from '@/lib/tokens'
import { slugify } from '@/lib/slug'

// ── Constants ─────────────────────────────────────────────────────────────────

const LAST_PROJECT_KEY = 'quick-capture-last-project'

const FILE_TYPES = ['feedback', 'project', 'user', 'reference'] as const
type FileType = (typeof FILE_TYPES)[number]

const PROJECTS = ['attic', 'understory', 'website', 'studio', 'shared'] as const
type Project = (typeof PROJECTS)[number]


function getLastProject(): Project {
  try {
    const stored = localStorage.getItem(LAST_PROJECT_KEY)
    if (stored && (PROJECTS as readonly string[]).includes(stored)) {
      return stored as Project
    }
  } catch { /* ignore */ }
  return 'studio'
}

function setLastProject(p: Project): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, p)
  } catch { /* ignore */ }
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface ChipProps {
  label: string
  active: boolean
  onClick: () => void
  variant?: 'type' | 'project'
}

function Chip({ label, active, onClick, variant = 'type' }: ChipProps) {
  const isProject = variant === 'project'
  const activeColor = isProject ? color.tan : color.forest
  const activeBg = isProject ? color.tan : color.forest

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: radius.chip,
        border: active
          ? `1.5px solid ${activeColor}`
          : `1px solid ${color.line}`,
        background: active ? activeBg : 'transparent',
        color: active ? '#fff' : color.inkSoft,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontFamily: font.sans,
        transition: 'all 0.12s ease',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface QuickCaptureProps {
  open: boolean
  onClose: () => void
  /** Called on successful save. path = the file path returned by create_file; project = selected project. */
  onSaved: (path: string, project: string) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuickCapture({ open, onClose, onSaved }: QuickCaptureProps) {
  const [content, setContent] = useState('')
  const [fileType, setFileType] = useState<FileType>('feedback')
  const [project, setProject] = useState<Project>('studio')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [shaking, setShaking] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Reset and focus on open
  useEffect(() => {
    if (open) {
      setContent('')
      setSaveError(false)
      setShaking(false)
      setSaving(false)
      setFileType('feedback')
      setProject(getLastProject())
      // Defer focus so the DOM is ready
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  const handleSave = useCallback(async () => {
    if (saving) return

    // Empty content: gentle shake, no-op
    if (!content.trim()) {
      setShaking(true)
      setTimeout(() => setShaking(false), 400)
      return
    }

    // Derive name from first non-empty line
    const firstLine = content.split('\n').find((l) => l.trim()) ?? content.trim()
    const name = firstLine.trim().slice(0, 120) // cap at 120 chars for safety
    const slug = slugify(name)

    setSaving(true)
    setSaveError(false)

    try {
      const path = await invoke<string>('create_file', {
        payload: {
          name,
          slug,
          fileType: fileType,
          projects: [project],
          tags: [],
        },
      })
      setLastProject(project)
      // Reset before calling onSaved so state is clean if the modal re-opens fast
      setContent('')
      onSaved(path, project)
      onClose()
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }, [saving, content, fileType, project, onSaved, onClose])

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      }
    },
    [onClose, handleSave]
  )

  if (!open) return null

  return (
    <>
      {/* Shake keyframe injected once */}
      <style>{`
        @keyframes qc-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-4px); }
          40% { transform: translateX(4px); }
          60% { transform: translateX(-3px); }
          80% { transform: translateX(3px); }
        }
        .qc-shake { animation: qc-shake 0.35s ease; }
      `}</style>

      {/* Scrim */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2000,
          background: color.scrim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        {/* Modal card */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick capture"
          className={shaking ? 'qc-shake' : undefined}
          style={{
            width: 440,
            background: color.bgRaised,
            borderRadius: radius.lg,
            boxShadow: shadow.modal,
            padding: space[7],
            display: 'flex',
            flexDirection: 'column',
            gap: space[5],
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                ...typeTokens.label,
                color: color.inkSoft,
              }}
            >
              Quick capture
            </span>
            <span
              style={{
                ...typeTokens.mono,
                fontSize: 11,
                color: color.inkFaint,
              }}
            >
              &#x2318;&#x21A9; to save
            </span>
          </div>

          {/* Content hero: borderless serif textarea */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              if (saveError) setSaveError(false)
            }}
            onKeyDown={handleKeyDown}
            placeholder="What's on your mind?"
            rows={6}
            style={{
              fontFamily: font.serif,
              fontSize: 15,
              fontWeight: 400,
              lineHeight: 1.6,
              color: color.ink,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              width: '100%',
              boxSizing: 'border-box',
              padding: 0,
              // Placeholder color via CSS variable trick — handled via globals if available,
              // or accept browser default which is close to inkFaint
            }}
          />

          {/* Error notice — above control row, calm/recessive */}
          {saveError && (
            <div
              style={{
                ...typeTokens.body,
                color: color.notice,
                background: color.tanTint,
                borderRadius: radius.md,
                padding: `${space[2]}px ${space[4]}px`,
              }}
            >
              Could not save. Your text is still here.
            </div>
          )}

          {/* Control row */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: space[3],
              borderTop: `1px solid ${color.hair}`,
              paddingTop: space[4],
            }}
          >
            {/* Type chips */}
            <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
              {FILE_TYPES.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  active={fileType === t}
                  onClick={() => setFileType(t)}
                  variant="type"
                />
              ))}
            </div>

            {/* Project chips */}
            <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
              {PROJECTS.map((p) => (
                <Chip
                  key={p}
                  label={p}
                  active={project === p}
                  onClick={() => {
                    setProject(p)
                  }}
                  variant="project"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
