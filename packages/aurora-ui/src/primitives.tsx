'use client'

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { AlertTriangle, Search, ShieldCheck, X } from 'lucide-react'
import { toast as sonnerToast, Toaster as SonnerToaster } from 'sonner'
import { cn } from '#lib/utils'
import { Button as ShadButton } from '#components/ui/button'
import {
  Card as ShadCard,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '#components/ui/card'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '#components/ui/table'
import { Switch as ShadSwitch } from '#components/ui/switch'
import { Checkbox as ShadCheckbox } from '#components/ui/checkbox'
import { Input } from '#components/ui/input'
import { Textarea } from '#components/ui/textarea'
import { Label } from '#components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from '#components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle
} from '#components/ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader } from '#components/ui/empty'
import { Spinner } from '#components/ui/spinner'

/**
 * Aurora UI foundation primitives.
 *
 * Every screen in `packages/aurora-ui/src/*-view.tsx` imports these instead of
 * hand-rolling cards/tables/switches/modals. This file is the single place
 * that composes the real shadcn/ui primitives (`#components/ui/*`) so that
 * fixing it once fixes visual fidelity everywhere it's used. Exported names,
 * prop shapes and behavior (e.g. "renders nothing while closed" for
 * DetailSheet/AdminConfirmDialog, which SSR snapshot tests rely on) are kept
 * identical to the previous `.aui-*`-class implementation - only the internal
 * rendering changed.
 */

type ResponsiveHide = 'md' | 'lg' | 'xl'

// ---------------------------------------------------------------------------
// Card / SectionCard
// ---------------------------------------------------------------------------

export interface CardProps {
  title?: ReactNode
  icon?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  flush?: boolean | undefined
  className?: string | undefined
  ariaLabel?: string | undefined
  children?: ReactNode
}

export function Card({ title, icon, description, actions, footer, flush, className, ariaLabel, children }: CardProps) {
  const hasHeader = Boolean(title || icon || actions || description)
  return (
    <ShadCard className={cn(flush && '[--card-spacing:0px]', className)} aria-label={ariaLabel}>
      {hasHeader ? (
        <CardHeader className={cn(actions && 'grid-cols-[1fr_auto]')}>
          <div className="flex items-start gap-2.5">
            {icon ? (
              <span className="mt-0.5 text-muted-foreground" aria-hidden>
                {icon}
              </span>
            ) : null}
            <div className="flex flex-col gap-1">
              {title ? <CardTitle>{title}</CardTitle> : null}
              {description ? <CardDescription>{description}</CardDescription> : null}
            </div>
          </div>
          {actions ? <CardAction className="static col-start-2 row-span-2 flex items-center gap-2 self-start">{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      {children ? <CardContent>{children}</CardContent> : null}
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </ShadCard>
  )
}

// ---------------------------------------------------------------------------
// StatStrip / Stat
// ---------------------------------------------------------------------------

export interface StatItem {
  label: string
  value: ReactNode
  caption?: string | undefined
  badge?: ReactNode
  tone?: 'default' | 'success' | 'warning' | 'danger' | undefined
}

export interface StatStripProps {
  items: StatItem[]
  ariaLabel?: string | undefined
  className?: string | undefined
}

export function StatStrip({ items, ariaLabel = 'Summary metrics', className }: StatStripProps) {
  return (
    <div className={cn('flex flex-wrap items-stretch gap-3', className)} role="list" aria-label={ariaLabel}>
      {items.map((item) => (
        <div
          key={item.label}
          role="listitem"
          className={cn(
            'flex min-w-[150px] flex-1 flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3 ring-1 ring-foreground/10',
            item.tone === 'success' && 'border-success/30 bg-success/5',
            item.tone === 'warning' && 'border-warning/30 bg-warning/5',
            item.tone === 'danger' && 'border-destructive/30 bg-destructive/5'
          )}
        >
          <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{item.label}</span>
          <span className="text-lg leading-tight font-semibold">{item.value}</span>
          {item.caption ? <span className="text-xs text-muted-foreground">{item.caption}</span> : null}
          {item.badge ? <span>{item.badge}</span> : null}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MetaGrid / Meta
// ---------------------------------------------------------------------------

export interface MetaItem {
  label: string
  value: ReactNode
  mono?: boolean | undefined
}

export interface MetaGridProps {
  items: MetaItem[]
  columns?: 1 | 2 | undefined
  ariaLabel?: string | undefined
  className?: string | undefined
}

export function MetaGrid({ items, columns = 2, ariaLabel, className }: MetaGridProps) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-1.5 text-sm', columns === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2', className)} aria-label={ariaLabel}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-0">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={cn('text-right font-medium', item.mono && 'font-mono text-xs')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

export interface DataColumn<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  align?: 'start' | 'end' | 'center' | undefined
  hideAt?: ResponsiveHide | undefined
  mono?: boolean | undefined
  width?: string | undefined
}

export interface DataTableProps<T> {
  columns: Array<DataColumn<T>>
  rows: T[]
  getRowKey: (row: T, index: number) => string
  onRowClick?: ((row: T) => void) | undefined
  caption?: string | undefined
  empty?: ReactNode
  className?: string | undefined
}

function hideAtClass(hideAt: ResponsiveHide | undefined): string | false {
  if (hideAt === 'md') return 'hidden md:table-cell'
  if (hideAt === 'lg') return 'hidden lg:table-cell'
  if (hideAt === 'xl') return 'hidden xl:table-cell'
  return false
}

export function DataTable<T>({ columns, rows, getRowKey, onRowClick, caption, empty, className }: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border', className)}>
      <Table>
        {caption ? <TableCaption className="px-4 pb-2 text-left">{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  col.align === 'end' && 'text-right',
                  col.align === 'center' && 'text-center',
                  hideAtClass(col.hideAt)
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const clickable = Boolean(onRowClick)
            return (
              <TableRow
                key={getRowKey(row, index)}
                className={cn(clickable && 'cursor-pointer')}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? 'button' : undefined}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick?.(row)
                        }
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      col.align === 'end' && 'text-right',
                      col.align === 'center' && 'text-center',
                      hideAtClass(col.hideAt),
                      col.mono && 'font-mono text-xs'
                    )}
                  >
                    {col.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DetailSheet (right-side drawer)
// ---------------------------------------------------------------------------

export interface DetailSheetProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string | undefined
  badge?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  labelledBy?: string | undefined
}

export function DetailSheet({ open, onClose, title, description, badge, actions, children }: DetailSheetProps) {
  if (!open) return null
  return (
    <Sheet
      open
      onOpenChange={(next: boolean) => {
        if (!next) onClose()
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-col gap-1">
            <SheetTitle>{title}</SheetTitle>
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </div>
          {badge ? <div>{badge}</div> : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4">{children}</div>
        {actions ? <SheetFooter className="border-t border-border">{actions}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// FormField / Switch / Checkbox
// ---------------------------------------------------------------------------

export interface FormFieldProps {
  label: string
  htmlFor?: string | undefined
  helper?: ReactNode
  error?: string | null | undefined
  required?: boolean | undefined
  children: ReactNode
  className?: string | undefined
}

export function FormField({ label, htmlFor, helper, error, required, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} className={cn(error && 'text-destructive')}>
        {label}
        {required ? (
          <span aria-hidden className="text-destructive">
            {' '}
            *
          </span>
        ) : null}
      </Label>
      {children}
      {helper && !error ? <p className="text-xs text-muted-foreground">{helper}</p> : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export interface SwitchProps {
  checked: boolean
  onChange?: ((checked: boolean) => void) | undefined
  label: string
  disabled?: boolean | undefined
  disabledReason?: string | undefined
  id?: string | undefined
}

export function Switch({ checked, onChange, label, disabled, disabledReason, id }: SwitchProps) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  return (
    <ShadSwitch
      id={switchId}
      checked={checked}
      aria-label={label}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onCheckedChange={disabled || !onChange ? undefined : (value: boolean) => onChange(value)}
    />
  )
}

export interface CheckboxProps {
  checked: boolean
  onChange?: ((checked: boolean) => void) | undefined
  label: ReactNode
  disabled?: boolean | undefined
  id?: string | undefined
}

export function Checkbox({ checked, onChange, label, disabled, id }: CheckboxProps) {
  const generatedId = useId()
  const boxId = id ?? generatedId
  return (
    <label
      className={cn('group flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-50')}
      htmlFor={boxId}
    >
      <ShadCheckbox
        id={boxId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange ? (value: boolean) => onChange(value) : undefined}
      />
      <span>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Toolbar / FilterBar
// ---------------------------------------------------------------------------

export interface FilterBarProps {
  search?: {
    value: string
    onChange: (value: string) => void
    placeholder?: string | undefined
    label?: string | undefined
  }
  controls?: ReactNode
  actions?: ReactNode
  moreFilters?: ReactNode
  className?: string | undefined
}

export function FilterBar({ search, controls, actions, moreFilters, className }: FilterBarProps) {
  const searchId = useId()
  const [showMore, setShowMore] = useState(false)
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {search ? (
          <div className="relative min-w-[200px] flex-1">
            <Search size={15} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchId}
              type="search"
              className="pl-8"
              value={search.value}
              placeholder={search.placeholder ?? 'Search'}
              aria-label={search.label ?? search.placeholder ?? 'Search'}
              onChange={(event) => search.onChange(event.target.value)}
            />
          </div>
        ) : null}
        {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
        <div className="flex-1" />
        {moreFilters ? (
          <ShadButton type="button" variant="ghost" size="sm" aria-expanded={showMore} onClick={() => setShowMore((value) => !value)}>
            {showMore ? 'Fewer filters' : 'More filters'}
          </ShadButton>
        ) : null}
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {moreFilters && showMore ? <div className="rounded-lg border border-border bg-card p-3">{moreFilters}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Button + DisabledAction
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'

export interface ButtonProps {
  children: ReactNode
  onClick?: (() => void) | undefined
  variant?: ButtonVariant | undefined
  type?: 'button' | 'submit' | undefined
  disabled?: boolean | undefined
  disabledReason?: string | undefined
  icon?: ReactNode
  busy?: boolean | undefined
  className?: string | undefined
  ariaLabel?: string | undefined
  ariaPressed?: boolean | undefined
  ariaExpanded?: boolean | undefined
  ariaControls?: string | undefined
}

function shadVariantFor(variant: ButtonVariant): 'default' | 'outline' | 'ghost' | 'destructive' {
  if (variant === 'primary') return 'default'
  if (variant === 'danger') return 'destructive'
  return variant
}

export function Button({
  children,
  onClick,
  variant = 'outline',
  type = 'button',
  disabled,
  disabledReason,
  icon,
  busy,
  className,
  ariaLabel,
  ariaPressed,
  ariaExpanded,
  ariaControls
}: ButtonProps) {
  const isDisabled = Boolean(disabled || busy)
  return (
    <ShadButton
      type={type}
      variant={shadVariantFor(variant)}
      className={className}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      title={isDisabled ? disabledReason : undefined}
      onClick={isDisabled || !onClick ? undefined : onClick}
    >
      {busy ? <Spinner data-icon="inline-start" /> : icon ? (
        <span data-icon="inline-start" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </ShadButton>
  )
}

export interface DisabledActionProps {
  label: string
  reason: string
  icon?: ReactNode
}

export function DisabledAction({ label, reason, icon }: DisabledActionProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <ShadButton type="button" variant="outline" disabled aria-disabled title={reason}>
        {icon ? (
          <span data-icon="inline-start" aria-hidden>
            {icon}
          </span>
        ) : null}
        <span>{label}</span>
      </ShadButton>
      <span className="text-xs text-muted-foreground">{reason}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// BadgeCluster
// ---------------------------------------------------------------------------

export interface BadgeClusterProps {
  children: ReactNode
  label?: string | undefined
  className?: string | undefined
}

export function BadgeCluster({ children, label, className }: BadgeClusterProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} aria-label={label}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AdminConfirmDialog (modal)
// ---------------------------------------------------------------------------

export interface AdminConfirmDialogProps {
  open: boolean
  title: string
  description: string
  methodId?: string | undefined
  actionLabel?: string | undefined
  severity?: 'standard' | 'destructive' | undefined
  affected?: string[] | undefined
  requireReason?: boolean | undefined
  reasonValue?: string | undefined
  onReasonChange?: ((value: string) => void) | undefined
  requireTypedPhrase?: string | undefined
  typedValue?: string | undefined
  onTypedChange?: ((value: string) => void) | undefined
  confirmLabel?: string | undefined
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean | undefined
  receipt?: string | null | undefined
  error?: string | null | undefined
  extraValid?: boolean | undefined
  extraInvalidReason?: string | undefined
  children?: ReactNode
}

export function AdminConfirmDialog({
  open,
  title,
  description,
  methodId,
  actionLabel,
  severity = 'standard',
  affected,
  requireReason,
  reasonValue = '',
  onReasonChange,
  requireTypedPhrase,
  typedValue = '',
  onTypedChange,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
  busy,
  receipt,
  error,
  extraValid = true,
  extraInvalidReason,
  children
}: AdminConfirmDialogProps) {
  const reasonId = useId()
  const typedId = useId()
  if (!open) return null
  const reasonOk = !requireReason || reasonValue.trim().length > 0
  const phraseOk = !requireTypedPhrase || typedValue.trim() === requireTypedPhrase.trim()
  const canConfirm = reasonOk && phraseOk && extraValid && !busy
  const isSimple = !methodId && !affected?.length && !requireReason && !requireTypedPhrase && !children && !receipt && !error

  return (
    <AlertDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent size={isSimple ? 'sm' : 'default'}>
        {severity === 'destructive' ? (
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <AlertTriangle />
          </AlertDialogMedia>
        ) : null}
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {methodId ? <p className="text-xs text-muted-foreground">Action: {actionLabel ?? 'Protected admin action'}</p> : null}
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {affected && affected.length > 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Affected</p>
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              {affected.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {requireReason ? (
          <FormField label="Reason" htmlFor={reasonId} required>
            <Textarea
              id={reasonId}
              rows={3}
              value={reasonValue}
              onChange={onReasonChange ? (event) => onReasonChange(event.target.value) : undefined}
            />
          </FormField>
        ) : null}
        {requireTypedPhrase ? (
          <FormField label={`Type ${requireTypedPhrase} to confirm`} htmlFor={typedId} required>
            <Input
              id={typedId}
              type="text"
              value={typedValue}
              autoComplete="off"
              onChange={onTypedChange ? (event) => onTypedChange(event.target.value) : undefined}
            />
          </FormField>
        ) : null}
        {children ? <div className="flex flex-col gap-2">{children}</div> : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {receipt ? (
          <p className="text-xs text-muted-foreground">
            Audit receipt: <span className="font-mono">{receipt}</span>
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={severity === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={!canConfirm}
            title={
              !reasonOk
                ? 'Provide a reason.'
                : !phraseOk
                  ? 'Type the confirmation phrase exactly.'
                  : !extraValid
                    ? (extraInvalidReason ?? 'Complete required confirmations.')
                    : undefined
            }
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? 'Working' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastMessage {
  id: string
  tone: ToastTone
  title: string
  detail?: string | undefined
}

interface ToastContextValue {
  toast: (message: Omit<ToastMessage, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    const description = message.detail
    if (message.tone === 'success') sonnerToast.success(message.title, { description })
    else if (message.tone === 'error') sonnerToast.error(message.title, { description })
    else sonnerToast.info(message.title, { description })
  }, [])
  const value = useMemo(() => ({ toast }), [toast])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <SonnerToaster theme="dark" position="bottom-right" />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    return { toast: () => undefined }
  }
  return context
}

// re-exported so screens that want a plain shield/x icon affordance keep a single import surface
export { ShieldCheck, X }
