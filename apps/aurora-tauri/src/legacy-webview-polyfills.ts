type ArrayAtPrototype = {
  at?: (this: unknown[], index: number) => unknown
}

export function installLegacyWebViewPolyfills(
  prototype: ArrayAtPrototype = Array.prototype,
): void {
  if (typeof prototype.at === 'function') return

  Object.defineProperty(prototype, 'at', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(this: unknown[], index: number): unknown {
      const numericIndex = Number(index)
      if (numericIndex === Infinity || numericIndex === -Infinity) {
        return undefined
      }
      const integerIndex = Number.isNaN(numericIndex)
        ? 0
        : Math.trunc(numericIndex)
      const resolvedIndex =
        integerIndex < 0 ? this.length + integerIndex : integerIndex
      if (resolvedIndex < 0 || resolvedIndex >= this.length) return undefined
      return this[resolvedIndex]
    },
  })
}

installLegacyWebViewPolyfills()
