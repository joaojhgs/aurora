'use client'

import { useState } from 'react'
import { RouteSheet } from '@aurora/ui-mock-reference'

type RouteKind = 'Local' | 'Remote' | 'Mesh Peer' | 'Native Mobile' | 'Fallback' | 'Unknown'

export function Default() {
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState<RouteKind>('Local')

  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[900px] h-[700px]">
      <RouteSheet open={open} onOpenChange={setOpen} selected={selected} onSelect={setSelected} />
    </div>
  )
}
