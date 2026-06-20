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
      <body style={{ margin: 0, padding: 0, height: '100%' }}>{children}</body>
    </html>
  )
}
