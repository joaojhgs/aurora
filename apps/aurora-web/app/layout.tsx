import type { Metadata } from 'next'
import '@aurora/ui/styles.css'
import './globals.css'
import { DebugUiIndicator } from './debug-ui-host'
import { PathAwareShell } from './path-aware-shell'
import { PwaRegistration } from './pwa-registration'
import { getShellSnapshot } from './shell-state'

export const metadata: Metadata = {
  title: 'Aurora',
  description: 'Aurora production assistant and operator shell',
  manifest: '/manifest.webmanifest'
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const snapshot = await getShellSnapshot()
  return (
    <html lang="en">
      <body>
        <PwaRegistration />
        {process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_AURORA_DEBUG_UI === '1'
          ? <DebugUiIndicator />
          : null}
        <PathAwareShell snapshot={snapshot}>{children}</PathAwareShell>
      </body>
    </html>
  )
}
