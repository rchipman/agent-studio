import type { Metadata } from 'next'
import '@fontsource-variable/literata'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agent Studio',
  description: 'Local markdown viewer and editor for ~/Projects',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" style={{ height: '100%' }}>
      <head>
        {/* Apply the saved theme before first paint to avoid a light flash
            (TIN-1673). Mirrors lib/theme.ts; runs synchronously in <head>. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var k='agent-studio-theme';var v=localStorage.getItem(k);var p=(v==='light'||v==='dark'||v==='system')?v:'system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();",
          }}
        />
      </head>
      <body style={{ margin: 0, padding: 0, height: '100%' }}>{children}</body>
    </html>
  )
}
