import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import {
  AdminRbacView,
  buildAdminRbacSnapshot,
  buildRbacPermissionPatchAction
} from '../src/index'

describe('AdminRbacView', () => {
  it('renders roles, principals, permission matrix, audit status, and the honest Auth.ListRoles backend gap', async () => {
    const snapshot = await buildAdminRbacSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminRbacView snapshot={snapshot} />)

    expect(snapshot.principals.length).toBeGreaterThan(0)
    expect(snapshot.roles.length).toBeGreaterThan(0)
    expect(snapshot.permissions.length).toBeGreaterThan(0)
    expect(markup).toContain('Access and RBAC')
    expect(markup).toContain('Roles')
    expect(markup).toContain('Principals')
    expect(markup).toContain('Permission matrix')
    expect(markup).toContain('Recent access changes')
    expect(markup).toContain('Auth.ListRoles is not advertised')
    expect(markup).toContain('Preview patch')
    expect(markup).toContain('AdminAction')
  })

  it('builds permission patch AdminAction previews without secret payloads', () => {
    const action = buildRbacPermissionPatchAction(
      { id: 'principal-ops', username: 'ops', permissions: ['Gateway.use'] },
      { grant: ['Config.manage'], revoke: ['Gateway.use'], reason: 'least privilege update' }
    )

    expect(action.methodId).toBe('Auth.PatchPermissions')
    expect(action.payload).toEqual({
      user_id: 'principal-ops',
      grant: ['Config.manage'],
      revoke: ['Gateway.use']
    })
    expect(action.auditReason).toBe('least privilege update')
    expect(action.requiresAdminAction).toBe(true)
    expect(JSON.stringify(action)).not.toContain('secret')
  })
})
