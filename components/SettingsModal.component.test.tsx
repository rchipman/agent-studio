import { vi, describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import SettingsModal from './SettingsModal'

const MOCK_SETTINGS = {
  memoryRoot: '/home/user/memory',
  promptsRoot: '/home/user/prompts',
  skillsRoot: '/home/user/skills',
  transcriptsRoot: '/home/user/transcripts',
  agents: [
    { name: 'Claude', command: 'claude', args: ['--print'], cwd: '/projects' },
  ],
}

function setupInvoke() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_settings') return Promise.resolve(MOCK_SETTINGS)
    if (cmd === 'embedding_key_status') return Promise.resolve('set')
    if (cmd === 'set_settings') return Promise.resolve(undefined)
    if (cmd === 'linear_key_status') return Promise.resolve('unset')
    if (cmd === 'list_linear_teams') return Promise.resolve([])
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  invoke.mockReset()
  setupInvoke()
})

describe('SettingsModal', () => {
  it('renders nothing when open=false', () => {
    render(<SettingsModal open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('calls invoke(get_settings) and invoke(embedding_key_status) on open', async () => {
    render(<SettingsModal open onClose={() => {}} />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_settings'))
    expect(invoke).toHaveBeenCalledWith('embedding_key_status')
  })

  it('renders the memoryRoot value after loading', async () => {
    render(<SettingsModal open onClose={() => {}} />)

    // Loading state first
    expect(screen.getByText('Loading settings…')).toBeInTheDocument()

    // After load completes, the Memory root input should have the value
    await waitFor(() => {
      const inputs = screen.getAllByDisplayValue('/home/user/memory')
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  it('renders the agent name in the Agents section', async () => {
    render(<SettingsModal open onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('Claude'))
    expect(screen.getByDisplayValue('claude')).toBeInTheDocument()
  })

  it('calls invoke(set_settings) when Done is clicked and then calls onClose', async () => {
    const onClose = vi.fn()
    render(<SettingsModal open onClose={onClose} />)

    await waitFor(() => screen.getByDisplayValue('/home/user/memory'))

    fireEvent.click(screen.getByText('Done'))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_settings', {
        payload: { settings: MOCK_SETTINGS },
      })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Cancel is clicked without invoking set_settings', async () => {
    const onClose = vi.fn()
    render(<SettingsModal open onClose={onClose} />)

    await waitFor(() => screen.getByText('Cancel'))
    fireEvent.click(screen.getByText('Cancel'))

    expect(onClose).toHaveBeenCalled()
    // set_settings should NOT have been called
    expect(invoke).not.toHaveBeenCalledWith('set_settings', expect.anything())
  })

  it('shows save error message when set_settings rejects', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_settings') return Promise.resolve(MOCK_SETTINGS)
      if (cmd === 'embedding_key_status') return Promise.resolve('unset')
      if (cmd === 'set_settings') return Promise.reject(new Error('disk full'))
      return Promise.resolve(undefined)
    })

    render(<SettingsModal open onClose={() => {}} />)

    await waitFor(() => screen.getByText('Done'))
    fireEvent.click(screen.getByText('Done'))

    await waitFor(() =>
      expect(
        screen.getByText('Could not save settings. Your changes are still here.')
      ).toBeInTheDocument()
    )
  })
})
