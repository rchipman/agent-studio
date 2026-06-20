'use client'

import { color, radius, font } from '@/lib/tokens'

/**
 * Shared pill toggle (type/filter chip). Active = forest fill / white;
 * resting = transparent / ink-soft with a hairline border.
 */
export default function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: radius.chip,
        border: active ? `1.5px solid ${color.forest}` : `1px solid ${color.line}`,
        background: active ? color.forest : 'transparent',
        color: active ? '#fff' : color.inkSoft,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        fontFamily: font.sans,
        transition: 'all 0.12s ease',
      }}
    >
      {label}
    </button>
  )
}
