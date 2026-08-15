'use client'

import type { ReactNode } from 'react'
import type { PermissionCatalogEntry } from '@aurora/client'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { Switch } from '#components/ui/switch'
import { Badge } from '#components/ui/badge'
import { AdminConfirmDialog } from './primitives'

/**
 * Page-level tab bar matching the cockpit underline tab strip: Tools/Models/Settings/Admin
 * headers use a `border-bottom-width:2px` active indicator, not a pill/segmented control.
 * Thin wrapper over shadcn `Tabs` with `variant="line"`.
 */
export interface PageTabItem {
  value: string
  label: ReactNode
  content: ReactNode
}

export function PageTabs({
  items,
  value,
  onValueChange,
  className,
  ariaLabel
}: {
  items: PageTabItem[]
  value: string
  onValueChange: (value: string) => void
  className?: string
  ariaLabel?: string
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(String(next))} className={className}>
      <TabsList variant="line" className="w-full justify-start border-b border-border px-0" aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value} style={{ flex: 'none' }} className="rounded-none border-b-2 border-transparent px-3.5 py-2 data-active:border-primary data-active:bg-transparent data-active:shadow-none">
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}

/**
 * Plain confirm dialog: title + one-line description + Cancel/Confirm. This is the
 * "single plain confirm dialog... no elaborate justification flow" pattern the RBAC/
 * Tokens/Services/Backups screens all use - a thin ergonomic wrapper around the fuller
 * `AdminConfirmDialog` primitive (which still supports reason-capture for flows that
 * genuinely need it) so call sites don't have to pass a dozen unused props.
 */
export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', destructive, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <AdminConfirmDialog
      open={open}
      title={title}
      description={description}
      severity={destructive ? 'destructive' : 'standard'}
      confirmLabel={confirmLabel}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

/**
 * Role-template bundles used purely as a client-side naming/bulk-select convenience layer
 * over the real permission catalog - there is no backend Role resource (confirmed: `Auth`/
 * `AuthManager` only stores raw `permissions: string[]` per principal). Selecting a template
 * pre-checks the matching entries in whatever `PermissionCatalogEntry[]` was passed in;
 * "Custom" leaves the current selection untouched.
 */
export interface RoleTemplate {
  id: string
  name: string
  /** Permission ids to pre-check, or null for "Custom" (leave selection as-is). */
  permissions: string[] | null
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: 'guest', name: 'Guest', permissions: ['Orchestrator.use'] },
  { id: 'member', name: 'Member', permissions: ['Orchestrator.use', 'DB.use', 'Tooling.use'] },
  { id: 'automation', name: 'Automation', permissions: ['Scheduler.manage', 'Tooling.use'] },
  { id: 'admin', name: 'Admin', permissions: ['*'] },
  { id: 'custom', name: 'Custom', permissions: null }
]

/** Given a principal's exact permission set, find the matching role template (or 'custom'). */
export function matchRoleTemplate(permissions: string[]): string {
  const sorted = [...permissions].sort()
  const match = ROLE_TEMPLATES.find((template) => {
    if (!template.permissions) return false
    const templateSorted = [...template.permissions].sort()
    return templateSorted.length === sorted.length && templateSorted.every((permission, index) => permission === sorted[index])
  })
  return match ? match.id : 'custom'
}

/**
 * Shared permission-table-with-role-template-pills editor, used identically by Mesh's
 * pairing-review modal, Mesh's scopes modal, and Access & RBAC's role editor so the three
 * permission-editing UIs never drift apart (plan §5.2).
 */
export interface PermissionEditorTableProps {
  catalog: PermissionCatalogEntry[]
  checked: Record<string, boolean>
  roleTemplate: string
  onSelectRoleTemplate: (templateId: string) => void
  onToggle: (permissionId: string) => void
  showRoleTemplates?: boolean
  showPermissionIds?: boolean
}

export function PermissionEditorTable({ catalog, checked, roleTemplate, onSelectRoleTemplate, onToggle, showRoleTemplates = true, showPermissionIds = true }: PermissionEditorTableProps) {
  return (
    <div className="flex flex-col gap-3">
      {showRoleTemplates ? <div className="flex flex-wrap gap-1.5" role="group" aria-label="Role templates">
        {ROLE_TEMPLATES.map((template) => (
          <Badge
            key={template.id}
            variant={roleTemplate === template.id ? 'default' : 'outline'}
            className="cursor-pointer select-none"
            onClick={() => onSelectRoleTemplate(template.id)}
          >
            {template.name}
          </Badge>
        ))}
      </div> : null}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Permission</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead className="text-right">Granted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.map((permission) => (
              <TableRow key={permission.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{permission.label}</span>
                    {showPermissionIds ? (
                      <span className="font-mono text-[10.5px] text-muted-foreground">{permission.id}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="capitalize">
                    {permission.service ?? permission.kind}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Switch
                    checked={Boolean(checked[permission.id])}
                    onCheckedChange={() => onToggle(permission.id)}
                    aria-label={`Toggle ${permission.label}`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
