'use client'

/**
 * TopBarSlot.tsx
 *
 * The slot context for the one persistent top bar (TIN-1708). Full views own
 * their own right-slot actions (Graph's reset, Changes' refresh, the Check /
 * Fields readouts) — those are computed inside the view from the view's own
 * state. Rather than lift that state up to page.tsx, each view registers its
 * right-slot node here on mount and clears it on unmount.
 *
 * page.tsx provides the context (holding the `viewRight` node in state) and the
 * TopBar reads it. Views call `setRight(<actions/>)` / `setRight(null)`.
 */

import { createContext, useContext } from 'react'

export interface TopBarSlot {
  /** Register (or clear) the active view's right-slot content. */
  setRight: (node: React.ReactNode) => void
}

const noop: TopBarSlot = { setRight: () => {} }

const TopBarSlotContext = createContext<TopBarSlot>(noop)

export const TopBarSlotProvider = TopBarSlotContext.Provider

export function useTopBarSlot(): TopBarSlot {
  return useContext(TopBarSlotContext)
}

export default TopBarSlotContext
