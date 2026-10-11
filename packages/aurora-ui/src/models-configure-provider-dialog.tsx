'use client'

import type { ConfigFieldMetadata, JsonValue } from '@aurora/client'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Input } from '#components/ui/input'
import { Button, FormField } from './primitives'
import { RouteStateNotice } from './state-surface'
import { modelStrictProductCopy } from './models-product-copy'
import type { ModelProviderViewModel } from './models-view'

export type ConfigureLoadState = 'idle' | 'loading' | 'ready' | 'error'

// ---------------------------------------------------------------------------
// Configure source dialog - fields generated from Aurora settings details.
// ---------------------------------------------------------------------------

export function providerConfigSection(configValue: string): string {
  if (configValue === 'openai') return 'services.orchestrator.llm.third_party.openai.options'
  if (configValue === 'huggingface_endpoint') return 'services.orchestrator.llm.third_party.huggingface_endpoint.options'
  if (configValue === 'huggingface_pipeline') return 'services.orchestrator.llm.local.huggingface_pipeline.options'
  return 'services.orchestrator.llm.local.llama_cpp.options'
}

export function configureFieldInitialValue(field: ConfigFieldMetadata): string {
  if (field.secret) return ''
  const value = field.current_value ?? field.default
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function parseConfigureFieldValue(raw: string, type: string): JsonValue {
  if (type === 'int') return Number.parseInt(raw, 10)
  if (type === 'float') return Number(raw)
  if (type === 'bool') return raw === 'true'
  return raw
}

function configureNumericBound(field: ConfigFieldMetadata, key: 'minimum' | 'maximum'): number | undefined {
  const value = field.constraints[key]
  return typeof value === 'number' ? value : undefined
}

function modelFieldLabel(field: ConfigFieldMetadata): string {
  return modelStrictProductCopy(field.title, 'Model setting')
}

function modelFieldHelper(field: ConfigFieldMetadata): string | undefined {
  if (!field.description) return undefined
  return modelStrictProductCopy(field.description, 'Update this setting only if you know the expected value.')
}

export function ConfigureProviderDialog({
  provider,
  fields,
  values,
  loadState,
  productModelErrorCopy,
  saving,
  onChange,
  onCancel,
  onSave
}: {
  provider: ModelProviderViewModel | null
  fields: ConfigFieldMetadata[]
  values: Record<string, string>
  loadState: ConfigureLoadState
  productModelErrorCopy: string | null
  saving: boolean
  onChange: (keyPath: string, value: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  if (!provider) return null
  const visibleFields = fields.filter((field) => field.type !== 'dict' && field.type !== 'list')
  return (
    <Dialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {provider.name}</DialogTitle>
          <DialogDescription>Fields are generated from Aurora settings details for this model source.</DialogDescription>
        </DialogHeader>
        {loadState === 'loading' ? <RouteStateNotice state="loading" title="Loading settings details" message="Loading settings details." /> : null}
        {loadState === 'error' ? (
          <RouteStateNotice state="error" title="Model settings need attention" message={productModelErrorCopy ?? 'Model settings need attention.'} />
        ) : null}
        {loadState === 'ready' ? (
          <div className="flex flex-col gap-3">
            {visibleFields.map((field) => (
              <FormField
                key={field.key_path}
                label={modelFieldLabel(field)}
                htmlFor={field.key_path}
                helper={modelFieldHelper(field)}
              >
                <ConfigureFieldInput field={field} value={values[field.key_path] ?? ''} onChange={(value) => onChange(field.key_path, value)} />
              </FormField>
            ))}
            {productModelErrorCopy ? (
              <p className="text-sm text-destructive" role="alert">
                {productModelErrorCopy}
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={loadState !== 'ready' || saving} busy={saving}>
            Save &amp; test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfigureFieldInput({
  field,
  value,
  onChange
}: {
  field: ConfigFieldMetadata
  value: string
  onChange: (value: string) => void
}) {
  if (field.choices && field.choices.length > 0) {
    return (
      <Select value={value} onValueChange={(next) => onChange(next ?? '')}>
        <SelectTrigger className="w-full" id={field.key_path}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {field.choices.map((choice) => {
            const option = String(choice)
            return (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    )
  }
  if (field.type === 'bool') {
    return (
      <Select value={value || 'false'} onValueChange={(next) => onChange(next ?? 'false')}>
        <SelectTrigger className="w-full" id={field.key_path}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Enabled</SelectItem>
          <SelectItem value="false">Disabled</SelectItem>
        </SelectContent>
      </Select>
    )
  }
  if (field.type === 'int' || field.type === 'float') {
    return (
      <Input
        id={field.key_path}
        type="number"
        min={configureNumericBound(field, 'minimum')}
        max={configureNumericBound(field, 'maximum')}
        step={field.type === 'float' ? 0.1 : 1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <Input
      id={field.key_path}
      type={field.secret ? 'password' : 'text'}
      value={value}
      placeholder={field.secret ? 'Unchanged (leave blank to keep current value)' : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

