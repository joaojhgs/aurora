import { build } from 'esbuild'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const appRoot = resolve(fixtureDir, '../..')
const repoRoot = resolve(process.env.AURORA_UI_VISUAL_REPO_ROOT ?? resolve(appRoot, '../..'))
const reportRoot = resolve(process.env.AURORA_UI_VISUAL_REPORT_ROOT ?? join(appRoot, 'test-results/ui-visual'))
const outDir = join(reportRoot, 'component-harness')
const outFile = join(outDir, 'component-harness.js')
const portArgIndex = process.argv.indexOf('--port')
const port = Number((portArgIndex >= 0 ? process.argv[portArgIndex + 1] : undefined) ?? process.env.PORT ?? '3429')

await mkdir(outDir, { recursive: true })
await build({
  entryPoints: [join(fixtureDir, 'component-harness.tsx')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  conditions: ['import', 'browser'],
  logLevel: 'silent',
  sourcemap: 'inline',
})

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/' || url.pathname === '/component-harness') {
      const html = await readFile(join(fixtureDir, 'component-harness.html'), 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }

    if (url.pathname === '/__aurora-ui-visual/component-harness.js') {
      streamFile(outFile, response)
      return
    }

    const candidate = safeRepoPath(url.pathname)
    if (!candidate || !existsSync(candidate) || !(await stat(candidate)).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    streamFile(candidate, response)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : 'component harness error')
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Aurora component harness listening on http://127.0.0.1:${port}\n`)
})

function safeRepoPath(pathname) {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '')
  const normalized = normalize(decoded)
  if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`)) return null
  const candidate = resolve(repoRoot, normalized)
  return candidate.startsWith(repoRoot + sep) ? candidate : null
}

function streamFile(file, response) {
  response.writeHead(200, { 'content-type': mimeTypes.get(extname(file)) ?? 'application/octet-stream' })
  createReadStream(file).pipe(response)
}
