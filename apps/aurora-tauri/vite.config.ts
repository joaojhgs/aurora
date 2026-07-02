import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '..', '..')
const omxWorktreeMarker = `${sep}.omx${sep}team${sep}`
const leaderRepoRoot = repoRoot.includes(omxWorktreeMarker)
  ? repoRoot.slice(0, repoRoot.indexOf(omxWorktreeMarker))
  : repoRoot

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    fs: {
      allow: Array.from(new Set([repoRoot, leaderRepoRoot]))
    }
  },
  envPrefix: ['VITE_', 'AURORA_'],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
