import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@aurora/ui-mock-reference'

export function Default() {
  useEffect(() => {
    toast('Diagnostics export queued (mock)', { duration: Infinity })
  }, [])
  return (
    <div className="rounded-lg bg-background p-6 text-foreground" style={{ minHeight: 200 }}>
      <Toaster position="bottom-right" />
    </div>
  )
}

export function Success() {
  useEffect(() => {
    toast.success('Device paired successfully', {
      description: 'Pixel 9 Pro joined the mesh with trusted status.',
      duration: Infinity,
    })
  }, [])
  return (
    <div className="rounded-lg bg-background p-6 text-foreground" style={{ minHeight: 200 }}>
      <Toaster position="bottom-right" />
    </div>
  )
}

export function ErrorState() {
  useEffect(() => {
    toast.error('Mesh sync failed', {
      description: 'office-relay-04 did not respond within the timeout window.',
      duration: Infinity,
    })
  }, [])
  return (
    <div className="rounded-lg bg-background p-6 text-foreground" style={{ minHeight: 200 }}>
      <Toaster position="bottom-right" />
    </div>
  )
}
