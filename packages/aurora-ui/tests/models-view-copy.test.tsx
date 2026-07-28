// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCapabilityGraph,
  capabilityGraphCatalogFixture,
  gatewayRegistryFixture,
  modelRuntimeCatalogFixture,
} from '@aurora/client'
import { ModelsView } from '../src/models-view'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('models view product copy', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('opens the model source settings dialog without internal copy in text or ARIA', async () => {
    const getSchemaMetadata = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        fields: [{
          key_path: 'services.orchestrator.llm.local.llama_cpp.options.temperature',
          title: 'Temperature',
          description: 'Controls response variety.',
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
          initialCatalog={modelRuntimeCatalogFixture}
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
    expect(copySurface(document.body)).not.toMatch(MODEL_FORBIDDEN_PRODUCT_TERMS)

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

function copySurface(root: ParentNode): string {
  const attributes: string[] = []
  root.querySelectorAll('*').forEach((node) => {
    for (const attribute of ['aria-label', 'title', 'alt', 'placeholder']) {
      const value = node.getAttribute(attribute)
      if (value) attributes.push(value)
    }
  })
  return `${document.body.textContent ?? ''} ${attributes.join(' ')}`
}

const MODEL_FORBIDDEN_PRODUCT_TERMS =
  /\b(Runtime|backend|providers?|backend option schema|Config\.GetSchemaMetadata|configuration schema|active provider|Currently selected provider)\b/iu
