// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  cloneFixture,
  gatewayRegistryFixture,
  modelRuntimeCatalogFixture,
} from '@aurora/client'
import { buildModelsViewModel, ModelsView } from '../src/models-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('models view product copy', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps hostile catalog, status, action, and route values out of rendered page copy', async () => {
    const rootNode = document.createElement('div')
    document.body.append(rootNode)
    const root = createRoot(rootNode)
    const graph = hostileGraph()
    const catalog = hostileCatalog()

    await act(async () => {
      root.render(
        <ModelsView
          client={client(vi.fn())}
          initialCatalog={catalog}
          initialGraph={graph}
          initialNativeManifest={hostileNativeManifest()}
        />
      )
    })

    const text = copySurface(document.body)
    expect(text).toContain('Model source')
    expect(text).toContain('Model import is in progress.')
    expect(text).toContain('Model download is in progress.')
    expect(text).toContain('Benchmark is running through Aurora.')
    expect(text).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])

    const model = buildModelsViewModel({
      catalog,
      graph,
      nativeManifest: hostileNativeManifest(),
      loadState: 'ready',
    })
    const derivedCopy = [
      ...model.providers.flatMap((provider) => [
        provider.name,
        provider.routeLabel,
        provider.healthReason,
        provider.importReason,
        provider.downloadReason,
        provider.benchmarkReason,
        provider.selectReason,
        provider.operationStatus,
        ...provider.blockers,
      ]),
      ...model.categoryRows.flatMap((row) => [row.label, row.value, row.detail]),
      ...model.benchmarkRows.flatMap((row) => [row.label, row.value, row.detail]),
      ...model.warnings,
      model.mobileLocalLightReason,
    ].join(' ')
    expect(derivedCopy).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)

    await act(async () => {
      root.unmount()
    })
  })

  it('opens the model source settings dialog without internal metadata copy in text or ARIA', async () => {
    const getSchemaMetadata = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        fields: [{
          key_path: 'services.orchestrator.llm.local.llama_cpp.options.temperature',
          title: 'Raw runtime backend provider schema Config.GetSchemaMetadata',
          description: 'raw services.orchestrator.llm.provider backend option schema proof',
          type: 'float',
          default: 0.7,
          current_value: 0.5,
          secret: false,
          editable: true,
          required: false,
          choices: null,
          constraints: { minimum: 0, maximum: 2 },
        }],
      },
    })
    const rootNode = document.createElement('div')
    document.body.append(rootNode)
    const root = createRoot(rootNode)

    await act(async () => {
      root.render(
        <ModelsView
          client={client(getSchemaMetadata)}
          initialCatalog={selectableModelCatalog()}
          initialGraph={buildCapabilityGraph({
            catalog: capabilityGraphCatalogFixture,
            registry: gatewayRegistryFixture,
            transportKind: 'mock',
          })}
        />
      )
    })

    const configure = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Configure')
    expect(configure).toBeTruthy()

    await act(async () => {
      configure!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSchemaMetadata).toHaveBeenCalledWith({
      section: 'services.orchestrator.llm.local.llama_cpp.options',
      include_values: true,
    })
    expect(document.body.textContent).toContain('Fields are generated from Aurora settings details for this model source.')
    expect(document.body.textContent).toContain('Model setting')
    expect(document.body.textContent).toContain('Update this setting only if you know the expected value.')
    expect(copySurface(document.body)).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)
    expect(findForbiddenProductionCopyTerms(copySurface(document.body)).map((term) => term.id)).toEqual([])

    const setActive = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Set as active' && !button.disabled)
    expect(setActive).toBeTruthy()

    await act(async () => {
      setActive!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const selectionDialogCopy = copySurface(document.body)
    expect(selectionDialogCopy).toContain('Select model source')
    expect(selectionDialogCopy).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)
    expect(selectionDialogCopy).not.toMatch(/local:Orchestrator|cloud:openai|Config\.Set|AdminAction/iu)
    expect(findForbiddenProductionCopyTerms(selectionDialogCopy).map((term) => term.id)).toEqual([])

    await act(async () => {
      root.unmount()
    })
  })

  it('redacts hostile settings error messages with a useful reference', async () => {
    const getSchemaMetadata = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: 'Raw Config.GetSchemaMetadata backend option schema provider runtime failed' },
    })
    const rootNode = document.createElement('div')
    document.body.append(rootNode)
    const root = createRoot(rootNode)

    await act(async () => {
      root.render(
        <ModelsView
          client={client(getSchemaMetadata)}
          initialCatalog={modelRuntimeCatalogFixture}
          initialGraph={hostileGraph()}
        />
      )
    })

    const configure = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Configure')
    expect(configure).toBeTruthy()

    await act(async () => {
      configure!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('Aurora model source request failed. Reference M')
    expect(copySurface(document.body)).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)
    expect(findForbiddenProductionCopyTerms(copySurface(document.body)).map((term) => term.id)).toEqual([])

    await act(async () => {
      root.unmount()
    })
  })
})

function client(getSchemaMetadata: ReturnType<typeof vi.fn>) {
  return {
    transport: { kind: 'http' },
    models: {
      listCatalog: vi.fn().mockResolvedValue(modelRuntimeCatalogFixture),
    },
    capabilities: {
      getGraph: vi.fn(),
    },
    native: {
      getManifest: vi.fn(),
    },
    config: {
      getSchemaMetadata,
      applyChange: vi.fn(),
    },
  } as never
}

function selectableModelCatalog() {
  const catalog = cloneFixture(modelRuntimeCatalogFixture)
  catalog.providers = [
    catalog.providers[0]!,
    {
      ...catalog.providers[0]!,
      provider_id: 'local:Orchestrator:huggingface-pipeline',
      display_name: 'Selected model source',
      backend_kind: 'transformers_pipeline',
      selected: false,
      enabled: true,
      health: 'healthy',
      health_reason: 'Ready for selection.',
    },
    catalog.providers[2]!,
  ]
  return catalog
}

function copySurface(root: ParentNode): string {
  const attributes: string[] = []
  root.querySelectorAll('*').forEach((node) => {
    for (const { name, value } of Array.from(node.attributes)) {
      if (/^(?:aria-label|title|alt|placeholder|data-(?!slot|variant|size|state)[a-z0-9-]+)$/iu.test(name) && value) {
        attributes.push(value)
      }
    }
  })
  return `${document.body.textContent ?? ''} ${attributes.join(' ')}`
}

const MODEL_FORBIDDEN_PRODUCT_TERMS =
  /\b(raw|Runtime|backend|providers?|schema|backend option schema|Config\.GetSchemaMetadata|configuration schema|active provider|Currently selected provider|AdminAction|contract|proof|fixture|assertion)\b|services\.orchestrator|Orchestrator\.[A-Za-z]+|Gateway\.[A-Za-z]+|native:[^\s,;]+|local:Orchestrator|cloud:openai|mesh:studio/iu

function hostileCatalog() {
  const catalog = cloneFixture(modelRuntimeCatalogFixture)
  const selected = {
    ...catalog.providers[0]!,
    display_name: 'Runtime backend provider Config.GetSchemaMetadata',
    health_reason: 'backend option schema provider runtime proof',
    import_progress: {
      ...catalog.providers[0]!.import_progress,
      status: 'running',
      progress_percent: 35,
      message: 'AdminAction model import contract is not active.',
    },
    download_progress: {
      ...catalog.providers[0]!.download_progress,
      status: 'running',
      progress_percent: 60,
      message: 'backend operation status exists for Config.GetSchemaMetadata.',
    },
    benchmark: {
      ...catalog.providers[0]!.benchmark,
      status: 'running',
      reason: 'backend option schema provider benchmark runtime',
    },
  }
  const disabledLocal = {
    ...catalog.providers[0]!,
    provider_id: 'local:Orchestrator:huggingface-pipeline',
    display_name: 'Disabled backend provider runtime',
    backend_kind: 'transformers_pipeline',
    selected: false,
    enabled: false,
    health: 'unavailable',
    health_reason: 'Backend catalog reports this provider disabled.',
  }
  const mesh = {
    ...catalog.providers[1]!,
    display_name: 'Mesh backend provider runtime',
    health_reason: 'native:android / provider proof',
  }
  catalog.providers = [selected, disabledLocal, mesh]
  return catalog
}

function hostileGraph() {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    transportKind: 'mock',
  })
  for (const node of Object.values(graph.byFeatureId)) {
    for (const provider of node.providers) {
      provider.module = 'Orchestrator'
      provider.method = 'GetModelCatalog'
      provider.disabledReasons = ['backend option schema provider runtime proof']
    }
  }
  return graph
}

function hostileNativeManifest() {
  return {
    localLightInference: {
      providerId: 'native:mobile-local-light',
      state: 'degraded',
      reason: 'backend_model_catalog_and_device_model_proof_required',
      evidenceSource: 'android-native-local-light-adapter',
    },
    capabilities: {
      'android.localLightInference.provider': true,
    },
    permissions: {
      'aurora.android.localLightInference': false,
    },
    platform: 'android',
  } as never
}
