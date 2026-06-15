'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronsUpDown, Lock, Menu, PanelRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { mobileTabs, navSections } from '@/lib/aurora/nav'
import { deploymentSummary } from '@/lib/aurora/data'
import {
  HealthBadge,
  IdentityBadge,
  ModeBadge,
  PrivacyBadge,
  RouteBadge,
} from './status-badges'
import { ActivityRail } from './activity-rail'

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-5 px-3 py-4">
      {navSections.map((section) => (
        <div key={section.label}>
          <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {section.label}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.adminGated && (
                      <Lock className="size-3 text-muted-foreground/60" aria-hidden />
                    )}
                    {item.badge && (
                      <Badge
                        variant="secondary"
                        className="h-5 min-w-5 justify-center rounded-full bg-warning/15 px-1 text-warning"
                      >
                        {item.badge}
                      </Badge>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function BrandHeader() {
  return (
    <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Sparkles className="size-4.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight">Aurora</p>
        <p className="truncate text-xs text-muted-foreground">{deploymentSummary.nodeName}</p>
      </div>
      <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [railOpen, setRailOpen] = useState(true)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        {/* Desktop sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar lg:flex">
          <BrandHeader />
          <ScrollArea className="flex-1">
            <NavLinks />
          </ScrollArea>
          <div className="border-t p-3">
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-2">
              <div className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                AD
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">admin</p>
                <p className="truncate text-[11px] text-muted-foreground">Full access</p>
              </div>
              <IdentityBadge identity={deploymentSummary.identity} />
            </div>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
            {/* Mobile menu */}
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <BrandHeader />
                <ScrollArea className="h-[calc(100dvh-8rem)]">
                  <NavLinks />
                </ScrollArea>
              </SheetContent>
            </Sheet>

            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
              <ModeBadge mode={deploymentSummary.mode} />
              <RouteBadge route={deploymentSummary.route} />
              <PrivacyBadge privacy={deploymentSummary.privacy} />
              <HealthBadge health={deploymentSummary.health} className="hidden sm:inline-flex" />
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <span className="hidden items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground md:inline-flex">
                {deploymentSummary.version}
                <span className="text-success">· {deploymentSummary.uptime}</span>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden xl:inline-flex"
                    onClick={() => setRailOpen((v) => !v)}
                    aria-label="Toggle activity rail"
                  >
                    <PanelRight className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Toggle activity rail</TooltipContent>
              </Tooltip>
            </div>
          </header>

          {/* Content + rail */}
          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">{children}</main>
            {railOpen && <ActivityRail className="hidden w-72 shrink-0 xl:flex" />}
          </div>
        </div>

        {/* Mobile bottom tabs */}
        <MobileTabs />
      </div>
    </TooltipProvider>
  )
}

function MobileTabs() {
  const pathname = usePathname()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-sidebar/95 backdrop-blur lg:hidden">
      {mobileTabs.map((tab) => {
        const active = pathname === tab.href
        const Icon = tab.icon
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
