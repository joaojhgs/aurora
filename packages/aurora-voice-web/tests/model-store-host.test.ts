import { describe, expect, it } from 'vitest'

import { MemoryWebModelStoreHost } from '../src/test-doubles/index.js'

describe('MemoryWebModelStoreHost', () => {
  it('mirrors the browser model store host boundary with atomic promotion', async () => {
    const host = new MemoryWebModelStoreHost(10)
    await host.writeJson('active/stt', '{"pack":"demo"}')
    expect(await host.listJsonKeys('active/')).toEqual(['active/stt'])
    expect(await host.readJson('active/stt')).toBe('{"pack":"demo"}')

    await host.appendStaging('pack-a@1#encoder', 0, new Uint8Array([1, 2]))
    await host.appendStaging('pack-a@1#encoder', 2, new Uint8Array([3]))
    expect(await host.stagingLen('pack-a@1#encoder')).toBe(3)
    expect(await host.readStagingChunk('pack-a@1#encoder', 1, 2)).toEqual({
      bytes: new Uint8Array([2, 3]),
      offset: 1,
      complete: true
    })

    await host.promoteStagingAtomic('pack-a@1#encoder')
    expect(await host.promotedStat('pack-a@1#encoder')).toMatchObject({ byteLength: 3 })
    expect(await host.listPromotedKeys()).toEqual(['pack-a@1#encoder'])
    expect((await host.persistenceReport()).usedBytes).toBe(3)
    await host.removePackData('pack-a')
    expect(await host.listPromotedKeys()).toEqual([])
  })

  it('enforces quota and append offsets in the fake host', async () => {
    const host = new MemoryWebModelStoreHost(2)
    await expect(host.appendStaging('pack-a@1#encoder', 1, new Uint8Array([1]))).rejects.toThrow('append_offset')
    await host.appendStaging('pack-a@1#encoder', 0, new Uint8Array([1, 2]))
    await expect(host.appendStaging('pack-a@1#joiner', 0, new Uint8Array([3]))).rejects.toThrow('quota')
    expect(await host.stagingLen('pack-a@1#joiner')).toBe(0)
    expect(() => new MemoryWebModelStoreHost(-1)).toThrow('quota')
    await expect(host.readStagingChunk('pack-a@1#encoder', -1, 1)).rejects.toThrow('offset')
    await expect(host.readStagingChunk('pack-a@1#encoder', 0, 0)).rejects.toThrow('max_bytes')
  })
})
