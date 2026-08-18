import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { auroraVersionLabel } from '../../scripts/aurora-version.mjs'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '..', '..')
const omxWorktreeMarker = `${sep}.omx${sep}team${sep}`
const leaderRepoRoot = repoRoot.includes(omxWorktreeMarker)
  ? repoRoot.slice(0, repoRoot.indexOf(omxWorktreeMarker))
  : repoRoot
const webviewTarget = process.env.VITE_AURORA_WEBVIEW_TARGET?.trim()

export default defineConfig(({ command }) => ({
  plugins: [react()],
  clearScreen: false,
  define: {
    // Unified monorepo version (repo-root VERSION file); dev servers add a
    // branch-derived suffix. Read by @aurora/ui version helpers.
    __AURORA_VERSION_LABEL__: JSON.stringify(
      process.env.AURORA_VERSION_LABEL?.trim() || auroraVersionLabel({ dev: command === 'serve' })
    )
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    },
    fs: {
      allow: Array.from(new Set([repoRoot, leaderRepoRoot]))
    }
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm']
  },
  envPrefix: ['VITE_', 'AURORA_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: webviewTarget || undefined
  }
}))
