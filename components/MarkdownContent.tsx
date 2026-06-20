'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { visit } from 'unist-util-visit'
import type { Root, Text, Element } from 'hast'

interface MarkdownContentProps {
  content: string
  onClick?: () => void
  onTicketClick?: (ticketId: string) => void
}

const TICKET_RE = /\bTIN-\d+\b/g

/** rehype plugin: converts TIN-XXXX text runs into <a data-linear-ticket> elements */
function rehypeLinearTickets() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent) => {
      if (
        parent == null ||
        index == null ||
        // Don't process text inside code blocks
        (parent as Element).tagName === 'code' ||
        (parent as Element).tagName === 'pre'
      ) {
        return
      }

      const text = node.value
      if (!TICKET_RE.test(text)) return
      TICKET_RE.lastIndex = 0

      const children: (Text | Element)[] = []
      let last = 0
      let m: RegExpExecArray | null

      while ((m = TICKET_RE.exec(text)) !== null) {
        if (m.index > last) {
          children.push({ type: 'text', value: text.slice(last, m.index) })
        }
        const ticketId = m[0]
        children.push({
          type: 'element',
          tagName: 'a',
          properties: {
            href: '#',
            'data-linear-ticket': ticketId,
          },
          children: [{ type: 'text', value: ticketId }],
        } as Element)
        last = m.index + ticketId.length
      }

      if (last < text.length) {
        children.push({ type: 'text', value: text.slice(last) })
      }

      if (children.length === 0) return

      // Replace the single text node with a span containing the new children
      const replacement: Element = {
        type: 'element',
        tagName: 'span',
        properties: {},
        children,
      }

      ;(parent as Element).children.splice(index, 1, replacement)
    })
  }
}

export default function MarkdownContent({ content, onClick, onTicketClick }: MarkdownContentProps) {
  return (
    <div
      className="prose-content cursor-text"
      onClick={onClick}
      style={{
        fontFamily: "'Literata Variable', Georgia, serif",
        fontSize: '18px',
        lineHeight: '1.75',
        color: '#262320',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeLinearTickets]}
        components={{
          h1: ({ children }) => (
            <h1 style={{ fontFamily: "'Literata Variable', Georgia, serif", fontWeight: 700, fontSize: '1.75em', marginBottom: '0.5em', marginTop: '1.5em', lineHeight: 1.25, color: '#262320' }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontFamily: "'Literata Variable', Georgia, serif", fontWeight: 600, fontSize: '1.375em', marginBottom: '0.4em', marginTop: '1.4em', lineHeight: 1.3, color: '#262320' }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontFamily: "'Literata Variable', Georgia, serif", fontWeight: 600, fontSize: '1.15em', marginBottom: '0.35em', marginTop: '1.25em', lineHeight: 1.35, color: '#262320' }}>{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 style={{ fontFamily: "'Literata Variable', Georgia, serif", fontWeight: 600, fontSize: '1em', marginBottom: '0.3em', marginTop: '1.1em', color: '#262320' }}>{children}</h4>
          ),
          p: ({ children }) => (
            <p style={{ marginBottom: '1em', marginTop: 0 }}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul style={{ paddingLeft: '1.5em', marginBottom: '1em', listStyleType: 'disc' }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ paddingLeft: '1.5em', marginBottom: '1em', listStyleType: 'decimal' }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ marginBottom: '0.25em' }}>{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote style={{
              borderLeft: '3px solid #3E5641',
              paddingLeft: '1em',
              marginLeft: 0,
              marginRight: 0,
              marginBottom: '1em',
              color: '#6B6760',
              fontStyle: 'italic',
            }}>{children}</blockquote>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              return (
                <code
                  className={className}
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
                    fontSize: '0.85em',
                  }}
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return (
              <code
                style={{
                  fontFamily: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
                  fontSize: '0.85em',
                  background: 'rgba(38,35,32,0.07)',
                  borderRadius: '3px',
                  padding: '0.1em 0.35em',
                }}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre style={{
              background: '#1e1c1a',
              borderRadius: '6px',
              padding: '1em 1.2em',
              overflowX: 'auto',
              marginBottom: '1em',
              fontSize: '0.85em',
              lineHeight: '1.55',
            }}>{children}</pre>
          ),
          a: ({ href, children, ...props }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ticketId = (props as any)['data-linear-ticket'] as string | undefined
            if (ticketId && onTicketClick) {
              return (
                <a
                  href="#"
                  data-linear-ticket={ticketId}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onTicketClick(ticketId)
                  }}
                  style={{
                    color: '#5E6AD2',
                    textDecoration: 'none',
                    fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
                    fontSize: '0.85em',
                    background: 'rgba(94,106,210,0.08)',
                    borderRadius: '3px',
                    padding: '0.05em 0.3em',
                    border: '1px solid rgba(94,106,210,0.18)',
                    cursor: 'pointer',
                  }}
                >
                  {children}
                </a>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#3E5641', textDecoration: 'underline', textDecorationColor: 'rgba(62,86,65,0.4)' }}
              >
                {children}
              </a>
            )
          },
          hr: () => (
            <hr style={{ border: 'none', borderTop: '1px solid rgba(38,35,32,0.12)', margin: '2em 0' }} />
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', marginBottom: '1em' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9em' }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{
              textAlign: 'left',
              padding: '0.4em 0.75em',
              borderBottom: '2px solid rgba(38,35,32,0.2)',
              fontWeight: 600,
              color: '#262320',
              whiteSpace: 'nowrap',
            }}>{children}</th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: '0.4em 0.75em',
              borderBottom: '1px solid rgba(38,35,32,0.1)',
              verticalAlign: 'top',
            }}>{children}</td>
          ),
          img: ({ src, alt }) => {
            if (!src) return null
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={alt || ''}
                style={{ maxWidth: '100%', borderRadius: '4px', margin: '0.5em 0' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )
          },
          input: ({ type, checked }) => {
            if (type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  style={{ marginRight: '0.4em', accentColor: '#3E5641' }}
                />
              )
            }
            return null
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
