import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ROOT = resolve(APP_ROOT, '../..')
const WEB_ROOT = resolve(WORKSPACE_ROOT, 'apps/aurora-web')
const STANDALONE_ROOT = resolve(WEB_ROOT, '.next/standalone/apps/aurora-web')
const PLAYWRIGHT_CONFIG = resolve(
  WORKSPACE_ROOT,
  'tests/e2e/android_three_node/playwright.config.ts',
)
const DEFAULT_READY_TIMEOUT_MS = 120_000

export function parseEnvironmentFile(source) {
  return Object.fromEntries(
    String(source)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=')
        const key = line.slice(0, separator).trim()
        let value = line.slice(separator + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        return [key, value]
      }),
  )
}

export function resolveThreeNodeConfiguration(environment = process.env) {
  const fileEnvironment = environment.AURORA_THREE_NODE_ENV_FILE
    ? parseEnvironmentFile(readFileSync(resolve(environment.AURORA_THREE_NODE_ENV_FILE), 'utf8'))
    : {}
  const gatewayUrl = requiredUrl(
    environment.AURORA_THREE_NODE_GATEWAY_URL,
    'AURORA_THREE_NODE_GATEWAY_URL',
    ['http:', 'https:'],
  )
  const brokerUrl = requiredUrl(
    environment.AURORA_THREE_NODE_BROKER_URL,
    'AURORA_THREE_NODE_BROKER_URL',
    ['ws:', 'wss:'],
  )
  const gatewayApiKey = String(
    environment.AURORA_THREE_NODE_GATEWAY_API_KEY
      ?? fileEnvironment.AURORA_GATEWAY_API_KEYS
      ?? '',
  ).split(',')[0].trim()
  if (!gatewayApiKey) {
    throw new Error(
      'Set AURORA_THREE_NODE_GATEWAY_API_KEY or provide AURORA_THREE_NODE_ENV_FILE containing AURORA_GATEWAY_API_KEYS.',
    )
  }
  const baseUrl = environment.AURORA_THREE_NODE_BASE_URL
    ? requiredUrl(
      environment.AURORA_THREE_NODE_BASE_URL,
      'AURORA_THREE_NODE_BASE_URL',
      ['http:', 'https:'],
    ).toString().replace(/\/$/u, '')
    : ''
  return {
    baseUrl,
    brokerUrl: brokerUrl.toString(),
    gatewayApiKey,
    gatewayUrl: gatewayUrl.toString().replace(/\/$/u, ''),
  }
}

function requiredUrl(value, name, protocols) {
  if (!value) throw new Error(`${name} is required.`)
  const parsed = new URL(value)
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}.`)
  }
  return parsed
}

function commandRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? WORKSPACE_ROOT,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}.`)
  }
}

async function allocateLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise())
  })
  if (!port) throw new Error('Could not allocate a loopback port for the hosted Aurora UI.')
  return port
}

async function waitForHttp(url, child, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Hosted Aurora UI exited before becoming ready (status ${child.exitCode}).`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
    } catch {
      // The production UI can take a moment to bind after the process starts.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error(`Timed out waiting for the hosted Aurora UI at ${url}.`)
}

function buildHostedUi() {
  commandRun('pnpm', ['--filter', '@aurora/voice-web', 'build'])
  commandRun('pnpm', ['--filter', '@aurora/client', 'build'])
  commandRun('pnpm', ['--filter', '@aurora/web', 'build'], {
    env: {
      ...process.env,
      NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: '1',
    },
  })
  if (!existsSync(resolve(STANDALONE_ROOT, 'server.js'))) {
    throw new Error('The Aurora web production build did not produce its standalone server.')
  }
  mkdirSync(resolve(STANDALONE_ROOT, '.next/static'), { recursive: true })
  mkdirSync(resolve(STANDALONE_ROOT, 'public'), { recursive: true })
  cpSync(resolve(WEB_ROOT, '.next/static'), resolve(STANDALONE_ROOT, '.next/static'), {
    recursive: true,
  })
  cpSync(resolve(WEB_ROOT, 'public'), resolve(STANDALONE_ROOT, 'public'), {
    recursive: true,
  })
}

async function run() {
  const configuration = resolveThreeNodeConfiguration()
  let webProcess
  let baseUrl = configuration.baseUrl
  try {
    if (!baseUrl) {
      if (process.env.AURORA_THREE_NODE_SKIP_WEB_BUILD !== '1') buildHostedUi()
      if (!existsSync(resolve(STANDALONE_ROOT, 'server.js'))) {
        throw new Error('No hosted Aurora UI build is available.')
      }
      const port = await allocateLoopbackPort()
      baseUrl = `http://127.0.0.1:${port}`
      webProcess = spawn('node', [resolve(STANDALONE_ROOT, 'server.js')], {
        cwd: STANDALONE_ROOT,
        env: {
          ...process.env,
          HOSTNAME: '127.0.0.1',
          PORT: String(port),
          NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: '1',
        },
        stdio: 'inherit',
      })
      await waitForHttp(baseUrl, webProcess)
    }

    commandRun(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', PLAYWRIGHT_CONFIG, '--project', 'chromium'],
      {
        env: {
          ...process.env,
          AURORA_THREE_NODE_BASE_URL: baseUrl,
          AURORA_THREE_NODE_BROKER_URL: configuration.brokerUrl,
          AURORA_THREE_NODE_GATEWAY_API_KEY: configuration.gatewayApiKey,
          AURORA_THREE_NODE_GATEWAY_URL: configuration.gatewayUrl,
        },
      },
    )
  } finally {
    if (webProcess && webProcess.exitCode == null) {
      webProcess.kill('SIGTERM')
      await Promise.race([
        new Promise((resolvePromise) => webProcess.once('exit', resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
      ])
      if (webProcess.exitCode == null) webProcess.kill('SIGKILL')
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
