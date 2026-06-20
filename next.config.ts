import type { NextConfig } from 'next'

// Static export is only needed for `tauri build` (production).
// In `tauri dev` mode Next.js runs as a dev server (localhost:3002),
// so output:'export' is not only unnecessary but can cause dev-server
// quirks. Only enable it for production builds.
//
// API routes live in pages/api/ (pages router) which is automatically
// excluded from output: 'export'. They run via the Next.js dev server
// in `tauri dev` mode.
const isProd = process.env.NODE_ENV === 'production'

const nextConfig: NextConfig = {
  ...(isProd ? { output: 'export' } : {}),
  images: { unoptimized: true },
  trailingSlash: true,
  devIndicators: false,
}

export default nextConfig
