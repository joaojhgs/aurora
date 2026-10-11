import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  DB_METHODS,
  MockAuroraTransport,
  type AuroraTransportRequest,
  type DBSessionRecord
} from '../src/index.js'

const session: DBSessionRecord = {
  id: 'chat-1',
  principal_id: 'user-a',
  type: 'chat',
  title: 'Planning',
  created_at: '2026-07-11T12:00:00+00:00',
  updated_at: '2026-07-11T12:01:00+00:00',
  last_active_at: '2026-07-11T12:01:00+00:00',
  message_count: 2
}

describe('MemoryClient chat sessions', () => {
  it('forwards cancellation to every session operation and rejects aborted calls before dispatch', async () => {
    const signals: Array<AbortSignal | undefined> = []
    const transport = MockAuroraTransport.empty()
    for (const method of [DB_METHODS.createSession, DB_METHODS.listSessions, DB_METHODS.getSession, DB_METHODS.setActiveSession]) {
      transport.register(method, (request) => {
        signals.push(request.signal)
        return { session, sessions: [session], messages: [], active_session_id: session.id, total: 1 }
      })
    }
    const client = new AuroraClient({ transport })
    const controller = new AbortController()
    const operations = [
      () => client.memory.createSession({ type: 'chat' }, { signal: controller.signal }),
      () => client.memory.listSessions({}, { signal: controller.signal }),
      () => client.memory.getSession({ session_id: session.id }, { signal: controller.signal }),
      () => client.memory.setActiveSession({ session_id: session.id }, { signal: controller.signal }),
    ]
    for (const operation of operations) await operation()
    expect(signals).toEqual(Array(4).fill(controller.signal))
    controller.abort()
    for (const operation of operations) await expect(operation()).rejects.toMatchObject({ name: 'AbortError' })
    expect(signals).toHaveLength(4)
  })

  it('routes typed session operations through the principal-scoped DB API', async () => {
    const calls: Array<{ method: string; path: string | undefined; payload: unknown }> = []
    const record = (request: AuroraTransportRequest) => {
      calls.push({ method: request.method, path: request.path, payload: request.payload })
      return { session }
    }
    const transport = MockAuroraTransport.empty()
      .register(DB_METHODS.createSession, record)
      .register(DB_METHODS.listSessions, (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return { sessions: [session], active_session_id: session.id, total: 1 }
      })
      .register(DB_METHODS.getSession, (request) => {
        calls.push({ method: request.method, path: request.path, payload: request.payload })
        return {
          session,
          messages: [
            {
              id: 1,
              role: 'user',
              content: 'Persist me',
              message_type: 'USER_TEXT',
              timestamp: session.created_at,
              session_id: session.id,
              metadata: {},
              source_type: 'Text'
            }
          ]
        }
      })
      .register(DB_METHODS.setActiveSession, record)
    const client = new AuroraClient({ transport })

    const created = await client.memory.createSession({ type: 'chat', title: 'Planning' })
    const listed = await client.memory.listSessions({ type: 'chat' })
    const loaded = await client.memory.getSession({ session_id: session.id, activate: true })
    const activated = await client.memory.setActiveSession({ session_id: session.id })

    expect(created.ok && created.data.session.type).toBe('chat')
    expect(listed.ok && listed.data.active_session_id).toBe(session.id)
    expect(loaded.ok && loaded.data.messages[0]?.content).toBe('Persist me')
    expect(activated.ok && activated.data.session.id).toBe(session.id)
    expect(calls).toEqual([
      {
        method: DB_METHODS.createSession,
        path: '/api/DB/CreateSession',
        payload: { type: 'chat', title: 'Planning' }
      },
      {
        method: DB_METHODS.listSessions,
        path: '/api/DB/ListSessions',
        payload: { type: 'chat' }
      },
      {
        method: DB_METHODS.getSession,
        path: '/api/DB/GetSession',
        payload: { session_id: session.id, activate: true }
      },
      {
        method: DB_METHODS.setActiveSession,
        path: '/api/DB/SetActiveSession',
        payload: { session_id: session.id }
      }
    ])
  })
})
