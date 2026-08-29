import { describe, expect, it } from 'vitest'

import {
  buildMessageProvenance,
  createLocalConversations,
  createLocalLightweightMemory,
  LocalDataError,
  MemoryLocalDataBackend,
  searchLocalData
} from '@aurora/client/local-data'

describe('local-data package boundary', () => {
  it('publishes product local-data APIs through the package subpath', async () => {
    const scope = { profileId: 'profile-1', localNodeId: 'node-1' }
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)

    expect(createLocalConversations(session)).toMatchObject({
      listConversations: expect.any(Function),
      appendMessage: expect.any(Function)
    })
    expect(createLocalLightweightMemory(session)).toMatchObject({
      listMemoryItems: expect.any(Function),
      upsertMemoryItem: expect.any(Function)
    })
    expect(searchLocalData).toBeTypeOf('function')
    expect(buildMessageProvenance).toBeTypeOf('function')
    expect(LocalDataError).toBeTypeOf('function')
  })
})
