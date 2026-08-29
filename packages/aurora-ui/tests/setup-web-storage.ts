class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>()

  get length(): number {
    return this.#values.size
  }

  clear(): void {
    this.#values.clear()
  }

  getItem(key: string): string | null {
    return this.#values.get(String(key)) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.#values.delete(String(key))
  }

  setItem(key: string, value: string): void {
    this.#values.set(String(key), String(value))
  }
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  if (typeof window === 'undefined' || window[name]) return
  Object.defineProperty(window, name, {
    configurable: true,
    value: new MemoryStorage(),
  })
}

ensureStorage('localStorage')
ensureStorage('sessionStorage')
