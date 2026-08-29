"use client"

import * as React from "react"

const MOBILE_BREAKPOINT = 768
const DEBUG_COMPACT_ATTR = "data-aurora-debug-compact"

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const sync = () => {
      setIsMobile(readIsMobileLayout(mql))
    }
    mql.addEventListener("change", sync)
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [DEBUG_COMPACT_ATTR] })
    sync()
    return () => {
      mql.removeEventListener("change", sync)
      observer.disconnect()
    }
  }, [])

  return !!isMobile
}

function readIsMobileLayout(mql: MediaQueryList): boolean {
  if (document.documentElement.getAttribute(DEBUG_COMPACT_ATTR) === "phone") return true
  return mql.matches || window.innerWidth < MOBILE_BREAKPOINT
}
