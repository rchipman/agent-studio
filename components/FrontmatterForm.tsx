'use client'

/**
 * FrontmatterForm.tsx
 *
 * The shared editable frontmatter form (TIN-1638), used by all three frontmatter
 * surfaces: smart-generation on create, the import flow, and the audit fix editor.
 * Fields: name (slug), title, type (chips), projects (multi-select chips),
 * tags (tag input), status. Below the fields, a live `ResultCard` preview under the
 * `HOW THIS WILL LOOK` label, built from the current values via `suggestionToResult`.
 *
 * House rules: tokens only (no magic numbers), no red, no alarm glyphs, calm copy,
 * no em-dashes, curly apostrophes. The parent owns regeneration; this form merely
 * surfaces `onRegenerate` as a quiet affordance and edits `value` via `onChange`.
 */

import { useState } from 'react'
import { color, space, radius, font, type as type_ } from '@/lib/tokens'
import type { MemorySearchResult } from '@/lib/types'
import type { Suggestion } from '@/lib/frontmatter'
import TypeChip from '@/components/TypeChip'
import Button from '@/components/Button'

// ── Defaults that mirror the rest of the app's known vocabulary ──────────────

const DEFAULT_TYPES = ['feedback', 'project', 'user', 'reference']
const DEFAULT_PROJECTS = ['attic', 'understory', 'website', 'studio', 'shared']

// ── Suggestion → MemorySearchResult adapter (sibling of linkedToResult) ──────

/** Adapt a Suggestion to the MemorySearchResult shape ResultCard renders, so the
 *  preview is the actual search card, not a separate styled box. */
export function suggestionToResult(s: Suggestion): MemorySearchResult {
  return {
    path: '',
    name: s.name || s.title || '',
    type: s.type,
    projects: s.projects,
    created: s.created,
    updated: '',
    tags: s.tags,
    status: s.status,
    excerpt: s.summary || (s.title && s.title !== s.name ? s.title : ''),
  }
}

// ── The live ResultCard preview (resting, non-interactive) ───────────────────

function PreviewCard({ result }: { result: MemorySearchResult }) {
  const projects = result.projects.filter(Boolean)
  const namePlaceholder = !result.name
  return (
    <div
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '12px 16px',
        background: color.bgCard,
        border: `1px solid ${color.hairSoft}`,
        borderRadius: radius.card,
        cursor: 'default',
      }}
    >
      {/* MetaBar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[3],
          flexWrap: 'wrap',
          marginBottom: space[1],
        }}
      >
        {result.type && (
          <span
            style={{
              padding: '1px 7px',
              borderRadius: radius.chip,
              background: color.forestTint,
              color: color.forest,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.02em',
            }}
          >
            {result.type}
          </span>
        )}
        {projects.map((p) => (
          <span
            key={p}
            style={{
              padding: '1px 7px',
              borderRadius: radius.chip,
              background: color.tanTint,
              color: color.tan,
              fontSize: 10,
              fontWeight: 500,
            }}
          >
            {p}
          </span>
        ))}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: namePlaceholder ? color.inkFaint : color.ink,
          fontStyle: namePlaceholder ? 'italic' : 'normal',
          marginBottom: 3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {result.name || 'untitled-note'}
      </div>
      {result.excerpt && (
        <div
          style={{
            fontSize: 11,
            color: color.inkSoft,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.4,
          }}
        >
          {result.excerpt}
        </div>
      )}
    </div>
  )
}

// ── Field shells ─────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: `${space[2]}px ${space[3]}px`,
  border: `1px solid ${color.line}`,
  borderRadius: radius.md,
  background: color.bgField,
  color: color.ink,
  fontSize: 13,
  fontFamily: font.sans,
  outline: 'none',
  boxSizing: 'border-box',
}

function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: space[4] }}>
      <label style={{ ...type_.label, color: color.inkSoft, display: 'block', marginBottom: space[2] }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Tag input (Enter adds a tag) ─────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
}: {
  tags: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const t = draft.trim()
    if (!t) return
    if (!tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: space[2],
        padding: `${space[1]}px ${space[2]}px`,
        border: `1px solid ${color.line}`,
        borderRadius: radius.md,
        background: color.bgField,
      }}
    >
      {tags.map((t) => (
        <span
          key={t}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: space[1],
            padding: '2px 8px',
            borderRadius: radius.chip,
            background: color.neutralTint,
            color: color.inkSoft,
            fontSize: 11,
            fontFamily: font.sans,
          }}
        >
          {t}
          <button
            onClick={() => onChange(tags.filter((x) => x !== t))}
            aria-label={`Remove ${t}`}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: color.inkFaint,
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        placeholder={tags.length ? '' : 'Add a tag'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={add}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 80,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: color.ink,
          fontSize: 13,
          fontFamily: font.sans,
          padding: `${space[1]}px 0`,
        }}
      />
    </div>
  )
}

// ── The form ─────────────────────────────────────────────────────────────────

export interface FrontmatterFormProps {
  value: Suggestion
  onChange: (next: Suggestion) => void
  knownTypes?: string[]
  knownProjects?: string[]
  /** Shown as the quiet "Regenerate" affordance when provided. */
  onRegenerate?: () => void
  regenerating?: boolean
  /** e.g. "Described from your note." / "From this file's frontmatter." */
  sourceLabel?: string
  /** True when the body has changed since the summary was generated; surfaces a
   *  quiet "Summary may be out of date." cue under the Summary field. */
  summaryStale?: boolean
}

export default function FrontmatterForm({
  value,
  onChange,
  knownTypes,
  knownProjects,
  onRegenerate,
  regenerating,
  sourceLabel,
  summaryStale,
}: FrontmatterFormProps) {
  const types = knownTypes && knownTypes.length ? knownTypes : DEFAULT_TYPES
  const projects = knownProjects && knownProjects.length ? knownProjects : DEFAULT_PROJECTS

  function patch(p: Partial<Suggestion>) {
    onChange({ ...value, ...p })
  }

  function toggleProject(p: string) {
    const has = value.projects.includes(p)
    patch({ projects: has ? value.projects.filter((x) => x !== p) : [...value.projects, p] })
  }

  return (
    <div>
      {/* Name (slug) — sacrosanct once hand-edited; the parent owns regenerate */}
      <FieldRow label="Name">
        <input
          type="text"
          value={value.name}
          onChange={(e) => patch({ name: e.target.value })}
          onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
          onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
          spellCheck={false}
          style={{ ...fieldStyle, fontFamily: font.mono }}
        />
      </FieldRow>

      <FieldRow label="Title">
        <input
          type="text"
          value={value.title}
          onChange={(e) => patch({ title: e.target.value })}
          onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
          onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
          style={fieldStyle}
        />
      </FieldRow>

      <FieldRow label="Summary">
        <textarea
          value={value.summary ?? ''}
          onChange={(e) => patch({ summary: e.target.value })}
          onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
          onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
          placeholder="A sentence or two on what this note decides or records."
          style={{
            ...fieldStyle,
            minHeight: space[8] * 2,
            lineHeight: 1.5,
            resize: 'vertical',
          }}
        />
        {summaryStale && (
          <div
            style={{
              ...type_.meta,
              color: color.notice,
              display: 'flex',
              alignItems: 'center',
              gap: space[3],
              marginTop: space[2],
            }}
          >
            <span>Summary may be out of date.</span>
            {onRegenerate && !regenerating && (
              <Button
                variant="tertiary"
                padding="none"
                onClick={onRegenerate}
                style={{ fontSize: 11, fontWeight: 400 }}
              >
                Regenerate
              </Button>
            )}
          </div>
        )}
      </FieldRow>

      <FieldRow label="Type">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
          {types.map((t) => (
            <TypeChip
              key={t}
              label={t}
              active={value.type === t}
              onClick={() => patch({ type: value.type === t ? '' : t })}
            />
          ))}
        </div>
      </FieldRow>

      <FieldRow label="Projects">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[2] }}>
          {projects.map((p) => (
            <TypeChip
              key={p}
              label={p}
              active={value.projects.includes(p)}
              onClick={() => toggleProject(p)}
            />
          ))}
        </div>
      </FieldRow>

      <FieldRow label="Tags">
        <TagInput tags={value.tags} onChange={(tags) => patch({ tags })} />
      </FieldRow>

      <FieldRow label="Status">
        <input
          type="text"
          value={value.status}
          onChange={(e) => patch({ status: e.target.value })}
          onFocus={(e) => (e.currentTarget.style.borderColor = color.forest)}
          onBlur={(e) => (e.currentTarget.style.borderColor = color.line)}
          style={fieldStyle}
        />
      </FieldRow>

      {/* Source line + Regenerate affordance */}
      {(sourceLabel || onRegenerate) && (
        <div
          style={{
            ...type_.meta,
            color: color.inkFaint,
            display: 'flex',
            alignItems: 'center',
            gap: space[3],
            marginBottom: space[4],
          }}
        >
          {sourceLabel && <span>{regenerating ? 'Describing…' : sourceLabel}</span>}
          {onRegenerate && !regenerating && (
            <Button
              variant="tertiary"
              padding="none"
              onClick={onRegenerate}
              style={{ fontSize: 11, fontWeight: 400 }}
            >
              Regenerate
            </Button>
          )}
        </div>
      )}

      {/* Live preview */}
      <div style={{ borderTop: `1px solid ${color.hair}`, paddingTop: space[5] }}>
        <div style={{ ...type_.label, color: color.inkSoft, marginBottom: space[3] }}>
          HOW THIS WILL LOOK
        </div>
        <PreviewCard result={suggestionToResult(value)} />
      </div>
    </div>
  )
}
