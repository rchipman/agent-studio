import { vi, describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

// jsdom doesn't implement scrollIntoView; the component calls it on keyboard nav
window.HTMLElement.prototype.scrollIntoView = vi.fn()

import CommandPalette from './CommandPalette'

const MOCK_RESULTS = [
  {
    path: '/memory/studio/attic-ideas.md',
    name: 'Attic ideas',
    type: 'project',
    projects: ['studio'],
    created: '2024-01-01',
    updated: '2024-01-02',
    tags: [],
    status: 'active',
    excerpt: 'Some excerpt text',
  },
  {
    path: '/memory/studio/user-notes.md',
    name: 'User notes',
    type: 'user',
    projects: ['attic'],
    created: '2024-01-01',
    updated: '2024-01-02',
    tags: [],
    status: 'active',
    excerpt: '',
  },
]

beforeEach(() => {
  invoke.mockReset()
  // Default: empty initial load
  invoke.mockResolvedValue({ results: [] })
})

describe('CommandPalette', () => {
  it('renders nothing when open=false', () => {
    render(
      <CommandPalette
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        memoryRoot="/memory"
      />
    )
    expect(screen.queryByPlaceholderText('Jump to file…')).toBeNull()
  })

  it('calls invoke(search) on open and renders results', async () => {
    invoke.mockResolvedValue({ results: MOCK_RESULTS })

    render(
      <CommandPalette
        open
        onClose={() => {}}
        onSelect={() => {}}
        memoryRoot="/memory"
      />
    )

    // Wait for at least one invoke('search') call from the initial load
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('search', expect.objectContaining({
        payload: expect.objectContaining({ q: '' }),
      }))
    )

    await waitFor(() => screen.getByText('Attic ideas'))
    expect(screen.getByText('User notes')).toBeInTheDocument()
  })

  it('calls invoke(search) with the typed query after debounce and shows results', async () => {
    // First call (empty) returns empty; second call (typed query) returns results
    invoke
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValue({ results: MOCK_RESULTS })

    render(
      <CommandPalette
        open
        onClose={() => {}}
        onSelect={() => {}}
        memoryRoot="/memory"
      />
    )

    const input = screen.getByPlaceholderText('Jump to file…')
    await userEvent.type(input, 'attic')

    // After debounce (200ms) the search fires; waitFor will keep polling
    await waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith('search', {
          payload: { q: 'attic', typeFilter: '', projectFilter: '', limit: 30, rebuild: false },
        }),
      { timeout: 1000 }
    )

    await waitFor(() => screen.getByText('Attic ideas'), { timeout: 1000 })
  })

  it('calls onSelect with the result path when a result row is clicked', async () => {
    invoke.mockResolvedValue({ results: MOCK_RESULTS })
    const onSelect = vi.fn()
    const onClose = vi.fn()

    render(
      <CommandPalette
        open
        onClose={onClose}
        onSelect={onSelect}
        memoryRoot="/memory"
      />
    )

    await waitFor(() => screen.getByText('Attic ideas'))
    fireEvent.click(screen.getByText('Attic ideas'))

    expect(onSelect).toHaveBeenCalledWith('/memory/studio/attic-ideas.md')
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', async () => {
    invoke.mockResolvedValue({ results: [] })
    const onClose = vi.fn()

    render(
      <CommandPalette
        open
        onClose={onClose}
        onSelect={() => {}}
        memoryRoot="/memory"
      />
    )

    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('shows "No files found" when search returns empty results', async () => {
    invoke.mockResolvedValue({ results: [] })

    render(
      <CommandPalette
        open
        onClose={() => {}}
        onSelect={() => {}}
        memoryRoot="/memory"
      />
    )

    await waitFor(() => screen.getByText('No files found'))
  })
})
