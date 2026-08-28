const BLOCK_BYTES = 64

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

export class IncrementalSha256 {
  readonly #state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ])
  readonly #buffer = new Uint8Array(BLOCK_BYTES)
  readonly #words = new Uint32Array(64)
  #bufferLength = 0
  #bytesHashed = 0
  #finished = false

  update(bytes: Uint8Array): this {
    if (this.#finished) throw new Error('incremental_sha256:already_finished')
    if (bytes.byteLength === 0) return this
    this.#bytesHashed += bytes.byteLength
    if (!Number.isSafeInteger(this.#bytesHashed)) throw new Error('incremental_sha256:input_too_large')

    let offset = 0
    if (this.#bufferLength > 0) {
      const take = Math.min(BLOCK_BYTES - this.#bufferLength, bytes.byteLength)
      this.#buffer.set(bytes.subarray(0, take), this.#bufferLength)
      this.#bufferLength += take
      offset = take
      if (this.#bufferLength === BLOCK_BYTES) {
        this.#compress(this.#buffer, 0)
        this.#bufferLength = 0
      }
    }
    while (offset + BLOCK_BYTES <= bytes.byteLength) {
      this.#compress(bytes, offset)
      offset += BLOCK_BYTES
    }
    if (offset < bytes.byteLength) {
      const tail = bytes.subarray(offset)
      this.#buffer.set(tail, 0)
      this.#bufferLength = tail.byteLength
    }
    return this
  }

  digestHex(): string {
    if (this.#finished) throw new Error('incremental_sha256:already_finished')
    this.#finished = true

    this.#buffer[this.#bufferLength] = 0x80
    this.#buffer.fill(0, this.#bufferLength + 1)
    if (this.#bufferLength >= 56) {
      this.#compress(this.#buffer, 0)
      this.#buffer.fill(0)
    }
    const bitLength = this.#bytesHashed * 8
    const view = new DataView(this.#buffer.buffer)
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false)
    view.setUint32(60, bitLength >>> 0, false)
    this.#compress(this.#buffer, 0)

    return Array.from(this.#state, (word) => word.toString(16).padStart(8, '0')).join('')
  }

  #compress(bytes: Uint8Array, offset: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, BLOCK_BYTES)
    for (let index = 0; index < 16; index += 1) this.#words[index] = view.getUint32(index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      this.#words[index] = (
        smallSigma1(this.#words[index - 2]!) +
        this.#words[index - 7]! +
        smallSigma0(this.#words[index - 15]!) +
        this.#words[index - 16]!
      ) >>> 0
    }
    let a = this.#state[0]!
    let b = this.#state[1]!
    let c = this.#state[2]!
    let d = this.#state[3]!
    let e = this.#state[4]!
    let f = this.#state[5]!
    let g = this.#state[6]!
    let h = this.#state[7]!
    for (let index = 0; index < 64; index += 1) {
      const first = (h + bigSigma1(e) + choice(e, f, g) + ROUND_CONSTANTS[index]! + this.#words[index]!) >>> 0
      const second = (bigSigma0(a) + majority(a, b, c)) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    this.#state[0] = (this.#state[0]! + a) >>> 0
    this.#state[1] = (this.#state[1]! + b) >>> 0
    this.#state[2] = (this.#state[2]! + c) >>> 0
    this.#state[3] = (this.#state[3]! + d) >>> 0
    this.#state[4] = (this.#state[4]! + e) >>> 0
    this.#state[5] = (this.#state[5]! + f) >>> 0
    this.#state[6] = (this.#state[6]! + g) >>> 0
    this.#state[7] = (this.#state[7]! + h) >>> 0
  }
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift))
}

function choice(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z)
}

function majority(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z)
}

function bigSigma0(value: number): number {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22)
}

function bigSigma1(value: number): number {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25)
}

function smallSigma0(value: number): number {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)
}

function smallSigma1(value: number): number {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)
}
