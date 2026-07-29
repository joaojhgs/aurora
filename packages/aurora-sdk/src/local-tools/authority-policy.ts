import type { AuthenticatedPeerContext, PeerAuthorityResolver } from '../peer-host/authority.js'
import type { LocalToolPolicyPorts } from './execution-policy.js'
import type { LocalToolExecutionContext } from './tool-registry.js'

export function createPeerAuthorityLocalToolPolicyPorts(resolver: PeerAuthorityResolver): LocalToolPolicyPorts {
  return {
    hasMethodGrant: (methodId, context) => resolveDimensionGrant(resolver, context, { methodId }),
    hasToolGrant: (toolContractId, context) => resolveDimensionGrant(resolver, context, { toolContractId }),
    hasCapabilityGrant: (capabilityPackId, context) => resolveDimensionGrant(resolver, context, { capabilityPackId }),
    hasResourceGrant: (resourceScope, context) => resolveDimensionGrant(resolver, context, { resourceScope })
  }
}

async function resolveDimensionGrant(
  resolver: PeerAuthorityResolver,
  context: LocalToolExecutionContext,
  dimension: {
    readonly methodId?: string
    readonly toolContractId?: string
    readonly capabilityPackId?: string
    readonly resourceScope?: string
  }
): Promise<boolean> {
  const authenticated = authenticatedContextForCaller(context)
  if (authenticated === undefined) return false
  const decision = await resolver.resolveGrant(authenticated, {
    ...dimension,
    nowMs: context.nowMs
  })
  return decision.allowed
}

function authenticatedContextForCaller(context: LocalToolExecutionContext): AuthenticatedPeerContext | undefined {
  const authenticated = context.authenticatedPeerContext
  if (authenticated === undefined) return undefined
  if (authenticated.selector.claimantPeerId !== context.callerPeerId) return undefined
  return authenticated
}
