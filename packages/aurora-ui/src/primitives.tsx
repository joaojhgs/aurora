'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { AlertTriangle, Check, Search, ShieldCheck, X } from 'lucide-react'

/**
 * Aurora UI foundation primitives.
 *
 * These mirror the shadcn vocabulary used by the mock cockpit while keeping the
 * project's `aui-*` class conventions and real-not-fake truthfulness rules. They
 * are SSR-safe: controlled components own their open state and render nothing
 * when closed so `renderToStaticMarkup` gates stay deterministic.
 */

type ResponsiveHide = 'md' | 'lg' | 'xl'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

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
    <section className={cx('aui-card', flush && 'aui-card-flush', className)} aria-label={ariaLabel}>
      {hasHeader ? (
        <header className="aui-card-head">
          <div className="aui-card-head-main">
            {icon ? <span className="aui-card-icon" aria-hidden>{icon}</span> : null}
            <div className="aui-card-head-text">
              {title ? <h3 className="aui-card-title">{title}</h3> : null}
              {description ? <p className="aui-card-desc">{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="aui-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children ? <div className="aui-card-body">{children}</div> : null}
      {footer ? <footer className="aui-card-foot">{footer}</footer> : null}
    </section>
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
    <div className={cx('aui-stat-strip', className)} role="list" aria-label={ariaLabel}>
      {items.map((item) => (
        <div key={item.label} role="listitem" className={cx('aui-stat', item.tone && item.tone !== 'default' && `aui-stat-${item.tone}`)}>
          <span className="aui-stat-label">{item.label}</span>
          <span className="aui-stat-value">{item.value}</span>
          {item.caption ? <span className="aui-stat-caption">{item.caption}</span> : null}
          {item.badge ? <span className="aui-stat-badge">{item.badge}</span> : null}
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
    <dl className={cx('aui-meta-grid', columns === 1 && 'aui-meta-grid-1', className)} aria-label={ariaLabel}>
      {items.map((item) => (
        <div key={item.label} className="aui-meta">
          <dt className="aui-meta-label">{item.label}</dt>
          <dd className={cx('aui-meta-value', item.mono && 'aui-mono')}>{item.value}</dd>
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

export function DataTable<T>({ columns, rows, getRowKey, onRowClick, caption, empty, className }: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return <div className="aui-table-empty">{empty}</div>
  }
  return (
    <div className={cx('aui-table-wrap', className)}>
      <table className="aui-table">
        {caption ? <caption className="aui-table-caption">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cx(col.hideAt && `aui-hide-${col.hideAt}`, col.align && `aui-col-${col.align}`)}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const clickable = Boolean(onRowClick)
            return (
              <tr
                key={getRowKey(row, index)}
                className={cx(clickable && 'aui-row-clickable')}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? 'button' : undefined}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick?.(row)
                        }
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cx(col.hideAt && `aui-hide-${col.hideAt}`, col.align && `aui-col-${col.align}`, col.mono && 'aui-mono')}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
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

export function DetailSheet({ open, onClose, title, description, badge, actions, children, labelledBy }: DetailSheetProps) {
  const generatedId = useId()
  const titleId = labelledBy ?? generatedId
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="aui-sheet-overlay" role="presentation" onClick={onClose}>
      <aside
        className="aui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="aui-sheet-head">
          <div className="aui-sheet-head-text">
            <h2 id={titleId} className="aui-sheet-title">{title}</h2>
            {description ? <p className="aui-sheet-desc">{description}</p> : null}
          </div>
          {badge ? <div className="aui-sheet-badge">{badge}</div> : null}
          <button type="button" className="aui-icon-button" aria-label="Close details" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="aui-sheet-body">{children}</div>
        {actions ? <footer className="aui-sheet-foot">{actions}</footer> : null}
      </aside>
    </div>
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
    <div className={cx('aui-field', error && 'aui-field-error', className)}>
      <label className="aui-field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="aui-field-required" aria-hidden> *</span> : null}
      </label>
      {children}
      {helper && !error ? <p className="aui-field-helper">{helper}</p> : null}
      {error ? <p className="aui-field-error-text" role="alert">{error}</p> : null}
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
    <button
      type="button"
      id={switchId}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('aui-switch', checked && 'aui-switch-on')}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onClick={disabled || !onChange ? undefined : () => onChange(!checked)}
    >
      <span className="aui-switch-track" aria-hidden>
        <span className="aui-switch-thumb" />
      </span>
    </button>
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
    <label className={cx('aui-checkbox', disabled && 'aui-checkbox-disabled')} htmlFor={boxId}>
      <input
        id={boxId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
      />
      <span className="aui-checkbox-mark" aria-hidden>{checked ? <Check size={12} /> : null}</span>
      <span className="aui-checkbox-label">{label}</span>
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
  const [showMore, setShowMore] = useState(false)
  const searchId = useId()
  return (
    <div className={cx('aui-filterbar', className)}>
      <div className="aui-filterbar-row">
        {search ? (
          <div className="aui-search">
            <Search size={15} aria-hidden className="aui-search-icon" />
            <input
              id={searchId}
              type="search"
              className="aui-search-input"
              value={search.value}
              placeholder={search.placeholder ?? 'Search'}
              aria-label={search.label ?? search.placeholder ?? 'Search'}
              onChange={(event) => search.onChange(event.target.value)}
            />
          </div>
        ) : null}
        {controls ? <div className="aui-filterbar-controls">{controls}</div> : null}
        <div className="aui-filterbar-spacer" />
        {moreFilters ? (
          <button
            type="button"
            className="aui-button aui-button-ghost"
            aria-expanded={showMore}
            onClick={() => setShowMore((value) => !value)}
          >
            {showMore ? 'Fewer filters' : 'More filters'}
          </button>
        ) : null}
        {actions ? <div className="aui-filterbar-actions">{actions}</div> : null}
      </div>
      {moreFilters && showMore ? <div className="aui-filterbar-more">{moreFilters}</div> : null}
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
}

export function Button({ children, onClick, variant = 'outline', type = 'button', disabled, disabledReason, icon, busy, className, ariaLabel, ariaPressed }: ButtonProps) {
  const isDisabled = Boolean(disabled || busy)
  return (
    <button
      type={type}
      className={cx('aui-btn', `aui-btn-${variant}`, className)}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={isDisabled ? disabledReason : undefined}
      onClick={isDisabled || !onClick ? undefined : onClick}
    >
      {icon ? <span className="aui-btn-icon" aria-hidden>{icon}</span> : null}
      <span>{children}</span>
    </button>
  )
}

export interface DisabledActionProps {
  label: string
  reason: string
  icon?: ReactNode
}

export function DisabledAction({ label, reason, icon }: DisabledActionProps) {
  return (
    <span className="aui-disabled-action">
      <button type="button" className="aui-btn aui-btn-outline" disabled aria-disabled title={reason}>
        {icon ? <span className="aui-btn-icon" aria-hidden>{icon}</span> : null}
        <span>{label}</span>
      </button>
      <span className="aui-disabled-reason">{reason}</span>
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
    <div className={cx('aui-badge-cluster', className)} aria-label={label}>
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
  severity = 'standard',
  affected,
  requireReason,
  reasonValue = '',
  onReasonChange,
  requireTypedPhrase,
  typedValue = '',
  onTypedChange,
  confirmLabel = 'Confirm via AdminAction',
  onConfirm,
  onCancel,
  busy,
  receipt,
  error,
  extraValid = true,
  extraInvalidReason,
  children
}: AdminConfirmDialogProps) {
  const titleId = useId()
  const reasonId = useId()
  const typedId = useId()
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])
  if (!open) return null
  const reasonOk = !requireReason || reasonValue.trim().length > 0
  const phraseOk = !requireTypedPhrase || typedValue.trim() === requireTypedPhrase.trim()
  const canConfirm = reasonOk && phraseOk && extraValid && !busy
  return (
    <div className="aui-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className={cx('aui-modal', severity === 'destructive' && 'aui-modal-destructive')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="aui-modal-head">
          <span className="aui-modal-icon" aria-hidden>
            {severity === 'destructive' ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
          </span>
          <div>
            <h2 id={titleId} className="aui-modal-title">{title}</h2>
            {methodId ? <p className="aui-modal-method aui-mono">{methodId}</p> : null}
          </div>
        </header>
        <p className="aui-modal-desc">{description}</p>
        {affected && affected.length > 0 ? (
          <div className="aui-modal-affected">
            <p className="aui-modal-affected-label">Affected</p>
            <ul>
              {affected.map((item) => (
                <li key={item} className="aui-mono">{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {requireReason ? (
          <FormField label="AdminAction reason" htmlFor={reasonId} required>
            <textarea
              id={reasonId}
              className="aui-textarea"
              rows={3}
              value={reasonValue}
              onChange={onReasonChange ? (event) => onReasonChange(event.target.value) : undefined}
            />
          </FormField>
        ) : null}
        {requireTypedPhrase ? (
          <FormField
            label={`Type ${requireTypedPhrase} to confirm`}
            htmlFor={typedId}
            required
          >
            <input
              id={typedId}
              type="text"
              className="aui-input"
              value={typedValue}
              autoComplete="off"
              onChange={onTypedChange ? (event) => onTypedChange(event.target.value) : undefined}
            />
          </FormField>
        ) : null}
        {children ? <div className="aui-modal-extra">{children}</div> : null}
        {error ? <p className="aui-modal-error" role="alert">{error}</p> : null}
        {receipt ? <p className="aui-modal-receipt">Audit receipt: <span className="aui-mono">{receipt}</span></p> : null}
        <footer className="aui-modal-foot">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant={severity === 'destructive' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!canConfirm}
            busy={busy}
            disabledReason={!reasonOk ? 'Provide an AdminAction reason.' : !phraseOk ? 'Type the confirmation phrase exactly.' : !extraValid ? (extraInvalidReason ?? 'Complete required confirmations.') : undefined}
          >
            {busy ? 'Working' : confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
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
  const [messages, setMessages] = useState<ToastMessage[]>([])
  const toast = useCallback((message: Omit<ToastMessage, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((current) => [...current, { ...message, id }])
  }, [])
  const dismiss = useCallback((id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id))
  }, [])
  const value = useMemo(() => ({ toast }), [toast])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="aui-toast-region" role="status" aria-live="polite">
        {messages.map((message) => (
          <ToastCard key={message.id} message={message} onDismiss={() => dismiss(message.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000)
    return () => clearTimeout(timer)
  }, [onDismiss])
  return (
    <div className={cx('aui-toast', `aui-toast-${message.tone}`)}>
      <span className="aui-toast-icon" aria-hidden>
        {message.tone === 'success' ? <Check size={15} /> : message.tone === 'error' ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
      </span>
      <div className="aui-toast-text">
        <strong>{message.title}</strong>
        {message.detail ? <span>{message.detail}</span> : null}
      </div>
      <button type="button" className="aui-icon-button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    return { toast: () => undefined }
  }
  return context
}
