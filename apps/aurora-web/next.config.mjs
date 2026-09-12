import { auroraVersionLabel } from '../../scripts/aurora-version.mjs'

// Unified monorepo version injected at build time. Dev servers get a
// branch-derived label (e.g. "1.0.0-dev.my-branch"); production builds get
// the plain repo-root VERSION value. Read by @aurora/ui version helpers.
const auroraVersion =
  process.env.NEXT_PUBLIC_AURORA_VERSION_LABEL?.trim() ||
  auroraVersionLabel({ dev: process.env.NODE_ENV !== 'production' })

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Isolated `dev:ui:<preset>` processes use a unique distDir so they can
  // coexist with the shared debug server. Prefer one `pnpm dev:ui:debug`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Next's own bottom-left indicator uses the top layer and covers the "A" chip.
  devIndicators: false,
  transpilePackages: ['@aurora/ui'],
  env: {
    NEXT_PUBLIC_AURORA_VERSION_LABEL: auroraVersion,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp'
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin'
          }
        ]
      }
    ]
  }
}

export default nextConfig
