import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as sdk from '../src/index.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = resolve(packageRoot, 'package.json')

describe('generated contract package boundary', () => {
  it('publishes generated contracts and validation through stable subpaths', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

    expect(pkg.exports['./generated']).toEqual({
      types: './dist/generated/index.d.ts',
      import: './dist/generated/index.js',
      default: './dist/generated/index.js'
    })
    expect(pkg.exports['./validation']).toEqual({
      types: './dist/validation/index.d.ts',
      import: './dist/validation/index.js',
      default: './dist/validation/index.js'
    })
  })

  it('keeps the root namespace aliases wired to the same public contracts', () => {
    expect(sdk.generatedContracts.backendContractSchemas).toBeDefined()
    expect(sdk.validation.parseBoundary).toBeTypeOf('function')
    expect(sdk.validation.AuroraValidationError).toBeTypeOf('function')
  })

  it('points both public subpaths at emitted build artifacts', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const targets = [
      ...Object.values(pkg.exports['./generated']),
      ...Object.values(pkg.exports['./validation'])
    ] as string[]

    for (const target of targets) {
      expect(target.startsWith('./dist/')).toBe(true)
      expect(existsSync(resolve(packageRoot, target))).toBe(true)
    }
  })
})
