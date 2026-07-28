import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { handleBrowserSqliteWorkerMessage, type BrowserSqliteWorkerResponse } from './browser-sqlite-worker.js'

describe('browser sqlite worker protocol guardrails', () => {
  it('redacts unknown commands and oversized messages without exposing SQL', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    await handleBrowserSqliteWorkerMessage(
      { id: 'unknown-1', command: 'rawSql', sql: 'SELECT bearer FROM secrets' },
      (response) => responses.push(response)
    )

    expect(responses[0]).toMatchObject({
      id: 'unknown-1',
      result: {
        ok: false,
        error: {
          code: 'invalid_record',
          metadata: { reason: 'rawSql' }
        }
      }
    })
    expect(JSON.stringify(responses)).not.toContain('SELECT bearer')

    const oversized: BrowserSqliteWorkerResponse[] = []
    await expect(handleBrowserSqliteWorkerMessage(
      { id: 'large-1', command: 'status', payload: 'A'.repeat(3 * 1024 * 1024) },
      (response) => oversized.push(response)
    )).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: { reason: 'message_too_large' }
    })
  })

  it('acknowledges cancellation requests by correlation id', async () => {
    const responses: BrowserSqliteWorkerResponse[] = []
    await handleBrowserSqliteWorkerMessage(
      { id: 'cancel-1', command: 'cancel', targetId: 'open-1' },
      (response) => responses.push(response)
    )
    expect(responses).toEqual([{
      id: 'cancel-1',
      result: { ok: true, value: { cancelled: true } }
    }])
  })

  it('keeps sqlite wasm imports private to approved local-data adapters', () => {
    const root = process.cwd()
    const offenders: string[] = []
    for (const file of walk(join(root, 'src'))) {
      const rel = relative(root, file)
      const source = readFileSync(file, 'utf8')
      const importsSqlite = source.includes('@sqlite.org/sqlite-wasm') || source.includes('installOpfsSAHPoolVfs')
      if (!importsSqlite) continue
      if (
        rel !== 'src/local-data/browser-sqlite-worker.ts'
        && rel !== 'src/local-data/browser-sqlite-worker-client.ts'
      ) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})

function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...walk(path))
    } else if (/\.(?:ts|tsx)$/u.test(entry) && !/\.test\.(?:ts|tsx)$/u.test(entry)) {
      files.push(path)
    }
  }
  return files
}
