import type { NextConfig } from 'next'

// Static export is only needed for `tauri build` (production).
// In `tauri dev` mode Next.js runs as a dev server (localhost:3002),
// so output:'export' is not only unnecessary but can cause dev-server
// quirks. Only enable it for production builds.
//
// There are no Next.js API routes: search and file creation are handled by
// Rust Tauri commands (`invoke('search')` / `invoke('create_file')`), so the
// static export has no server-side dependencies to exclude.
const isProd = process.env.NODE_ENV === 'production'

const nextConfig: NextConfig = {
  ...(isProd ? { output: 'export' } : {}),
  images: { unoptimized: true },
  trailingSlash: true,
  devIndicators: false,
}

export default nextConfig
