import type { GetRegistryResponse, MethodDescriptor, MethodInfo } from './types.js'

export const GATEWAY_METHODS = {
  getRegistry: 'Gateway.GetRegistry',
  getServices: 'Gateway.GetServices',
  getServiceHealth: 'Gateway.GetServiceHealth',
  getMeshStatus: 'Gateway.GetMeshStatus',
  getCapabilityGraph: 'Gateway.GetCapabilityGraph',
  getCapabilityCatalog: 'Gateway.GetCapabilityCatalog',
  explainRoute: 'Gateway.ExplainRoute',
  listEvents: 'Gateway.ListEvents',
  getSupportBundle: 'Gateway.GetSupportBundle'
} as const

export const TOOLING_METHODS = {
  listCatalog: 'Tooling.GetToolCatalog',
  prepareExecution: 'Tooling.PrepareExecution',
  requestApproval: 'Tooling.RequestApproval',
  confirmExecution: 'Tooling.ConfirmExecution',
  executeTool: 'Tooling.ExecuteTool'
} as const

export function routePath(module: string, method: string): string {
  return `/api/${encodeURIComponent(module)}/${encodeURIComponent(method)}`
}

export function methodIdentity(module: string, method: Pick<MethodInfo, 'name' | 'bus_topic'>): string {
  return method.bus_topic ?? `${module}.${method.name}`
}

export function describeRegistry(registry: GetRegistryResponse): MethodDescriptor[] {
  return registry.modules.flatMap((moduleInfo) =>
    moduleInfo.methods.map((method) => describeMethod(moduleInfo.module, method))
  )
}

export function describeMethod(module: string, method: MethodInfo): MethodDescriptor {
  const busTopic = methodIdentity(module, method)
  const availableOverHttp = method.exposure === 'external' || method.exposure === 'both'
  return {
    module,
    name: method.name,
    busTopic,
    routePath: availableOverHttp ? routePath(module, method.name) : null,
    exposure: method.exposure,
    methodType: method.method_type,
    summary: method.summary,
    inputModel: method.input_model,
    outputModel: method.output_model,
    requiredPermissions: [...method.required_perms],
    inputSchema: method.input_schema ?? null,
    outputSchema: method.output_schema ?? null,
    availableOverHttp
  }
}
