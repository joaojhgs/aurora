import type { Metadata } from 'next'
import '@aurora/ui/styles.css'
import './globals.css'
import { PathAwareShell } from './path-aware-shell'
import { getShellSnapshot } from './shell-state'

export const metadata: Metadata = {
  title: 'Aurora',
  description: 'Aurora production assistant and operator shell'
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const snapshot = await getShellSnapshot()
  return (
    <html lang="en">
      <body>
        <PathAwareShell snapshot={snapshot}>{children}</PathAwareShell>
      </body>
    </html>
  )
}
