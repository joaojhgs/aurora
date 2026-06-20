'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { AppShell, type AuroraShellSnapshot } from '@aurora/ui'

type PathAwareShellProps = {
  children: ReactNode
  snapshot: AuroraShellSnapshot
}

export function PathAwareShell({ children, snapshot }: PathAwareShellProps) {
  const pathname = usePathname()
  return (
    <AppShell snapshot={snapshot} currentPath={pathname ?? '/'}>
      {children}
    </AppShell>
  )
}
