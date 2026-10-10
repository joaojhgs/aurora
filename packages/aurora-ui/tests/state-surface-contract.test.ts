import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auroraFeatureDefinitions, type AuroraFeatureId } from '../src/feature-manifest'
import { STANDARD_STATE_SURFACE_CONTRACT } from '../src/state-surface'

const uiSrc = join(process.cwd(), 'src')
const manifestSource = readFileSync(join(uiSrc, 'feature-manifest.tsx'), 'utf8')

type RouteStateKind = 'loading' | 'empty' | 'error' | 'permission' | 'pending' | 'disabled'

interface RouteStateContract {
  files?: readonly string[]
  requires: readonly string[]
  states: readonly RouteStateKind[]
  forbids?: readonly string[]
}

const ROUTE_STATE_CONTRACT: Record<AuroraFeatureId, RouteStateContract> = {
  assistant: {
    files: ['assistant-view.tsx', 'assistant-history.tsx', 'assistant-status.tsx', 'use-assistant-history.ts', 'assistant-composer.tsx', 'assistant-message.tsx'],
    requires: ['ConversationRail', 'AssistantRuntimeStrip', 'resolveLocalAssistantHistoryDependencies'],
    states: ['pending', 'error'],
    forbids: ['Waiting for Aurora'],
  },
  memory: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission'],
  },
  tools: {
    files: ['tool-approval-panel.tsx', 'tooling/tooling-console.tsx', 'tooling/tool-sharing-controls.tsx'],
    requires: ['ToolingConsole', 'RouteStateNotice', 'SurfaceSkeleton', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'pending', 'disabled'],
  },
  mesh: {
    files: ['mesh-peers-view.tsx', 'mesh-peers-shared.tsx'],
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  admin: {
    requires: ['RouteStateNotice', 'SurfaceSkeleton', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission'],
  },
  services: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  config: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'disabled'],
  },
  'spoken-replies': {
    files: ['voice-settings-view.tsx', 'voice-settings-server-sections.tsx', 'voice-settings-local-speech-section.tsx', 'voice-settings-managed-voices-section.tsx'],
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'disabled'],
  },
  access: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'permission', 'pending'],
  },
  tokens: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  backups: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  scheduler: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  audit: {
    requires: ['RouteStateNotice', 'EmptyState'],
    // Export is a synchronous local download; query loading covers async work.
    states: ['loading', 'empty', 'error', 'permission', 'disabled'],
  },
  models: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  settings: {
    files: ['settings-view.tsx', 'settings-permissions-view.tsx'],
    requires: ['SettingsPermissionsView', 'StatusBadge', 'RouteStateNotice', 'SurfaceSkeleton', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  onboarding: {
    requires: ['OnboardingSetupStep', 'setupSteps(', 'role="alert"'],
    states: ['error', 'permission', 'pending', 'disabled'],
  },
  devices: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  contracts: {
    requires: ['RouteStateNotice'],
    states: ['loading', 'empty', 'error', 'disabled'],
  },
  plugins: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'disabled'],
  },
  pairing: {
    requires: ['RouteStateNotice', 'SurfaceSkeleton', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  diagnostics: {
    files: ['mesh-diagnostics-resource.tsx', 'mesh-diagnostics-view.tsx'],
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  data: {
    requires: ['RouteStateNotice', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
  native: {
    files: ['settings-native-view.tsx', 'settings-permissions-view.tsx'],
    requires: ['SettingsPermissionsView', 'StatusBadge', 'RouteStateNotice', 'SurfaceSkeleton', 'EmptyState'],
    states: ['loading', 'empty', 'error', 'permission', 'pending', 'disabled'],
  },
}

const STATE_PATTERNS: Record<RouteStateKind, readonly RegExp[]> = {
  loading: [
    /<SurfaceSkeleton\b/u,
    /<RouteStateNotice[\s\S]{0,240}state="loading"/u,
    /<StateSurface[\s\S]{0,240}state="loading"/u,
    /\bloadState:\s*['"]loading['"]/u,
    /\bloadState\s*={2,3}\s*['"]loading['"]/u,
    /\bmodel\.state\s*={2,3}\s*['"]loading['"]/u,
  ],
  empty: [
    /<EmptyState\b/u,
    /<RouteStateNotice[\s\S]{0,240}state="empty"/u,
    /<StateSurface[\s\S]{0,240}state="empty"/u,
  ],
  error: [
    /<RouteStateNotice[\s\S]{0,240}state="error"/u,
    /<RouteStateNotice[\s\S]{0,240}state=\{[^}\n]*[?:]\s*['"]error['"]/u,
    /<StateSurface[\s\S]{0,240}state="error"/u,
    /role="alert"/u,
  ],
  permission: [
    /<RouteStateNotice[\s\S]{0,240}state="permission"/u,
    /<RouteStateNotice[\s\S]{0,240}state=\{[^}\n]*[?:]\s*['"]permission['"]/u,
    /state:\s*'privacy-blocked'/u,
    /state\s*===\s*'privacy-blocked'/u,
    /privacyClass/u,
  ],
  pending: [
    /\b(?:loadState|state|status|mutationState):\s*['"]pending['"]/u,
    /\b(?:loadState|state|status|mutationState)\s*={2,3}\s*['"]pending['"]/u,
    /pending[A-Za-z0-9_]*\s*=\{/u,
    /aria-busy=\{/u,
    /busy=\{/u,
    /data-state=\{[\s\S]{0,120}pending/u,
    /requesting[A-Za-z0-9_]+/u,
    /mutationState/u,
    /pendingApprovals/u,
    /sharingPendingKey/u,
  ],
  disabled: [
    /disabled=\{/u,
    /disabledReason=\{/u,
    /route\.disabled/u,
    /disabled:\s*(true|false)/u,
  ],
}

function manifestComponentFile(routeId: AuroraFeatureId): string {
  const match = manifestSource.match(new RegExp(`feature\\('${routeId}'[\\s\\S]*?import\\('\\./([^']+)'\\)`))
  if (!match?.[1]) throw new Error(`Missing component import for ${routeId}`)
  return `${match[1]}.tsx`
}

function routeSource(routeId: AuroraFeatureId): string {
  const contract = ROUTE_STATE_CONTRACT[routeId]
  const files = contract.files ?? [manifestComponentFile(routeId)]
  return files
    .map((file) => join(uiSrc, file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
}

function rendersState(source: string, state: RouteStateKind): boolean {
  if (STATE_PATTERNS[state].some((pattern) => pattern.test(source))) return true
  // Notices may derive their state from a named conditional expression. Check
  // only expressions actually bound to a rendered notice, not unrelated data.
  for (const match of source.matchAll(/<(?:RouteStateNotice|StateSurface)\b[^>]*\bstate=\{([A-Za-z_$][\w$]*)\}/gu)) {
    const assignment = source.match(new RegExp(`\\bconst\\s+${match[1]}\\s*=\\s*([^;]+);`, 'u'))?.[1]
    if (assignment && new RegExp(`[?:]\\s*['"]${state}['"]`, 'u').test(assignment)) return true
  }
  return false
}

describe('standard state-surface adoption', () => {
  it('keeps the shared state contract explicit for route views', () => {
    expect(STANDARD_STATE_SURFACE_CONTRACT.primitives).toContain('RouteStateNotice')
    expect(STANDARD_STATE_SURFACE_CONTRACT.primitives).toContain('EmptyState')
    expect(STANDARD_STATE_SURFACE_CONTRACT.forbiddenSpinOnlyPatterns).toContain('animate-spin')
  })

  it('keeps every manifest route covered by an explicit UX state contract', () => {
    expect(Object.keys(ROUTE_STATE_CONTRACT).sort()).toEqual(
      auroraFeatureDefinitions.map((definition) => definition.id).sort(),
    )
  })

  it('keeps every route wired to actual loading, empty, error, or pending UX states', () => {
    for (const definition of auroraFeatureDefinitions) {
      const contract = ROUTE_STATE_CONTRACT[definition.id]
      const source = routeSource(definition.id)

      for (const required of contract.requires) {
        expect(source, `${definition.id} requires ${required}`).toContain(required)
      }

      for (const state of contract.states) {
        expect.soft(
          rendersState(source, state),
          `${definition.id} renders ${state} state affordance`,
        ).toBe(true)
      }

      for (const forbidden of [...STANDARD_STATE_SURFACE_CONTRACT.forbiddenSpinOnlyPatterns, ...(contract.forbids ?? [])]) {
        expect(source, `${definition.id} forbids ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})
