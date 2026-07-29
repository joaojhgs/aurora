import { describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@aurora/client'
import {
  AURORA_NATIVE_TOOL_IDS,
  LocalToolExecutionPolicy,
  NATIVE_TOOL_DESCRIPTORS,
  createLocalToolingProviderHandlers,
  type LocalToolExecutionContext,
} from '@aurora/client/local-tools'
import {
  assertBrowserNativeCapabilityErrorCode,
  createBrowserNativeCapabilityPack,
  mapBrowserNativeCapabilityError,
  type BrowserFileHandle,
  type BrowserNativeCapabilityPackOptions,
} from '../src/browser-native-capability-pack'

const executionContext: LocalToolExecutionContext = {
  callerPeerId: 'peer-caller',
  callerPrincipalId: 'principal-1',
  callerDeviceId: 'device-1',
  permissions: ['*'],
  methodId: 'Tooling.ExecuteTool',
  nowMs: 1,
}

describe('browser native capability pack', () => {
  it('keeps the manifest, snapshot, and registered catalog in agreement', () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions())
    const catalog = pack.registry.publicTools()
    const catalogIds = catalog.map((tool) => tool.tool_contract_id).sort()
    const snapshotIds = Object.keys(pack.snapshot).sort()

    expect(catalogIds).toEqual(snapshotIds)
    expect(Object.keys(pack.manifest.capabilities).sort()).toEqual(snapshotIds)
    expect(catalogIds).not.toContain(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)
  })

  it('omits capabilities when the required browser API is missing or not already permitted', () => {
    const pack = createBrowserNativeCapabilityPack({
      stablePeerId: 'peer-browser',
      navigator: { onLine: true },
      notification: { permission: 'default', show: vi.fn() },
      window: { open: vi.fn() },
    })

    expect(pack.registeredToolIds).toEqual([
      AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
    ])
    expect(pack.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.openDeepLink)
    expect(pack.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.showNotification)
    expect(pack.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.shareText)
    expect(pack.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.getClipboardText)
  })

  it('requires explicit pre-granted permission evidence before advertising clipboard and document write', () => {
    const withoutEvidence = createBrowserNativeCapabilityPack(fullOptions({ permissionStates: {} }))
    expect(withoutEvidence.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.getClipboardText)
    expect(withoutEvidence.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.setClipboardText)
    expect(withoutEvidence.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.writeGrantedDocument)
    expect(withoutEvidence.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.pickDocument)
    expect(withoutEvidence.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.readGrantedDocument)

    const granted = createBrowserNativeCapabilityPack(fullOptions())
    expect(granted.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.getClipboardText)
    expect(granted.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.setClipboardText)
    expect(granted.registeredToolIds).toContain(AURORA_NATIVE_TOOL_IDS.writeGrantedDocument)
  })

  it('maps revoked browser permission failures to structured redacted errors', async () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      navigator: {
        clipboard: {
          readText: async () => {
            throw new DOMException('raw path /Users/alice denied', 'NotAllowedError')
          },
          writeText: vi.fn(),
        },
        share: vi.fn(),
        canShare: () => true,
        onLine: true,
      },
    }))
    const { provider, policy } = providerFor(pack)
    const approvalToken = await approvalFor(policy, pack, AURORA_NATIVE_TOOL_IDS.getClipboardText, {})

    await expect(provider.executeTool({
      tool_name: AURORA_NATIVE_TOOL_IDS.getClipboardText,
      arguments: {},
      approval_token: approvalToken,
    }, peerContext(['Tooling.ExecuteTool', 'Native.GetClipboardText']))).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error_code: 'permission_denied',
      error: 'Tool execution failed',
    })
    expect(mapBrowserNativeCapabilityError(new DOMException('cancelled by picker', 'AbortError'))).toBe('local_confirmation_required')
    expect(() => assertBrowserNativeCapabilityErrorCode('permission_denied')).not.toThrow()
  })

  it('inherits local confirmation requirements from the SDK descriptors', () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions())
    for (const tool of pack.registry.publicTools()) {
      const descriptor = NATIVE_TOOL_DESCRIPTORS.find((candidate) => candidate.toolContractId === tool.tool_contract_id)
      expect(tool.confirmation_required).toBe(descriptor?.confirmationPolicy !== 'never')
    }
  })

  it('rejects unapproved or unsafe deep links without opening them', async () => {
    const open = vi.fn()
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      window: { location: { origin: 'https://app.example', href: 'https://app.example/' }, open },
      approvedDeepLinks: ['https://app.example/approved/'],
    }))
    const entry = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(entry?.handler(callInput({ url: 'file:///Users/alice/secrets.txt' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    await expect(entry?.handler(callInput({ url: 'aurora-debug://shell/process' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    expect(open).not.toHaveBeenCalled()

    await expect(entry?.handler(callInput({ url: 'https://app.example/approved/help' }))).resolves.toEqual({ opened: true })
    expect(open).toHaveBeenCalledWith('https://app.example/approved/help', '_blank', 'noopener,noreferrer')
  })

  it('does not approve lookalike hosts with parsed deep-link rules', async () => {
    const open = vi.fn()
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      window: { open },
      approvedDeepLinks: ['https://trusted.example'],
      allowCurrentOriginDeepLinks: false,
    }))
    const entry = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(entry?.handler(callInput({ url: 'https://trusted.example.evil' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    await expect(entry?.handler(callInput({ url: 'https://trusted.example/?from=aurora' }))).resolves.toEqual({ opened: true })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('requires exact paths unless the approved route is a deliberate subtree', async () => {
    const exactOpen = vi.fn()
    const exact = createBrowserNativeCapabilityPack(fullOptions({
      window: { open: exactOpen },
      approvedDeepLinks: ['https://trusted.example/app'],
      allowCurrentOriginDeepLinks: false,
    }))
    const exactEntry = exact.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(exactEntry?.handler(callInput({ url: 'https://trusted.example/application' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    await expect(exactEntry?.handler(callInput({ url: 'https://trusted.example/app?next=1#section' }))).resolves.toEqual({ opened: true })

    const subtreeOpen = vi.fn()
    const subtree = createBrowserNativeCapabilityPack(fullOptions({
      window: { open: subtreeOpen },
      approvedDeepLinks: ['https://trusted.example/app/'],
      allowCurrentOriginDeepLinks: false,
    }))
    const subtreeEntry = subtree.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(subtreeEntry?.handler(callInput({ url: 'https://trusted.example/app/child?next=1' }))).resolves.toEqual({ opened: true })
    await expect(subtreeEntry?.handler(callInput({ url: 'https://trusted.example/application' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
  })

  it('does not advertise deep links when configured rules are invalid or unsafe', () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      window: { open: vi.fn() },
      approvedDeepLinks: ['not a url', 'javascript:alert(1)', 'https://user:pass@trusted.example/app'],
      allowCurrentOriginDeepLinks: false,
    }))

    expect(pack.registeredToolIds).not.toContain(AURORA_NATIVE_TOOL_IDS.openDeepLink)
  })

  it('allows bounded custom and contact routes with query variability only after the route', async () => {
    const open = vi.fn()
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      window: { open },
      approvedDeepLinks: ['aurora://open/task', 'mailto:support@example.com'],
      allowCurrentOriginDeepLinks: false,
    }))
    const entry = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(entry?.handler(callInput({ url: 'aurora://open/task?ticket=1' }))).resolves.toEqual({ opened: true })
    await expect(entry?.handler(callInput({ url: 'aurora://open/task-extra?ticket=1' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    await expect(entry?.handler(callInput({ url: 'mailto:support@example.com?subject=Aurora' }))).resolves.toEqual({ opened: true })
    await expect(entry?.handler(callInput({ url: 'mailto:support@example.com.evil?subject=Aurora' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
  })

  it('treats popup-blocked approved links as failed execution', async () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      window: { location: { origin: 'https://app.example', href: 'https://app.example/' }, open: () => null },
      approvedDeepLinks: ['https://app.example/approved/'],
    }))
    const entry = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.openDeepLink)

    await expect(entry?.handler(callInput({ url: 'https://app.example/approved/help' }))).rejects.toMatchObject({ reasonCode: 'user_activation_required' })
  })

  it('uses opaque session document grants for picker, read, and write', async () => {
    let written = ''
    const handle: BrowserFileHandle = {
      name: '/Users/alice/private/report.txt',
      getFile: async () => ({ name: 'report.txt', type: 'text/plain', text: async () => 'report body' }),
      createWritable: async () => ({
        write: async (content) => {
          written = content
        },
        close: vi.fn(),
      }),
    }
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      filePicker: { showOpenFilePicker: async () => [handle] },
      randomId: () => 'grant_1234567890abcdef',
    }))
    const pick = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.pickDocument)!
    const read = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.readGrantedDocument)!
    const write = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.writeGrantedDocument)!

    const picked = await pick.handler(callInput({}))
    expect(picked).toEqual({ documents: [{ documentId: 'doc_grant_1234567890abcdef', name: 'report.txt' }] })

    await expect(read.handler(callInput({ documentId: '/Users/alice/private/report.txt' }))).rejects.toMatchObject({ reasonCode: 'permission_denied' })
    await expect(read.handler(callInput({ documentId: 'doc_grant_1234567890abcdef' }))).resolves.toEqual({ content: 'report body', mimeType: 'text/plain' })
    await expect(write.handler(callInput({ documentId: 'doc_grant_1234567890abcdef', content: 'updated' }))).resolves.toEqual({ written: true })
    expect(written).toBe('updated')
  })

  it('mints opaque document grant IDs from crypto.getRandomValues when randomUUID is unavailable', async () => {
    const handle: BrowserFileHandle = {
      name: 'grant.txt',
      getFile: async () => ({ name: 'grant.txt', type: 'text/plain', text: async () => 'grant' }),
    }
    const pack = createBrowserNativeCapabilityPack(withoutInjectedRandomId(fullOptions({
      filePicker: { showOpenFilePicker: async () => [handle] },
      crypto: {
        getRandomValues: (array) => {
          const bytes = array as unknown as Uint8Array
          bytes.fill(0x2a)
          return array
        },
      },
    })))
    const pick = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.pickDocument)!

    await expect(pick.handler(callInput({}))).resolves.toEqual({
      documents: [{ documentId: 'doc_KioqKioqKioqKioqKioqKioqKioqKioq', name: 'grant.txt' }],
    })
  })

  it('fails closed when no secure RNG can mint opaque document grant IDs', async () => {
    const pack = createBrowserNativeCapabilityPack(withoutInjectedRandomId(fullOptions({
      crypto: {},
    })))
    const pick = pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.pickDocument)!

    await expect(pick.handler(callInput({}))).rejects.toMatchObject({
      name: 'LocalToolHandlerError',
      reasonCode: 'capability_unavailable',
      message: 'Tool execution failed',
    })
  })

  it('preserves Web API receivers for share, picker, and clipboard methods', async () => {
    const navigator = {
      share(data: ShareData) {
        expect(this).toBe(navigator)
        expect(data.text).toBe('hello')
        return Promise.resolve()
      },
      canShare() {
        expect(this).toBe(navigator)
        return true
      },
      clipboard: {
        readText() {
          expect(this).toBe(navigator.clipboard)
          return Promise.resolve('receiver clip')
        },
        writeText(text: string) {
          expect(this).toBe(navigator.clipboard)
          expect(text).toBe('updated')
          return Promise.resolve()
        },
      },
      onLine: true,
    }
    const filePicker = {
      showOpenFilePicker() {
        expect(this).toBe(filePicker)
        return Promise.resolve([{
          name: 'receiver.txt',
          getFile: async () => ({ name: 'receiver.txt', type: 'text/plain', text: async () => 'receiver' }),
        }] satisfies BrowserFileHandle[])
      },
    }
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      navigator,
      filePicker,
      randomId: () => 'receiver12345678',
    }))

    await expect(pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.shareText)?.handler(callInput({ text: 'hello' }))).resolves.toEqual({ shared: true })
    await expect(pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.pickDocument)?.handler(callInput({}))).resolves.toEqual({
      documents: [{ documentId: 'doc_receiver12345678', name: 'receiver.txt' }],
    })
    await expect(pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.getClipboardText)?.handler(callInput({}))).resolves.toEqual({ text: 'receiver clip' })
    await expect(pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.setClipboardText)?.handler(callInput({ text: 'updated' }))).resolves.toEqual({ written: true })
  })

  it('does not expose raw paths, arbitrary protocols, shell, process, or direct handles', async () => {
    const pack = createBrowserNativeCapabilityPack(fullOptions({
      filePicker: {
        showOpenFilePicker: async () => [{
          name: 'C:\\Users\\alice\\secret.txt',
          getFile: async () => ({ name: 'secret.txt', type: 'text/plain', text: async () => 'safe content' }),
        }],
      },
      randomId: () => 'opaqueid123456789',
    }))
    const serializedCatalog = JSON.stringify(pack.registry.publicTools())
    const serializedManifest = JSON.stringify(pack.manifest)

    expect(serializedCatalog).not.toMatch(/\b(shell|processSpawn|process|file:\/\/|C:\\|\/Users\/alice|direct handle)\b/i)
    expect(serializedManifest).not.toMatch(/\b(shell|processSpawn|process|file:\/\/|C:\\|\/Users\/alice|direct handle)\b/i)

    const picked = await pack.registry.resolveForDispatch(AURORA_NATIVE_TOOL_IDS.pickDocument)?.handler(callInput({}))
    expect(JSON.stringify(picked)).not.toMatch(/C:\\|\/Users\/alice|handle/i)
    expect(JSON.stringify(picked)).toContain('secret.txt')
  })
})

function fullOptions(overrides: Partial<BrowserNativeCapabilityPackOptions> = {}): BrowserNativeCapabilityPackOptions {
  return {
    stablePeerId: 'peer-browser',
    navigator: {
      clipboard: { readText: async () => 'clip', writeText: vi.fn() },
      share: vi.fn(),
      canShare: () => true,
      onLine: true,
      getBattery: async () => ({ level: 2, charging: false }),
    },
    notification: { permission: 'granted', show: vi.fn() },
    window: { location: { origin: 'https://app.example', href: 'https://app.example/' }, open: vi.fn() },
    filePicker: {
      showOpenFilePicker: async () => [{
        name: 'note.txt',
        getFile: async () => ({ name: 'note.txt', type: 'text/plain', text: async () => 'note' }),
        createWritable: async () => ({ write: vi.fn(), close: vi.fn() }),
      }],
    },
    approvedDeepLinks: ['https://app.example/'],
    permissionStates: {
      'clipboard-read': 'granted',
      'clipboard-write': 'granted',
      'document-write': 'granted',
    },
    randomId: () => 'grant1234567890ab',
    now: () => '2026-07-29T00:00:00.000Z',
    ...overrides,
  }
}

function withoutInjectedRandomId(options: BrowserNativeCapabilityPackOptions): BrowserNativeCapabilityPackOptions {
  const { randomId: _randomId, ...rest } = options
  return rest
}

function callInput(arguments_: JsonObject) {
  return {
    arguments: arguments_,
    signal: new AbortController().signal,
    correlationId: 'corr-1',
    context: executionContext,
  }
}

function providerFor(pack: ReturnType<typeof createBrowserNativeCapabilityPack>) {
  const policy = new LocalToolExecutionPolicy({
    providerPeerId: 'peer-browser',
    providerServiceInstanceId: 'local:peer-browser:Tooling',
    randomToken: () => 'fixed',
    nowMs: () => 1_000,
    ports: allowPorts(),
  })
  return {
    policy,
    provider: createLocalToolingProviderHandlers({
      registry: pack.registry,
      policy,
      providerPeerId: 'peer-browser',
      serviceInstanceId: 'local:peer-browser:Tooling',
      audit: () => undefined,
      exportDecision: { isShared: () => true },
    }),
  }
}

async function approvalFor(
  policy: LocalToolExecutionPolicy,
  pack: ReturnType<typeof createBrowserNativeCapabilityPack>,
  toolName: string,
  arguments_: JsonObject,
): Promise<string> {
  const request = { tool_name: toolName, arguments: arguments_ }
  const entry = pack.registry.resolveForDispatch(toolName)
  if (!entry) throw new Error(`missing tool ${toolName}`)
  const prepared = await policy.prepare(entry, request, executionContext)
  return policy.issueApprovalToken(prepared, request, executionContext)
}

function allowPorts() {
  return {
    hasMethodGrant: (methodId: string) => methodId === 'Tooling.ExecuteTool',
    hasToolGrant: () => true,
    hasCapabilityGrant: () => true,
    hasResourceGrant: () => true,
  }
}

function peerContext(permissions: string[]) {
  return {
    id: 'call-1',
    methodId: 'Tooling.ExecuteTool',
    remotePeerId: 'peer-caller',
    identity: {
      callerPeerId: 'peer-caller',
      principalId: 'principal-1',
      effectivePermissions: permissions,
      authGrantRevision: 1,
      manifestRevision: 1,
    },
    signal: new AbortController().signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000,
  }
}
