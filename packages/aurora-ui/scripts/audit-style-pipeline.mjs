#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
const defaultBaselineRef = 'd97b83a7'
const defaultCssPath = 'packages/aurora-ui/src/styles.css'
const diagnosticLocationLimit = 12
const constantResolutionDepthLimit = 64
const constantResolutionStepLimit = 512
const constantResolutionOutputLimit = 8192
const classCombinerNames = new Set(['cn', 'clsx', 'cva', 'cx'])
const ignoredDirs = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
  'tests',
  'tmp',
  '__snapshots__',
  '__tests__',
])
const ignoredFilePatterns = [
  /\.test\.[cm]?[jt]sx?$/u,
  /\.spec\.[cm]?[jt]sx?$/u,
  /\.d\.ts$/u,
]
const devPickerRuntimeCss = {
  file: 'apps/aurora-web/app/debug-ui-picker.tsx',
  styleId: 'aurora-debug-ui-runtime-css',
  expression: 'AURORA_DEBUG_UI_RUNTIME_CSS',
  selectors: [
    'aurora-debug-ui-host',
    'aurora-debug-ui-badge',
    'aurora-debug-ui-panel',
    'aurora-debug-ui-panel-title',
    'aurora-debug-ui-fields',
    'aurora-debug-ui-field',
    'aurora-debug-viewport-host',
    'aurora-debug-viewport-backdrop',
    'aurora-debug-viewport-frame',
    'aurora-debug-viewport-screen',
  ],
}

function parseArgs(argv) {
  const args = {
    baselineRef: defaultBaselineRef,
    generatedCss: defaultCssPath,
    baselineCss: defaultCssPath,
    out: null,
    sourceRoots: [],
    guardrailInventory: null,
    writeGuardrailInventory: null,
    failOnMissingGenerated: false,
    failOnGuardrail: false,
    pretty: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--baseline-ref') args.baselineRef = requiredValue(argv, ++index, arg)
    else if (arg === '--baseline-css') args.baselineCss = requiredValue(argv, ++index, arg)
    else if (arg === '--generated-css') args.generatedCss = requiredValue(argv, ++index, arg)
    else if (arg === '--source-root') args.sourceRoots.push(requiredValue(argv, ++index, arg))
    else if (arg === '--out') args.out = requiredValue(argv, ++index, arg)
    else if (arg === '--guardrail-inventory') args.guardrailInventory = requiredValue(argv, ++index, arg)
    else if (arg === '--write-guardrail-inventory') args.writeGuardrailInventory = requiredValue(argv, ++index, arg)
    else if (arg === '--fail-on-missing-generated') args.failOnMissingGenerated = true
    else if (arg === '--fail-on-guardrail') args.failOnGuardrail = true
    else if (arg === '--compact') args.pretty = false
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function printHelp() {
  console.log(`Usage:
  node packages/aurora-ui/scripts/audit-style-pipeline.mjs --out .omx/artifacts/per-279/style-pipeline-audit.json

Options:
  --baseline-ref <ref>               Git ref for the frozen CSS artifact. Default: ${defaultBaselineRef}
  --baseline-css <path>              CSS path inside the baseline ref. Default: ${defaultCssPath}
  --generated-css <path>             Generated CSS path to inspect. Default: ${defaultCssPath}
  --source-root <path>               Production source root to scan. Repeatable. Defaults to apps/*/{app,src} and packages/*/src.
  --out <path>                       Write JSON artifact to this path. Defaults to stdout.
  --guardrail-inventory <path>       Compare current usage against a frozen guardrail inventory.
  --write-guardrail-inventory <path> Write a guardrail inventory from the current generated CSS and sources.
  --fail-on-missing-generated        Exit non-zero when static class tokens are not generated or explicitly allowed.
  --fail-on-guardrail                Exit non-zero when guardrail inventory comparisons fail.
  --compact                          Emit compact JSON.
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { report, failures, inventory } = buildAudit(args)
  if (args.writeGuardrailInventory) writeJsonFile(args.writeGuardrailInventory, inventory, args.pretty)
  if (args.out) writeJsonFile(args.out, report, args.pretty)
  else process.stdout.write(`${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exitCode = 1
  }
}

function buildAudit(args = {}, options = {}) {
  const root = options.repoRoot ?? repoRoot
  const sourceRoots = args.sourceRoots?.length
    ? args.sourceRoots
    : discoverSourceRoots(root)
  const baselineCss = options.baselineCssText ?? gitShow(`${args.baselineRef ?? defaultBaselineRef}:${args.baselineCss ?? defaultCssPath}`, root)
  const generatedPath = resolve(root, args.generatedCss ?? defaultCssPath)
  const generatedCss = options.generatedCssText ?? readFileSync(generatedPath, 'utf8')
  const files = options.files ?? sourceRoots.flatMap((sourceRoot) => collectSourceFiles(resolve(root, sourceRoot)))
  const usage = collectClassUsage(files, root)
  const allowedInlineSelectors = collectAllowedInlineSelectors(files, root)
  const baselineSelectors = extractClassSelectors(baselineCss)
  const generatedSelectors = extractClassSelectors(generatedCss)
  const usedTokens = new Set([...usage.staticTokens.keys()])
  const missingInBaseline = sorted([...usedTokens].filter((token) => !baselineSelectors.has(token)))
  const missingInGenerated = sorted([...usedTokens].filter((token) => {
    return !isTokenSatisfiedByGeneratedOrAllowed(token, usage.staticTokens.get(token), generatedSelectors, allowedInlineSelectors)
  }))
  const report = {
    metadata: {
      generatedAt: new Date().toISOString(),
      repoRoot: root,
      baseline: {
        ref: args.baselineRef ?? defaultBaselineRef,
        cssPath: args.baselineCss ?? defaultCssPath,
      },
      generated: {
        cssPath: relative(root, generatedPath),
      },
      sourceRoots,
      parser: 'typescript',
      phase: 'PER-279 Phase 3 CSS guardrail audit',
      diagnosticLocationLimit,
    },
    summary: {
      filesScanned: files.length,
      staticClassTokensUsed: usedTokens.size,
      staticClassTokenOccurrences: countTokenOccurrences(usage.staticTokens),
      auiStaticClassTokensUsed: [...usedTokens].filter((token) => token.startsWith('aui-')).length,
      auiStaticClassTokenOccurrences: countTokenOccurrences(usage.staticTokens, (token) => token.startsWith('aui-')),
      dynamicClassSites: usage.dynamicSites.length,
      baselineSelectorCount: baselineSelectors.size,
      generatedSelectorCount: generatedSelectors.size,
      allowedInlineSelectorCount: allowedInlineSelectors.size,
      usedMissingInBaseline: missingInBaseline.length,
      usedMissingInGenerated: missingInGenerated.length,
      usedRestoredByGenerated: missingInBaseline.filter((token) => {
        return isTokenSatisfiedByGeneratedOrAllowed(token, usage.staticTokens.get(token), generatedSelectors, allowedInlineSelectors)
      }).length,
      usedRegressedFromBaseline: missingInGenerated.filter((token) => baselineSelectors.has(token)).length,
      themeVariableChanges: compareVariables(
        extractCustomPropertiesFromThemeLayer(baselineCss),
        extractCustomPropertiesFromThemeLayer(generatedCss),
      ).changed.length,
      rootVariableChanges: compareVariables(
        extractStandaloneRootVariables(baselineCss),
        extractStandaloneRootVariables(generatedCss),
      ).changed.length,
    },
    usedTokens: {
      missingInBaseline: withTokenRecords(missingInBaseline, usage.staticTokens),
      missingInGenerated: withMissingGeneratedTokenRecords(
        missingInGenerated,
        usage.staticTokens,
        generatedSelectors,
        allowedInlineSelectors,
      ),
      restoredByGenerated: withTokenRecords(
        missingInBaseline.filter((token) => {
          return isTokenSatisfiedByGeneratedOrAllowed(token, usage.staticTokens.get(token), generatedSelectors, allowedInlineSelectors)
        }),
        usage.staticTokens,
      ),
      regressedFromBaseline: withTokenRecords(
        missingInGenerated.filter((token) => baselineSelectors.has(token)),
        usage.staticTokens,
      ),
      stillMissing: withTokenRecords(
        missingInGenerated.filter((token) => !baselineSelectors.has(token)),
        usage.staticTokens,
      ),
    },
    selectorInventory: {
      baselineOnly: sorted([...baselineSelectors].filter((selector) => !generatedSelectors.has(selector))),
      generatedOnly: sorted([...generatedSelectors].filter((selector) => !baselineSelectors.has(selector))),
      allowedInlineOnly: withInlineSelectorRecords(
        sorted([...allowedInlineSelectors.keys()].filter((selector) => !generatedSelectors.has(selector))),
        allowedInlineSelectors,
      ),
    },
    themeVariables: compareVariables(
      extractCustomPropertiesFromThemeLayer(baselineCss),
      extractCustomPropertiesFromThemeLayer(generatedCss),
    ),
    runtimeRootVariables: compareVariables(
      extractStandaloneRootVariables(baselineCss),
      extractStandaloneRootVariables(generatedCss),
    ),
    dynamicClassSites: usage.dynamicSites,
  }
  const inventory = buildGuardrailInventory(report, usage, generatedSelectors, allowedInlineSelectors)
  report.guardrails = buildGuardrailReport(report, inventory, args.guardrailInventory, root)
  const failures = []
  if (args.failOnMissingGenerated) failures.push(...missingGeneratedFailures(report.usedTokens.missingInGenerated))
  if (args.failOnGuardrail) failures.push(...guardrailFailures(report.guardrails))
  return { report, failures, inventory }
}

function writeJsonFile(path, value, pretty) {
  const outPath = resolve(repoRoot, path)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function gitShow(spec, root = repoRoot) {
  return execFileSync('git', ['show', spec], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function discoverSourceRoots(root = repoRoot) {
  return sorted([
    ...discoverWorkspaceSourceRoots(root, 'apps', ['app', 'src']),
    ...discoverWorkspaceSourceRoots(root, 'packages', ['src']),
  ])
}

function discoverWorkspaceSourceRoots(root, workspaceDir, sourceDirNames) {
  const workspacePath = resolve(root, workspaceDir)
  try {
    const roots = []
    for (const entry of readdirSync(workspacePath)) {
      if (entry.startsWith('.')) continue
      const packagePath = resolve(workspacePath, entry)
      if (!statSync(packagePath).isDirectory()) continue
      for (const sourceDirName of sourceDirNames) {
        const sourcePath = resolve(packagePath, sourceDirName)
        if (isDirectory(sourcePath)) roots.push(relative(root, sourcePath))
      }
    }
    return roots
  } catch {
    return []
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectSourceFiles(root) {
  const files = []
  if (isDirectory(root)) walk(root, files)
  return sorted(files)
}

function walk(dir, files) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue
    const path = resolve(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walk(path, files)
    } else if (/\.[cm]?[jt]sx?$/u.test(entry) && !ignoredFilePatterns.some((pattern) => pattern.test(entry))) {
      files.push(path)
    }
  }
}

function collectClassUsage(files, root = repoRoot) {
  const staticTokens = new Map()
  const dynamicSites = []
  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8')
    const sourceFile = createSourceFile(file, sourceText)
    const lexicalConstants = buildLexicalConstantResolver(sourceFile)
    const visit = (node) => {
      if (inspectNode(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) === false) return
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return {
    staticTokens,
    dynamicSites: dynamicSites.sort(compareSite),
  }
}

function createSourceFile(file, sourceText) {
  const scriptKind = /\.[cm]?tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
}

function inspectNode(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) {
  if (ts.isJsxAttribute(node) && ['className', 'class'].includes(node.name.getText(sourceFile))) {
    if (!node.initializer) return false
    if (ts.isStringLiteral(node.initializer)) {
      addTokens(node.initializer.text, sourceFile, node.initializer, staticTokens, 'jsx-attribute', root)
      return false
    }
    if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      collectExpressionTokens(node.initializer.expression, sourceFile, sourceText, staticTokens, dynamicSites, 'jsx-className', root, lexicalConstants)
    }
    return false
  }
  if (ts.isPropertyAssignment(node) && isClassNameProperty(node.name)) {
    collectExpressionTokens(node.initializer, sourceFile, sourceText, staticTokens, dynamicSites, 'object-className', root, lexicalConstants)
    return false
  }
  if (ts.isCallExpression(node) && isCvaCall(node.expression)) {
    collectCvaCallTokens(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants)
    return false
  }
  if (ts.isCallExpression(node) && isClassCombiner(node.expression)) {
    for (const arg of node.arguments) {
      collectExpressionTokens(arg, sourceFile, sourceText, staticTokens, dynamicSites, `call:${node.expression.getText(sourceFile)}`, root, lexicalConstants)
    }
    return false
  }
  return true
}

function collectExpressionTokens(node, sourceFile, sourceText, staticTokens, dynamicSites, context, root, lexicalConstants) {
  if (isEmptyClassExpression(node)) return true
  const staticValue = evaluateStaticString(node, lexicalConstants)
  if (staticValue !== null) {
    addTokens(staticValue, sourceFile, node, staticTokens, context, root)
    return true
  }
  if (ts.isTemplateExpression(node)) {
    addDynamicSite(dynamicSites, sourceFile, sourceText, node, context, 'template-expression', templatePattern(node, sourceFile), root)
    return false
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = collectExpressionTokens(node.whenTrue, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:conditional-true`, root, lexicalConstants)
    const whenFalse = collectExpressionTokens(node.whenFalse, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:conditional-false`, root, lexicalConstants)
    return whenTrue && whenFalse
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      addDynamicSite(dynamicSites, sourceFile, sourceText, node, context, 'string-concat', null, root)
      return false
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return collectExpressionTokens(node.right, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:logical-right`, root, lexicalConstants)
    }
    if ([
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)) {
      collectExpressionTokens(node.left, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:logical-left`, root, lexicalConstants)
      collectExpressionTokens(node.right, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:logical-right`, root, lexicalConstants)
      return false
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => collectExpressionTokens(element, sourceFile, sourceText, staticTokens, dynamicSites, `${context}:array`, root, lexicalConstants)).every(Boolean)
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (ts.isStringLiteralLike(property.name)) addTokens(property.name.text, sourceFile, property.name, staticTokens, `${context}:object-key`, root)
        else if (ts.isIdentifier(property.name)) addTokens(property.name.text, sourceFile, property.name, staticTokens, `${context}:object-key`, root)
        else addDynamicSite(dynamicSites, sourceFile, sourceText, property.name, context, 'computed-object-key', null, root)
      } else if (ts.isShorthandPropertyAssignment(property)) {
        addDynamicSite(dynamicSites, sourceFile, sourceText, property, context, 'shorthand-object-key', null, root)
      } else if (ts.isSpreadAssignment(property)) {
        addDynamicSite(dynamicSites, sourceFile, sourceText, property, context, 'object-spread', null, root)
      }
    }
    return false
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return collectExpressionTokens(node.expression, sourceFile, sourceText, staticTokens, dynamicSites, context, root, lexicalConstants)
  }
  if (ts.isCallExpression(node) && isClassCombiner(node.expression)) {
    if (isCvaCall(node.expression)) {
      collectCvaCallTokens(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants)
      return false
    }
    for (const arg of node.arguments) collectExpressionTokens(arg, sourceFile, sourceText, staticTokens, dynamicSites, `call:${node.expression.getText(sourceFile)}`, root, lexicalConstants)
    return false
  }
  addDynamicSite(dynamicSites, sourceFile, sourceText, node, context, 'unresolved-expression', null, root)
  return false
}

function isEmptyClassExpression(node) {
  return node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.UndefinedKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
}

function collectCvaCallTokens(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) {
  const [base, config] = node.arguments
  if (base) collectExpressionTokens(base, sourceFile, sourceText, staticTokens, dynamicSites, 'call:cva:base', root, lexicalConstants)
  if (!config) return
  if (!ts.isObjectLiteralExpression(config)) {
    addDynamicSite(dynamicSites, sourceFile, sourceText, config, 'call:cva:config', 'dynamic-cva-config', null, root)
    return
  }
  collectCvaConfigTokens(config, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants)
}

function collectCvaConfigTokens(config, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) {
  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) {
      if (ts.isSpreadAssignment(property)) addDynamicSite(dynamicSites, sourceFile, sourceText, property, 'call:cva:config', 'cva-config-spread', null, root)
      continue
    }
    const name = propertyNameText(property.name)
    if (name === 'variants') collectCvaVariants(property.initializer, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants)
    else if (name === 'compoundVariants') collectCvaCompoundVariants(property.initializer, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants)
  }
}

function collectCvaVariants(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) {
  if (!ts.isObjectLiteralExpression(node)) {
    addDynamicSite(dynamicSites, sourceFile, sourceText, node, 'call:cva:variants', 'dynamic-cva-variants', null, root)
    return
  }
  for (const variantProperty of node.properties) {
    if (!ts.isPropertyAssignment(variantProperty)) {
      if (ts.isSpreadAssignment(variantProperty)) addDynamicSite(dynamicSites, sourceFile, sourceText, variantProperty, 'call:cva:variants', 'cva-variants-spread', null, root)
      continue
    }
    const variantName = propertyNameText(variantProperty.name) ?? 'variant'
    if (!ts.isObjectLiteralExpression(variantProperty.initializer)) {
      addDynamicSite(dynamicSites, sourceFile, sourceText, variantProperty.initializer, `call:cva:variant:${variantName}`, 'dynamic-cva-variant', null, root)
      continue
    }
    for (const valueProperty of variantProperty.initializer.properties) {
      if (!ts.isPropertyAssignment(valueProperty)) {
        if (ts.isSpreadAssignment(valueProperty)) addDynamicSite(dynamicSites, sourceFile, sourceText, valueProperty, `call:cva:variant:${variantName}`, 'cva-variant-spread', null, root)
        continue
      }
      const valueName = propertyNameText(valueProperty.name) ?? 'value'
      collectExpressionTokens(valueProperty.initializer, sourceFile, sourceText, staticTokens, dynamicSites, `call:cva:variant:${variantName}.${valueName}`, root, lexicalConstants)
    }
  }
}

function collectCvaCompoundVariants(node, sourceFile, sourceText, staticTokens, dynamicSites, root, lexicalConstants) {
  if (!ts.isArrayLiteralExpression(node)) {
    addDynamicSite(dynamicSites, sourceFile, sourceText, node, 'call:cva:compoundVariants', 'dynamic-cva-compound-variants', null, root)
    return
  }
  for (const element of node.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      addDynamicSite(dynamicSites, sourceFile, sourceText, element, 'call:cva:compoundVariants', 'dynamic-cva-compound-variant', null, root)
      continue
    }
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) {
        if (ts.isSpreadAssignment(property)) addDynamicSite(dynamicSites, sourceFile, sourceText, property, 'call:cva:compoundVariants', 'cva-compound-spread', null, root)
        continue
      }
      const name = propertyNameText(property.name)
      if (name === 'class' || name === 'className') {
        collectExpressionTokens(property.initializer, sourceFile, sourceText, staticTokens, dynamicSites, `call:cva:compoundVariants:${name}`, root, lexicalConstants)
      }
    }
  }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function isClassNameProperty(name) {
  return (ts.isIdentifier(name) && name.text === 'className') || (ts.isStringLiteralLike(name) && name.text === 'className')
}

function isCvaCall(expression) {
  if (ts.isIdentifier(expression)) return expression.text === 'cva'
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'cva'
  return false
}

function isClassCombiner(expression) {
  if (ts.isIdentifier(expression)) return classCombinerNames.has(expression.text)
  if (ts.isPropertyAccessExpression(expression)) return classCombinerNames.has(expression.name.text)
  return false
}

function addTokens(value, sourceFile, node, staticTokens, context, root) {
  for (const token of splitClassTokens(value)) {
    if (!staticTokens.has(token)) staticTokens.set(token, { count: 0, locations: [], uses: [] })
    const record = staticTokens.get(token)
    record.count += 1
    const location = locationFor(sourceFile, node, context, root)
    record.uses.push(location)
    if (record.locations.length < diagnosticLocationLimit && !record.locations.some((item) => sameLocation(item, location))) {
      record.locations.push(location)
    }
  }
}

function splitClassTokens(value) {
  return value
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/[${}`]/u.test(token))
    .filter((token) => !isMarkerClassToken(token))
}

function isMarkerClassToken(token) {
  return token === 'group' || token === 'peer' || token.startsWith('group/') || token.startsWith('peer/')
}

function evaluateStaticString(node, lexicalConstants = null, seen = new Set(), depth = 0, state = newEvaluationState()) {
  if (!consumeEvaluationStep(state) || depth > constantResolutionDepthLimit) return null
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return boundedString(node.text, state)
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return evaluateStaticString(node.expression, lexicalConstants, seen, depth + 1, state)
  }
  if (ts.isIdentifier(node)) return lexicalConstants?.resolve(node, seen, depth + 1, state) ?? null
  if (ts.isTemplateExpression(node)) {
    let value = boundedString(node.head.text, state)
    if (value === null) return null
    for (const span of node.templateSpans) {
      const expressionValue = evaluateStaticString(span.expression, lexicalConstants, seen, depth + 1, state)
      if (expressionValue === null) return null
      value = appendBoundedString(value, expressionValue, state)
      if (value === null) return null
      value = appendBoundedString(value, span.literal.text, state)
      if (value === null) return null
    }
    return value
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticString(node.left, lexicalConstants, seen, depth + 1, state)
    if (left === null) return null
    const right = evaluateStaticString(node.right, lexicalConstants, seen, depth + 1, state)
    if (right === null) return null
    return appendBoundedString(left, right, state)
  }
  return null
}

function newEvaluationState() {
  return { steps: 0, outputLength: 0 }
}

function consumeEvaluationStep(state) {
  state.steps += 1
  return state.steps <= constantResolutionStepLimit
}

function boundedString(value, state) {
  state.outputLength += value.length
  return state.outputLength <= constantResolutionOutputLimit ? value : null
}

function appendBoundedString(left, right, state) {
  if (left.length + right.length > constantResolutionOutputLimit) return null
  state.outputLength += right.length
  if (state.outputLength > constantResolutionOutputLimit) return null
  return `${left}${right}`
}

function buildLexicalConstantResolver(sourceFile) {
  const bindings = []
  const visit = (node) => {
    collectBinding(node, sourceFile, bindings)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return {
    resolve(identifier, seen = new Set(), depth = 0, state = newEvaluationState()) {
      if (!consumeEvaluationStep(state) || depth > constantResolutionDepthLimit) return null
      const binding = nearestBinding(bindings, identifier, sourceFile)
      if (!binding || binding.start > identifier.getStart(sourceFile) || binding.kind !== 'const' || !binding.initializer) return null
      const key = `${binding.name}:${binding.node.pos}:${binding.node.end}`
      if (seen.has(key)) return null
      seen.add(key)
      const value = evaluateStaticString(binding.initializer, this, seen, depth + 1, state)
      seen.delete(key)
      return value
    },
  }
}

function collectBinding(node, sourceFile, bindings) {
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
    bindings.push(bindingRecord(node.name.text, node.name, sourceFile, 'imported'))
    return
  }
  if (ts.isImportClause(node) && node.name) {
    bindings.push(bindingRecord(node.name.text, node.name, sourceFile, 'imported'))
    return
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isIdentifier(node.name)) {
    bindings.push(bindingRecord(node.name.text, node.name, sourceFile, 'imported'))
    return
  }
  if (ts.isVariableDeclaration(node)) {
    if (ts.isCatchClause(node.parent)) return
    const declarationList = node.parent
    const isConst = ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0
    const isDirectIdentifier = ts.isIdentifier(node.name)
    const scope = variableBindingScope(node, sourceFile)
    const kind = isDirectIdentifier && isConst ? 'const' : isDirectIdentifier ? 'mutable' : 'destructured'
    const initializer = kind === 'const' ? node.initializer : null
    for (const name of bindingIdentifiers(node.name)) {
      bindings.push(bindingRecord(name.text, name, sourceFile, kind, initializer, scope))
    }
    return
  }
  if (ts.isParameter(node)) {
    const scope = nearestFunctionLike(node) ?? node.parent ?? sourceFile
    for (const name of bindingIdentifiers(node.name)) bindings.push(bindingRecord(name.text, name, sourceFile, 'param', null, scope))
    return
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    const scope = ts.isFunctionDeclaration(node) ? nearestFunctionLike(node) ?? lexicalParentScope(node, sourceFile) : lexicalParentScope(node, sourceFile)
    bindings.push(bindingRecord(node.name.text, node.name, sourceFile, 'local', null, scope))
    return
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    for (const name of bindingIdentifiers(node.variableDeclaration.name)) bindings.push(bindingRecord(name.text, name, sourceFile, 'mutable', null, node.block))
  }
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name]
  const identifiers = []
  const visit = (node) => {
    if (ts.isIdentifier(node) && isBindingIdentifierNode(node)) identifiers.push(node)
    ts.forEachChild(node, visit)
  }
  visit(name)
  return identifiers
}

function isBindingIdentifierNode(node) {
  const parent = node.parent
  if (!parent) return false
  if (ts.isBindingElement(parent) && parent.name === node) return true
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return true
  return false
}

function bindingRecord(name, node, sourceFile, kind, initializer = null, scope = null) {
  const bindingScope = scope ?? lexicalParentScope(node, sourceFile)
  return {
    name,
    node,
    kind,
    initializer,
    scope: bindingScope,
    start: node.getStart(sourceFile),
    scopeStart: bindingScope.getStart(sourceFile),
    scopeEnd: bindingScope.getEnd(),
  }
}

function nearestBinding(bindings, identifier, sourceFile) {
  const name = identifier.text
  const position = identifier.getStart(sourceFile)
  return bindings
    .filter((binding) => binding.name === name
      && binding.scopeStart <= position
      && position <= binding.scopeEnd)
    .sort((left, right) => {
      const leftWidth = left.scopeEnd - left.scopeStart
      const rightWidth = right.scopeEnd - right.scopeStart
      return leftWidth - rightWidth || right.start - left.start
    })[0] ?? null
}

function variableBindingScope(node, sourceFile) {
  const declarationList = node.parent
  const isVar = ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
  if (isVar) return nearestFunctionLike(node) ?? sourceFile
  return lexicalParentScope(node, sourceFile)
}

function lexicalParentScope(node, sourceFile) {
  let current = node.parent
  while (current && current !== sourceFile) {
    if (isLexicalScopeNode(current)) return current
    current = current.parent
  }
  return sourceFile
}

function isLexicalScopeNode(node) {
  return ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isSourceFile(node)
    || ts.isCaseBlock(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
}

function nearestFunctionLike(node) {
  let current = node.parent
  while (current) {
    if (isFunctionScopeNode(current)) return current
    current = current.parent
  }
  return null
}

function isFunctionScopeNode(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

function addDynamicSite(dynamicSites, sourceFile, sourceText, node, context, reason, pattern, root) {
  dynamicSites.push({
    ...locationFor(sourceFile, node, context, root),
    reason,
    pattern,
    snippet: compactSnippet(sourceText.slice(node.getStart(sourceFile), node.getEnd())),
  })
}

function locationFor(sourceFile, node, context, root = repoRoot) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: relative(root, sourceFile.fileName).replaceAll('\\', '/'),
    line: pos.line + 1,
    column: pos.character + 1,
    context,
  }
}

function compareSite(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.reason.localeCompare(b.reason)
}

function sameLocation(left, right) {
  return left.file === right.file && left.line === right.line && left.column === right.column && left.context === right.context
}

function compactSnippet(value) {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 240)
}

function templatePattern(node, sourceFile) {
  let pattern = node.head.text
  for (const span of node.templateSpans) pattern += `\${${span.expression.getText(sourceFile)}}${span.literal.text}`
  return pattern
}

function collectAllowedInlineSelectors(files, root = repoRoot) {
  const selectors = new Map()
  for (const file of files) {
    const relativeFile = relative(root, file).replaceAll('\\', '/')
    if (relativeFile !== devPickerRuntimeCss.file) continue
    const sourceText = readFileSync(file, 'utf8')
    const sourceFile = createSourceFile(file, sourceText)
    const visit = (node) => {
      if (isAllowedDebugRuntimeStyleElement(node, sourceFile)) {
        const location = {
          ...locationFor(sourceFile, node, 'inline-style-allowance', root),
          provenance: {
            file: devPickerRuntimeCss.file,
            styleId: devPickerRuntimeCss.styleId,
            expression: devPickerRuntimeCss.expression,
            reason: 'PER-279 documented debug preview runtime stylesheet allowance',
          },
        }
        for (const selector of devPickerRuntimeCss.selectors) addInlineSelector(selectors, selector, location)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return selectors
}

function isAllowedDebugRuntimeStyleElement(node, sourceFile) {
  if (!ts.isJsxElement(node) || node.openingElement.tagName.getText(sourceFile) !== 'style') return false
  const idAttribute = node.openingElement.attributes.properties.find((property) => {
    return ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'id'
  })
  if (!idAttribute || !ts.isJsxAttribute(idAttribute) || !idAttribute.initializer || !ts.isStringLiteral(idAttribute.initializer)) return false
  if (idAttribute.initializer.text !== devPickerRuntimeCss.styleId) return false
  return node.children.some((child) => {
    return ts.isJsxExpression(child)
      && child.expression
      && ts.isIdentifier(child.expression)
      && child.expression.text === devPickerRuntimeCss.expression
  })
}

function addInlineSelector(selectors, selector, location) {
  if (!selectors.has(selector)) selectors.set(selector, { locations: [] })
  const record = selectors.get(selector)
  if (!record.locations.some((item) => sameLocation(item, location))) record.locations.push(location)
}

function extractClassSelectors(css) {
  const selectors = new Set()
  const pattern = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\[^\r\n\f]|[A-Za-z0-9_-])+)/gu
  let match
  while ((match = pattern.exec(css))) {
    const raw = match[1]
    if (!raw || raw.startsWith('\\/')) continue
    const selector = cssUnescape(raw)
    if (selector && !selector.includes('\n') && !isMarkerClassToken(selector)) selectors.add(selector)
  }
  return selectors
}

function cssUnescape(value) {
  return value
    .replace(/\\([0-9a-fA-F]{1,6})\s?/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\(.)/gu, '$1')
}

function extractCustomPropertiesFromThemeLayer(css) {
  const start = css.indexOf('@layer theme')
  if (start === -1) return {}
  const open = css.indexOf('{', start)
  if (open === -1) return {}
  const close = findMatchingBrace(css, open)
  if (close === -1) return {}
  return extractCustomProperties(css.slice(open + 1, close))
}

function extractStandaloneRootVariables(css) {
  const vars = {}
  let searchFrom = 0
  while (searchFrom < css.length) {
    const rootIndex = css.indexOf(':root', searchFrom)
    if (rootIndex === -1) break
    searchFrom = rootIndex + ':root'.length
    if (!isSelectorBoundary(css[rootIndex - 1])) continue
    const afterRoot = rootIndex + ':root'.length
    if (!isSelectorBoundary(css[afterRoot]) && !/\s/u.test(css[afterRoot] ?? '')) continue
    const open = css.indexOf('{', afterRoot)
    if (open === -1) break
    if (css.slice(afterRoot, open).trim()) continue
    const close = findMatchingBrace(css, open)
    if (open !== -1 && close !== -1) Object.assign(vars, extractCustomProperties(css.slice(open + 1, close)))
  }
  return vars
}

function isSelectorBoundary(char) {
  return char === undefined || /[\s,>{(]/u.test(char)
}

function extractCustomProperties(css) {
  const vars = {}
  const declarationPattern = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);?/gu
  let match
  while ((match = declarationPattern.exec(css))) vars[match[1]] = match[2].trim()
  return vars
}

function findMatchingBrace(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function compareVariables(before, after) {
  const beforeKeys = new Set(Object.keys(before))
  const afterKeys = new Set(Object.keys(after))
  return {
    added: sorted([...afterKeys].filter((key) => !beforeKeys.has(key))).map((name) => ({ name, value: after[name] })),
    removed: sorted([...beforeKeys].filter((key) => !afterKeys.has(key))).map((name) => ({ name, value: before[name] })),
    changed: sorted([...beforeKeys].filter((key) => afterKeys.has(key) && before[key] !== after[key])).map((name) => ({
      name,
      before: before[name],
      after: after[name],
    })),
  }
}

function buildGuardrailInventory(report, usage, generatedSelectors, allowedInlineSelectors) {
  const staticTokenCounts = Object.fromEntries(
    sorted([...usage.staticTokens.keys()]).map((token) => [token, usage.staticTokens.get(token)?.count ?? 0]),
  )
  const auiStaticTokenCounts = Object.fromEntries(
    Object.entries(staticTokenCounts).filter(([token]) => token.startsWith('aui-')),
  )
  const dynamicClassSiteCounts = dynamicSiteCountRecords(usage.dynamicSites)
  return {
    version: 2,
    description: 'PER-279 CSS guardrail inventory. Regenerate only from root after consolidated validation accepts the current phase.',
    generatedFrom: {
      generatedCss: report.metadata.generated.cssPath,
      sourceRoots: report.metadata.sourceRoots,
    },
    summary: {
      staticClassTokensUsed: report.summary.staticClassTokensUsed,
      staticClassTokenOccurrences: report.summary.staticClassTokenOccurrences,
      auiStaticClassTokensUsed: report.summary.auiStaticClassTokensUsed,
      auiStaticClassTokenOccurrences: report.summary.auiStaticClassTokenOccurrences,
      generatedSelectorCount: report.summary.generatedSelectorCount,
      allowedInlineSelectorCount: report.summary.allowedInlineSelectorCount,
      dynamicClassSites: report.summary.dynamicClassSites,
    },
    staticTokenCounts,
    auiStaticTokenCounts,
    auiStaticTokens: sorted(Object.keys(auiStaticTokenCounts)),
    auiGeneratedSelectors: sorted([...generatedSelectors].filter((selector) => selector.startsWith('aui-'))),
    allowedInlineSelectors: withInlineSelectorRecords(sorted([...allowedInlineSelectors.keys()]), allowedInlineSelectors),
    dynamicClassSiteCounts,
  }
}

function buildGuardrailReport(report, currentInventory, inventoryPath, root = repoRoot) {
  const guardrails = {
    strictInventoryPath: inventoryPath,
    addedAuiStaticTokens: [],
    addedAuiGeneratedSelectors: [],
    increasedAuiStaticTokenUsage: [],
    unexpectedDynamicClassSites: [],
    currentSummary: currentInventory.summary,
    baselineSummary: null,
  }
  if (!inventoryPath) return guardrails
  const baseline = JSON.parse(readFileSync(resolve(root, inventoryPath), 'utf8'))
  const baselineAuiStaticTokens = new Set(baseline.auiStaticTokens ?? Object.keys(baseline.auiStaticTokenCounts ?? {}))
  const baselineAuiGeneratedSelectors = new Set(baseline.auiGeneratedSelectors ?? [])
  const baselineAuiCounts = baseline.auiStaticTokenCounts ?? filterAuiCounts(baseline.staticTokenCounts ?? {})
  const baselineDynamicCounts = dynamicCountsFromInventory(baseline)
  guardrails.addedAuiStaticTokens = currentInventory.auiStaticTokens.filter((token) => !baselineAuiStaticTokens.has(token))
  guardrails.addedAuiGeneratedSelectors = currentInventory.auiGeneratedSelectors.filter((selector) => !baselineAuiGeneratedSelectors.has(selector))
  guardrails.increasedAuiStaticTokenUsage = Object.entries(currentInventory.auiStaticTokenCounts)
    .filter(([token, count]) => count > (baselineAuiCounts[token] ?? 0))
    .map(([token, count]) => ({ token, baseline: baselineAuiCounts[token] ?? 0, current: count }))
  guardrails.unexpectedDynamicClassSites = currentInventory.dynamicClassSiteCounts
    .filter((site) => site.count > (baselineDynamicCounts.get(site.key) ?? 0))
    .map((site) => ({ ...site, baseline: baselineDynamicCounts.get(site.key) ?? 0, current: site.count }))
  guardrails.baselineSummary = baseline.summary ?? null
  report.summary.guardrailFailures = guardrailFailures(guardrails).length
  return guardrails
}

function filterAuiCounts(counts) {
  return Object.fromEntries(Object.entries(counts).filter(([token]) => token.startsWith('aui-')))
}

function dynamicCountsFromInventory(inventory) {
  const counts = new Map()
  if (Array.isArray(inventory.dynamicClassSiteCounts)) {
    for (const item of inventory.dynamicClassSiteCounts) counts.set(item.key, item.count)
    return counts
  }
  for (const site of inventory.dynamicClassSites ?? []) {
    const key = dynamicSiteKey(site)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function dynamicSiteCountRecords(dynamicSites) {
  const records = new Map()
  for (const site of dynamicSites) {
    const key = dynamicSiteKey(site)
    const existing = records.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    records.set(key, {
      key,
      count: 1,
      file: site.file,
      context: site.context,
      reason: site.reason,
      pattern: site.pattern,
      snippet: site.snippet,
      firstLocation: {
        file: site.file,
        line: site.line,
        column: site.column,
      },
    })
  }
  return sorted([...records.values()], (item) => item.key)
}

function dynamicSiteKey(site) {
  return [
    site.file,
    site.context,
    site.reason,
    site.pattern ?? '',
    site.snippet ?? '',
  ].join('\u0000')
}

function missingGeneratedFailures(missing) {
  return missing.map(({ token, occurrenceCount, locations }) => {
    const first = locations[0]
    const suffix = first ? ` at ${first.file}:${first.line}:${first.column}` : ''
    const count = occurrenceCount === 1 ? '' : ` (${occurrenceCount} occurrences)`
    return `missing generated class: ${token}${count}${suffix}`
  })
}

function guardrailFailures(guardrails) {
  const failures = []
  for (const token of guardrails.addedAuiStaticTokens ?? []) failures.push(`new aui-* static class outside inventory: ${token}`)
  for (const selector of guardrails.addedAuiGeneratedSelectors ?? []) failures.push(`new aui-* generated selector outside inventory: ${selector}`)
  for (const item of guardrails.increasedAuiStaticTokenUsage ?? []) failures.push(`aui-* static class usage increased: ${item.token} ${item.baseline} -> ${item.current}`)
  for (const site of guardrails.unexpectedDynamicClassSites ?? []) {
    const first = site.firstLocation ? `${site.firstLocation.file}:${site.firstLocation.line}:${site.firstLocation.column}` : site.file
    failures.push(`unexpected dynamic class site count: ${first} ${site.reason}${site.pattern ? ` ${site.pattern}` : ''} ${site.baseline} -> ${site.current}`)
  }
  return failures
}

function countTokenOccurrences(staticTokens, predicate = () => true) {
  let count = 0
  for (const [token, record] of staticTokens) {
    if (predicate(token)) count += record.count
  }
  return count
}

function isTokenSatisfiedByGeneratedOrAllowed(token, record, generatedSelectors, allowedInlineSelectors) {
  if (generatedSelectors.has(token)) return true
  return areAllTokenUsesAllowedInline(token, record, allowedInlineSelectors)
}

function areAllTokenUsesAllowedInline(token, record, allowedInlineSelectors) {
  if (!record || record.count === 0) return false
  if (!allowedInlineSelectors.has(token)) return false
  const uses = record.uses ?? record.locations
  return uses.length === record.count && uses.every((use) => isAllowedInlineUse(token, use, allowedInlineSelectors))
}

function isAllowedInlineUse(token, use, allowedInlineSelectors) {
  const allowance = allowedInlineSelectors.get(token)
  if (!allowance) return false
  return allowance.locations.some((location) => {
    return location.provenance?.file === use.file
      && location.provenance?.styleId === devPickerRuntimeCss.styleId
      && location.provenance?.expression === devPickerRuntimeCss.expression
  })
}

function withTokenRecords(tokens, tokenRecords) {
  return tokens.map((token) => {
    const record = tokenRecords.get(token) ?? { count: 0, locations: [], uses: [] }
    return {
      token,
      occurrenceCount: record.count,
      locations: record.locations,
      omittedLocationCount: Math.max(0, record.count - record.locations.length),
    }
  })
}

function withMissingGeneratedTokenRecords(tokens, tokenRecords, generatedSelectors, allowedInlineSelectors) {
  return tokens.map((token) => {
    const record = tokenRecords.get(token) ?? { count: 0, locations: [], uses: [] }
    if (generatedSelectors.has(token)) {
      return {
        token,
        occurrenceCount: 0,
        locations: [],
        omittedLocationCount: 0,
      }
    }
    const missingUses = (record.uses ?? record.locations).filter((use) => !isAllowedInlineUse(token, use, allowedInlineSelectors))
    const locations = sampleLocations(missingUses)
    return {
      token,
      occurrenceCount: missingUses.length,
      locations,
      omittedLocationCount: Math.max(0, missingUses.length - locations.length),
    }
  })
}

function sampleLocations(locations) {
  const sampled = []
  for (const location of locations) {
    if (sampled.length >= diagnosticLocationLimit) break
    if (!sampled.some((item) => sameLocation(item, location))) sampled.push(location)
  }
  return sampled
}

function withInlineSelectorRecords(selectors, inlineSelectors) {
  return selectors.map((selector) => ({
    selector,
    locations: inlineSelectors.get(selector)?.locations ?? [],
  }))
}

function sorted(values, keyFn = (value) => value) {
  return values.sort((a, b) => String(keyFn(a)).localeCompare(String(keyFn(b))))
}

export {
  buildAudit,
  buildGuardrailInventory,
  buildGuardrailReport,
  collectAllowedInlineSelectors,
  collectClassUsage,
  collectSourceFiles,
  discoverSourceRoots,
  dynamicSiteCountRecords,
  extractClassSelectors,
  guardrailFailures,
  missingGeneratedFailures,
  splitClassTokens,
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
