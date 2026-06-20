import { vi, describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

// jsdom's navigator.platform is '' — the component checks for 'Mac' to choose
// between metaKey and ctrlKey. Patch it so ctrlKey acts as the modifier in tests.
// (Simpler than firing metaKey, which jsdom also swallows inconsistently.)
Object.defineProperty(navigator, 'platform', { value: '', configurable: true })

import QuickCapture from './QuickCapture'

const noop = () => {}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue('/memory/studio/my-thought.md')
})

describe('QuickCapture', () => {
  it('calls invoke(create_file) with correct payload on Cmd+Enter', async () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<QuickCapture open onClose={onClose} onSaved={onSaved} />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    await userEvent.type(textarea, 'My thought here')

    // Fire Ctrl+Enter — jsdom platform is '' (non-Mac), so ctrlKey is the modifier
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    expect(invoke).toHaveBeenCalledWith('create_file', {
      payload: {
        name: 'My thought here',
        slug: 'my-thought-here',
        fileType: 'feedback',
        projects: ['studio'],
        tags: [],
      },
    })
    expect(onSaved).toHaveBeenCalledWith('/memory/studio/my-thought.md', 'studio')
    expect(onClose).toHaveBeenCalled()
  })

  it('does NOT call invoke when content is empty and Cmd+Enter is pressed', async () => {
    render(<QuickCapture open onClose={noop} onSaved={noop} />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    // textarea is empty — fire Ctrl+Enter (non-Mac jsdom env)
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    // Give the async path time to potentially fire
    await new Promise((r) => setTimeout(r, 20))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<QuickCapture open onClose={onClose} onSaved={noop} />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('renders nothing when open=false', () => {
    render(<QuickCapture open={false} onClose={noop} onSaved={noop} />)
    expect(screen.queryByPlaceholderText("What's on your mind?")).toBeNull()
  })

  it('uses the name from the first non-empty line as the slug basis', async () => {
    const onSaved = vi.fn()
    render(<QuickCapture open onClose={noop} onSaved={onSaved} />)

    const textarea = screen.getByPlaceholderText("What's on your mind?")
    // First line is the title; second line is body text
    await userEvent.type(textarea, 'Title Line{Enter}Body content')

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))

    const payload = invoke.mock.calls[0][1].payload
    expect(payload.name).toBe('Title Line')
    expect(payload.slug).toBe('title-line')
  })
})
