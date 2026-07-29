import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserStorageSteps, runBrowserStorageGate } from './run_browser_storage_gate.mjs'

test('browser storage gate builds once before Playwright suites', async () => {
  const observed = []
  const result = await runBrowserStorageGate({
    runStep: async (step) => {
      observed.push(step)
      return { status: 0 }
    },
    log: () => {},
  })

  assert.equal(result.status, 0)
  assert.deepEqual(
    observed.map((step) => step.name),
    [
      'build @aurora/ui',
      'browser persistence matrix',
      'non-extractable envelope-key smoke',
      'IndexedDB to Worker OPFS transfer smoke',
    ],
  )
  assert.equal(observed.filter((step) => step.args.includes('build')).length, 1)
  assert.equal(observed.slice(1).every((step) => step.args.includes('playwright')), true)
})

test('browser storage gate stops and propagates the first nonzero exit', async () => {
  const observed = []
  const result = await runBrowserStorageGate({
    steps: browserStorageSteps,
    runStep: async (step) => {
      observed.push(step.name)
      return step.name === 'browser persistence matrix' ? { status: 37 } : { status: 0 }
    },
    log: () => {},
  })

  assert.equal(result.status, 37)
  assert.deepEqual(observed, ['build @aurora/ui', 'browser persistence matrix'])
})

test('browser storage gate returns child signals to the caller', async () => {
  const result = await runBrowserStorageGate({
    runStep: async () => ({ status: 1, signal: 'SIGTERM' }),
    log: () => {},
  })

  assert.deepEqual(result, { status: 1, signal: 'SIGTERM' })
})
