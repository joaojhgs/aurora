import type { AuthenticatedPeerContext, PeerAuthorityResolver } from '../peer-host/authority.js'
import type { LocalToolPolicyPorts } from './execution-policy.js'
import type { LocalToolExecutionContext } from './tool-registry.js'

export interface PeerAuthorityLocalToolPolicyPortsOptions {
  readonly resolver: PeerAuthorityResolver
  readonly providerPeerId: string
}

export function createPeerAuthorityLocalToolPolicyPorts(options: PeerAuthorityLocalToolPolicyPortsOptions): LocalToolPolicyPorts {
  return {
    hasMethodGrant: (methodId, context) => resolveDimensionGrant(options, context, { methodId }),
    hasToolGrant: (toolContractId, context) => resolveDimensionGrant(options, context, { toolContractId }),
    hasCapabilityGrant: (capabilityPackId, context) => resolveDimensionGrant(options, context, { capabilityPackId }),
    hasResourceGrant: (resourceScope, context) => resolveDimensionGrant(options, context, { resourceScope })
  }
}

async function resolveDimensionGrant(
  options: PeerAuthorityLocalToolPolicyPortsOptions,
  context: LocalToolExecutionContext,
  dimension: {
    readonly methodId?: string
    readonly toolContractId?: string
    readonly capabilityPackId?: string
    readonly resourceScope?: string
  }
): Promise<boolean> {
  const authenticated = authenticatedContextForCaller(context, options.providerPeerId)
  if (authenticated === undefined) return false
  try {
    const decision = await options.resolver.resolveGrant(authenticated, {
      ...dimension,
      nowMs: context.nowMs
    })
    return decision.allowed
  } catch {
    return false
  }
}

function authenticatedContextForCaller(context: LocalToolExecutionContext, providerPeerId: string): AuthenticatedPeerContext | undefined {
  const authenticated = context.authenticatedPeerContext
  if (authenticated === undefined) return undefined
  if (authenticated.selector.claimantPeerId !== context.callerPeerId) return undefined
  if (authenticated.selector.verifierPeerId !== providerPeerId) return undefined
  return authenticated
}
