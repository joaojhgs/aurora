'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button as ChoiceButton } from '#components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '#components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#components/ui/popover'
import { cn } from '#lib/utils'

export interface SearchableChoiceOption {
  id: string
  label: string
  detail?: string | undefined
  disabled?: boolean | undefined
}

export function SearchableChoice({
  id,
  value,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  ariaLabel,
  disabled = false,
  onSelect,
}: {
  id: string
  value: string | null
  options: readonly SearchableChoiceOption[]
  placeholder: string
  searchPlaceholder: string
  emptyText: string
  ariaLabel: string
  disabled?: boolean | undefined
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value) ?? null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <ChoiceButton
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel}
            className="w-full justify-between font-normal"
          />
        )}
      >
        <span className={cn('min-w-0 truncate', selected ? 'text-foreground' : 'text-muted-foreground')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.detail ?? ''} ${option.id}`}
                  disabled={option.disabled === true}
                  data-checked={option.id === value}
                  onSelect={() => {
                    if (option.disabled === true) return
                    onSelect(option.id)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

