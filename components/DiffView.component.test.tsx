import { vi, describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import DiffView from './DiffView'

beforeEach(() => {
  invoke.mockReset()
})

describe('DiffView', () => {
  it('calls invoke(git_status) with the workingDir on mount', async () => {
    invoke.mockResolvedValueOnce({ branch: 'main', files: [] })

    render(<DiffView workingDir="/projects/myrepo" />)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('git_status', { dir: '/projects/myrepo' })
    )
  })

  it('renders the file list when git_status resolves with files', async () => {
    invoke.mockResolvedValueOnce({
      branch: 'main',
      files: [
        { path: 'src/app.ts', status: 'M' },
        { path: 'src/new.ts', status: 'A' },
        { path: 'src/old.ts', status: 'D' },
      ],
    })

    render(<DiffView workingDir="/projects/myrepo" />)

    await waitFor(() => screen.getByText('src/app.ts'))

    expect(screen.getByText('src/new.ts')).toBeInTheDocument()
    expect(screen.getByText('src/old.ts')).toBeInTheDocument()
    // summary shows 3 files changed
    expect(screen.getByText('3 files changed')).toBeInTheDocument()
  })

  it('shows "This folder isn\'t a git repository." when backend signals not-a-repo', async () => {
    invoke.mockRejectedValueOnce(new Error('not-a-repo: /projects/notgit'))

    render(<DiffView workingDir="/projects/notgit" />)

    await waitFor(() =>
      expect(screen.getByText(/This folder isn't a git repository\./)).toBeInTheDocument()
    )
    // Should NOT show the file list
    expect(screen.queryByText('files changed')).toBeNull()
  })

  it('shows "Nothing changed yet." when git_status returns an empty files array', async () => {
    invoke.mockResolvedValueOnce({ branch: 'feature/clean', files: [] })

    render(<DiffView workingDir="/projects/clean" />)

    await waitFor(() =>
      expect(screen.getByText('Nothing changed yet.')).toBeInTheDocument()
    )
  })

  it('loads a diff when a file row is clicked', async () => {
    invoke
      .mockResolvedValueOnce({
        branch: 'main',
        files: [{ path: 'src/app.ts', status: 'M' }],
      })
      .mockResolvedValueOnce('+added line\n-removed line\n')

    render(<DiffView workingDir="/projects/myrepo" />)

    await waitFor(() => screen.getByText('src/app.ts'))
    fireEvent.click(screen.getByText('src/app.ts'))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('git_diff', {
        payload: { dir: '/projects/myrepo', file: 'src/app.ts' },
      })
    )
  })
})
