import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  buildAudit,
  buildGuardrailInventory,
  buildGuardrailReport,
  collectClassUsage,
  discoverSourceRoots,
  dynamicSiteCountRecords,
  extractClassSelectors,
  guardrailFailures,
  missingGeneratedFailures,
  splitClassTokens,
} from './audit-style-pipeline.mjs'

test('static class token splitting ignores structural group and peer markers', () => {
  assert.deepEqual(
    splitClassTokens('group peer group/trigger peer/item bg-amber-800 aui-shell'),
    ['bg-amber-800', 'aui-shell'],
  )
})

test('CSS selector extraction recognizes escaped generated utilities', () => {
  assert.deepEqual(
    [...extractClassSelectors('.bg-amber-800{color:#92400e}.group\\/trigger .aui-shell{}')].sort(),
    ['aui-shell', 'bg-amber-800'],
  )
})

test('static token occurrence counts are not capped by diagnostic locations', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/repeated.tsx', `
      export function Fixture() {
        return (
          <>
            ${Array.from({ length: 13 }, (_, index) => `<div className="aui-repeat" data-index="${index}" />`).join('\n')}
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    const record = usage.staticTokens.get('aui-repeat')
    assert.equal(record.count, 13)
    assert.equal(record.locations.length, 12)
  })
})

test('duplicate dynamic class sites keep multiplicity in the guardrail inventory', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/dynamic.tsx', `
      const cn = (...values: string[]) => values.join(' ')
      export function Fixture({ tone }: { tone: string }) {
        return (
          <>
            <div className={cn(\`aui-\${tone}\`)} />
            <div className={cn(\`aui-\${tone}\`)} />
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.dynamicSites.length, 2)
    assert.deepEqual(
      dynamicSiteCountRecords(usage.dynamicSites).map(({ count, reason }) => ({ count, reason })),
      [{ count: 2, reason: 'template-expression' }],
    )
  })
})

test('class combiner traversal counts each physical static occurrence once', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/static-combiner.tsx', `
      const cn = (...values: string[]) => values.join(' ')
      export function Fixture() {
        return (
          <>
            <div className={cn('aui-static')} />
            <div className={cn('aui-static')} />
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-static').count, 2)
    assert.equal(usage.staticTokens.get('aui-static').locations.length, 2)
  })
})

test('unmounted inline CSS does not satisfy a missing generated utility', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/unmounted-inline.tsx', `
      const css = \`.bg-amber-800 { color: #92400e; }\`
      export function Fixture() {
        return (
          <>
            <style>{css}</style>
            <div className="bg-amber-800" />
          </>
        )
      }
    `)
    const { report } = buildAudit({}, {
      repoRoot: root,
      files: [file],
      baselineCssText: '',
      generatedCssText: '',
    })
    assert.deepEqual(report.usedTokens.missingInGenerated.map(({ token }) => token), ['bg-amber-800'])
  })
})

test('the dev picker inline allowance is exact and provenance-bearing', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'apps/aurora-web/app/debug-ui-picker.tsx', `
      const AURORA_DEBUG_UI_RUNTIME_CSS = \`.aurora-debug-ui-badge { position: relative; }\`
      export function Fixture() {
        return (
          <div className="aurora-debug-ui-badge bg-amber-800">
            <style id="aurora-debug-ui-runtime-css">{AURORA_DEBUG_UI_RUNTIME_CSS}</style>
          </div>
        )
      }
    `)
    const { report } = buildAudit({}, {
      repoRoot: root,
      files: [file],
      baselineCssText: '',
      generatedCssText: '',
    })
    assert.deepEqual(report.usedTokens.missingInGenerated.map(({ token }) => token), ['bg-amber-800'])
    assert.equal(report.selectorInventory.allowedInlineOnly[0].locations[0].provenance.file, 'apps/aurora-web/app/debug-ui-picker.tsx')
  })
})

test('the dev picker inline allowance does not hide other-file usage of the same class', () => {
  withFixture((root) => {
    const picker = writeFixture(root, 'apps/aurora-web/app/debug-ui-picker.tsx', `
      const AURORA_DEBUG_UI_RUNTIME_CSS = \`.aurora-debug-ui-badge { position: relative; }\`
      export function DebugPickerFixture() {
        return (
          <div className="aurora-debug-ui-badge">
            <style id="aurora-debug-ui-runtime-css">{AURORA_DEBUG_UI_RUNTIME_CSS}</style>
          </div>
        )
      }
    `)
    const other = writeFixture(root, 'packages/aurora-ui/src/other.tsx', `
      export function OtherFixture() {
        return <div className="aurora-debug-ui-badge" />
      }
    `)
    const { report } = buildAudit({}, {
      repoRoot: root,
      files: [picker, other],
      baselineCssText: '',
      generatedCssText: '',
    })
    assert.deepEqual(report.usedTokens.missingInGenerated.map(({ token }) => token), ['aurora-debug-ui-badge'])
    assert.equal(report.usedTokens.missingInGenerated[0].occurrenceCount, 1)
    assert.equal(report.usedTokens.missingInGenerated[0].locations[0].file, 'packages/aurora-ui/src/other.tsx')
  })
})

test('source discovery includes new app and package production roots outside the original Tailwind roots', () => {
  withFixture((root) => {
    writeFixture(root, 'apps/new-surface/src/app.tsx', 'export const value = <div className="aui-app" />')
    writeFixture(root, 'packages/new-package/src/index.tsx', 'export const value = <div className="aui-package" />')
    assert.deepEqual(
      discoverSourceRoots(root),
      ['apps/new-surface/src', 'packages/new-package/src'],
    )
  })
})

test('a new utility without regenerated CSS fails with a readable message', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/no-rebuild.tsx', `
      export function Fixture() {
        return <div className="bg-amber-800" />
      }
    `)
    const { report } = buildAudit({}, {
      repoRoot: root,
      files: [file],
      baselineCssText: '',
      generatedCssText: '',
    })
    assert.equal(missingGeneratedFailures(report.usedTokens.missingInGenerated).length, 1)
    assert.match(
      missingGeneratedFailures(report.usedTokens.missingInGenerated)[0],
      /^missing generated class: bg-amber-800 at packages\/aurora-ui\/src\/no-rebuild\.tsx:\d+:\d+$/u,
    )
  })
})

test('aui occurrence guardrails allow decreases and reject increases', () => {
  withFixture((root) => {
    const report = { metadata: { generated: { cssPath: 'styles.css' }, sourceRoots: [] }, summary: {} }
    writeFixture(root, 'packages/aurora-ui/scripts/style-guardrail-inventory.fixture.json', JSON.stringify({
      version: 2,
      summary: {},
      auiStaticTokenCounts: { 'aui-shell': 2 },
      auiStaticTokens: ['aui-shell'],
      auiGeneratedSelectors: [],
      dynamicClassSiteCounts: [],
    }))
    const decreasing = buildGuardrailReport(report, {
      summary: {},
      auiStaticTokenCounts: { 'aui-shell': 1 },
      auiStaticTokens: ['aui-shell'],
      auiGeneratedSelectors: [],
      dynamicClassSiteCounts: [],
    }, 'packages/aurora-ui/scripts/style-guardrail-inventory.fixture.json', root)
    assert.deepEqual(guardrailFailures(decreasing), [])

    const increasing = buildGuardrailReport(report, {
      summary: {},
      auiStaticTokenCounts: { 'aui-shell': 3 },
      auiStaticTokens: ['aui-shell'],
      auiGeneratedSelectors: [],
      dynamicClassSiteCounts: [],
    }, 'packages/aurora-ui/scripts/style-guardrail-inventory.fixture.json', root)
    assert.deepEqual(
      guardrailFailures(increasing),
      ['aui-* static class usage increased: aui-shell 2 -> 3'],
    )
  })
})

test('new repeated dynamic compositions are not unbounded exemptions', () => {
  withFixture((root) => {
    const report = { metadata: { generated: { cssPath: 'styles.css' }, sourceRoots: [] }, summary: {} }
    const baseline = writeFixture(root, 'packages/aurora-ui/scripts/dynamic-inventory.fixture.json', JSON.stringify({
      version: 2,
      summary: {},
      auiStaticTokenCounts: {},
      auiStaticTokens: [],
      auiGeneratedSelectors: [],
      dynamicClassSiteCounts: [
        {
          key: ['packages/aurora-ui/src/dynamic.tsx', 'jsx-className', 'template-expression', 'aui-${tone}', 'className={`aui-${tone}`}'].join('\u0000'),
          count: 1,
        },
      ],
    }))
    const current = {
      summary: {},
      auiStaticTokenCounts: {},
      auiStaticTokens: [],
      auiGeneratedSelectors: [],
      dynamicClassSiteCounts: [
        {
          key: ['packages/aurora-ui/src/dynamic.tsx', 'jsx-className', 'template-expression', 'aui-${tone}', 'className={`aui-${tone}`}'].join('\u0000'),
          count: 2,
          file: 'packages/aurora-ui/src/dynamic.tsx',
          reason: 'template-expression',
          pattern: 'aui-${tone}',
          firstLocation: { file: 'packages/aurora-ui/src/dynamic.tsx', line: 4, column: 12 },
        },
      ],
    }
    assert.deepEqual(
      guardrailFailures(buildGuardrailReport(report, current, baseline, '/')),
      ['unexpected dynamic class site count: packages/aurora-ui/src/dynamic.tsx:4:12 template-expression aui-${tone} 1 -> 2'],
    )
  })
})

test('inventory records use occurrence counts instead of sampled locations', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/repeated-inventory.tsx', `
      export function Fixture() {
        return (
          <>
            ${Array.from({ length: 13 }, () => '<div className="aui-repeat" />').join('\n')}
          </>
        )
      }
    `)
    const { report, inventory } = buildAudit({}, {
      repoRoot: root,
      files: [file],
      baselineCssText: '',
      generatedCssText: '.aui-repeat{}',
    })
    const usage = collectClassUsage([file], root)
    const generated = extractClassSelectors('.aui-repeat{}')
    const rebuilt = buildGuardrailInventory(report, usage, generated, new Map())
    assert.equal(inventory.staticTokenCounts['aui-repeat'], 13)
    assert.equal(rebuilt.auiStaticTokenCounts['aui-repeat'], 13)
  })
})


test('file-local constant class names are checked for missing generated CSS', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/constant-missing.tsx', `
      const ROUTE_SHEET_CLASS = 'bg-amber-800 aui-constant'
      export function Fixture() {
        return <section className={ROUTE_SHEET_CLASS} />
      }
    `)
    const { report } = buildAudit({}, {
      repoRoot: root,
      files: [file],
      baselineCssText: '',
      generatedCssText: '.aui-constant{}',
    })
    assert.deepEqual(report.usedTokens.missingInGenerated.map(({ token }) => token), ['bg-amber-800'])
    assert.equal(report.dynamicClassSites.length, 0)
  })
})

test('constant aliases templates and bounded branches enumerate static class tokens', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/constant-branches.tsx', `
      const cn = (...values: Array<string | false>) => values.filter(Boolean).join(' ')
      const BASE = 'aui-base'
      const ALIAS = BASE
      const TEMPLATE = \`${'${ALIAS}'} text-[0.83rem]\`
      const ASSISTANT = 'in-[.aui-assistant]:gap-2'
      export function Fixture({ ready }: { ready: boolean }) {
        return <div className={cn(TEMPLATE, ready ? ASSISTANT : 'aui-idle', ready && 'aui-ready')} />
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.deepEqual([...usage.staticTokens.keys()].sort(), [
      'aui-base',
      'aui-idle',
      'aui-ready',
      'in-[.aui-assistant]:gap-2',
      'text-[0.83rem]',
    ])
    assert.equal(usage.dynamicSites.length, 0)
  })
})

test('mutable imported unknown shadowed and cyclic class values stay unresolved', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/unresolved-constants.tsx', `
      import { importedClass } from './other'
      const SHADOWED = 'aui-global'
      const CYCLE_A = CYCLE_A
      let mutableClass = 'aui-mutable'
      export const outside = <div className={SHADOWED} />
      export function Fixture({ SHADOWED, unknownClass, ready }: { SHADOWED: string; unknownClass: string; ready: boolean }) {
        return (
          <>
            <div className={SHADOWED} />
            <div className={importedClass} />
            <div className={mutableClass} />
            <div className={unknownClass} />
            <div className={CYCLE_A} />
            <div className={ready && importedClass} />
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-global').count, 1)
    assert.equal(usage.staticTokens.has('aui-mutable'), false)
    assert.equal(usage.dynamicSites.length, 6)
    assert.deepEqual(
      dynamicSiteCountRecords(usage.dynamicSites).map(({ count, reason }) => ({ count, reason })),
      Array.from({ length: 6 }, () => ({ count: 1, reason: 'unresolved-expression' })),
    )
  })
})

test('constant resolution preserves physical occurrence counts without duplicate traversal', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/constant-occurrences.tsx', `
      const cn = (...values: string[]) => values.join(' ')
      const TOKEN = 'aui-repeat'
      export function Fixture() {
        return (
          <>
            <div className={cn(TOKEN, TOKEN)} />
            <div className={\`${'${TOKEN}'} ${'${TOKEN}'}\`} />
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-repeat').count, 4)
    assert.equal(usage.staticTokens.get('aui-repeat').locations.length, 3)
    assert.equal(usage.dynamicSites.length, 0)
  })
})


test('nearest lexical shadows stay unresolved before destructured and later local declarations', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/shadowed-locals.tsx', `
      const CLASS_NAME = 'aui-outer'
      export const outside = <div className={CLASS_NAME} />
      export function DestructuredParam({ CLASS_NAME }: { CLASS_NAME: string }) {
        return <div className={CLASS_NAME} />
      }
      export function DestructuredConst(source: { CLASS_NAME: string }) {
        const before = <div className={CLASS_NAME} />
        const { CLASS_NAME } = source
        return before
      }
      export function LaterVar() {
        const before = <div className={CLASS_NAME} />
        var CLASS_NAME = getClassName()
        return before
      }
      export function LaterConst() {
        const before = <div className={CLASS_NAME} />
        const CLASS_NAME = 'aui-inner'
        return before
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-outer').count, 1)
    assert.equal(usage.staticTokens.has('aui-inner'), false)
    assert.equal(usage.dynamicSites.length, 4)
  })
})

test('switch and loop lexical shadows do not fall through to outer constants', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/scope-shadows.tsx', `
      const TOKEN = 'aui-outer'
      export const outside = <div className={TOKEN} />
      export function SwitchFixture(kind: string, source: { TOKEN: string }) {
        switch (kind) {
          case 'one': {
            const before = <div className={TOKEN} />
            const { TOKEN } = source
            return before
          }
          default:
            return <div className={TOKEN} />
        }
      }
      export function LoopFixture(values: string[]) {
        for (let index = 0; index < values.length; index += 1) {
          const before = <div className={TOKEN} />
          let TOKEN = values[index]
          return before
        }
        return null
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-outer').count, 2)
    assert.equal(usage.dynamicSites.length, 2)
  })
})

test('constant resolution has an output expansion budget and preserves dynamic evidence', () => {
  withFixture((root) => {
    const chain = Array.from({ length: 16 }, (_, index) => {
      if (index === 0) return "const C0 = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'"
      return `const C${index} = C${index - 1} + C${index - 1}`
    }).join('\n')
    const file = writeFixture(root, 'packages/aurora-ui/src/expansion-budget.tsx', `
      ${chain}
      export function Fixture() {
        return <div className={C15} />
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.size, 0)
    assert.equal(usage.dynamicSites.length, 1)
    assert.equal(usage.dynamicSites[0].reason, 'unresolved-expression')
  })
})


test('destructured const class bindings remain unresolved sentinels', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/destructured-const.tsx', `
      const STATIC_OBJECT = { CLASS_NAME: 'aui-object' }
      const [ARRAY_CLASS] = 'aui-card'
      const { CLASS_NAME } = STATIC_OBJECT
      const { nested: { NESTED_CLASS } } = { nested: { NESTED_CLASS: 'aui-nested' } }
      export function Fixture() {
        return (
          <>
            <div className={ARRAY_CLASS} />
            <div className={CLASS_NAME} />
            <div className={NESTED_CLASS} />
          </>
        )
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.has('aui-card'), false)
    assert.equal(usage.staticTokens.has('aui-object'), false)
    assert.equal(usage.staticTokens.has('aui-nested'), false)
    assert.equal(usage.dynamicSites.length, 3)
  })
})

test('unbraced switch cases share lexical shadows across cases', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/switch-caseblock-shadow.tsx', `
      const SWITCH_CLASS = 'aui-switch-outer'
      export const outside = <div className={SWITCH_CLASS} />
      export function Fixture(kind: string) {
        switch (kind) {
          case 'read':
            return <div className={SWITCH_CLASS} />
          case 'write':
            const SWITCH_CLASS = getClassName()
            return null
          default:
            return null
        }
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-switch-outer').count, 1)
    assert.equal(usage.dynamicSites.length, 1)
  })
})

test('catch binding shadows only inside catch block and does not leak after it', () => {
  withFixture((root) => {
    const file = writeFixture(root, 'packages/aurora-ui/src/catch-shadow.tsx', `
      const CLASS_NAME = 'aui-catch-outer'
      export function Fixture() {
        try {
          throw new Error('x')
        } catch (CLASS_NAME) {
          const inside = <div className={CLASS_NAME} />
          void inside
        }
        return <div className={CLASS_NAME} />
      }
    `)
    const usage = collectClassUsage([file], root)
    assert.equal(usage.staticTokens.get('aui-catch-outer').count, 1)
    assert.equal(usage.dynamicSites.length, 1)
  })
})

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'aurora-style-guardrail-'))
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFixture(root, path, contents) {
  const absolutePath = join(root, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `${contents.trim()}\n`)
  return absolutePath
}
