'use client'

import { useEffect, useRef, useState } from 'react'

interface LinearPanelProps {
  ticketId: string | null
  onClose: () => void
}

export default function LinearPanel({ ticketId, onClose }: LinearPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [iframeBlocked, setIframeBlocked] = useState(false)
  const isOpen = ticketId !== null
  const url = ticketId
    ? `https://linear.app/tiny-forest/issue/${ticketId}`
    : ''

  // Reset blocked state when ticket changes
  useEffect(() => {
    setIframeBlocked(false)
  }, [ticketId])

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Small delay to avoid immediately closing on the click that opened it
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 50)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen, onClose])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  const openInBrowser = async () => {
    if (!url) return
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch {
      window.open(url, '_blank')
    }
    onClose()
  }

  // Detect X-Frame-Options block: the iframe load event fires but
  // we can't access contentDocument cross-origin. We use a timed
  // heuristic — if the iframe doesn't update its title within 4s,
  // assume it was blocked and fall back to browser.
  const handleIframeLoad = () => {
    try {
      const iframe = document.querySelector<HTMLIFrameElement>('[data-linear-iframe]')
      if (!iframe) return
      // If contentDocument is accessible and has no meaningful content,
      // it may be a blocked frame. Cross-origin blocks throw on access.
      const doc = iframe.contentDocument
      if (doc && doc.body && doc.body.innerHTML.length < 50) {
        setIframeBlocked(true)
      }
    } catch {
      // Cross-origin — iframe loaded successfully from Linear's domain
      // (throws because we can't read it, which means it DID load)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: isOpen ? '480px' : '0',
        zIndex: 100,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
        boxShadow: isOpen ? '-4px 0 24px rgba(0,0,0,0.12)' : 'none',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {isOpen && (
        <div ref={panelRef} style={{ width: '480px', height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div
            style={{
              height: '44px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 16px',
              borderBottom: '1px solid rgba(0,0,0,0.1)',
              flexShrink: 0,
              background: '#F8F8F7',
            }}
          >
            <span
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: '#262320',
                fontFamily: 'system-ui, sans-serif',
              }}
            >
              {ticketId}
            </span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={openInBrowser}
                style={{
                  fontSize: '11px',
                  color: '#6B6760',
                  fontFamily: 'system-ui, sans-serif',
                  padding: '3px 6px',
                  borderRadius: '3px',
                  border: '1px solid rgba(0,0,0,0.15)',
                  cursor: 'pointer',
                  background: 'transparent',
                }}
              >
                Open in browser
              </button>
              <button
                onClick={onClose}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  color: '#6B6760',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '4px',
                }}
                aria-label="Close panel"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                  <line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {/* iframe or fallback */}
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            {iframeBlocked ? (
              <div style={{ textAlign: 'center', padding: '32px', fontFamily: 'system-ui, sans-serif' }}>
                <div style={{ fontSize: '14px', color: '#262320', marginBottom: '8px' }}>
                  Linear blocks embedding
                </div>
                <div style={{ fontSize: '12px', color: '#6B6760', marginBottom: '20px' }}>
                  {ticketId} cannot be shown in a panel.
                </div>
                <button
                  onClick={openInBrowser}
                  style={{
                    background: '#5E6AD2',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '5px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    fontFamily: 'system-ui, sans-serif',
                  }}
                >
                  Open in browser
                </button>
              </div>
            ) : (
              <iframe
                key={ticketId}
                data-linear-iframe="true"
                src={url}
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={handleIframeLoad}
                title={`Linear issue ${ticketId}`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
