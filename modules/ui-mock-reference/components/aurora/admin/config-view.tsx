"use client"

import { useMemo, useState } from "react"
import { PageHeader } from "@/components/aurora/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { AdminConfirmDialog } from "@/components/aurora/admin-confirm-dialog"
import { configEntries } from "@/lib/aurora/data"
import { Settings, RotateCcw, Save, Lock } from "lucide-react"

export function ConfigView() {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [confirmOpen, setConfirmOpen] = useState(false)

  const sections = useMemo(() => {
    const map = new Map<string, typeof configEntries>()
    for (const entry of configEntries) {
      const arr = map.get(entry.section) ?? []
      arr.push(entry)
      map.set(entry.section, arr)
    }
    return Array.from(map.entries())
  }, [])

  const diff = useMemo(
    () =>
      Object.entries(edits)
        .filter(([key, value]) => {
          const original = configEntries.find((e) => e.key === key)
          return original && original.value !== value
        })
        .map(([key, value]) => {
          const original = configEntries.find((e) => e.key === key)
          return { field: key, before: original?.value ?? "", after: value }
        }),
    [edits],
  )

  const restartNeeded = diff.some(
    (d) => configEntries.find((e) => e.key === d.field)?.restartRequired,
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Configuration"
        description="Server and client settings. Edits are staged into a reviewable diff and applied only after confirmation."
        icon={Settings}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={diff.length === 0}
              onClick={() => setEdits({})}
              className="gap-1"
            >
              <RotateCcw className="size-4" /> Discard
            </Button>
            <Button
              size="sm"
              disabled={diff.length === 0}
              onClick={() => setConfirmOpen(true)}
              className="gap-1"
            >
              <Save className="size-4" /> Review {diff.length > 0 ? `(${diff.length})` : ""}
            </Button>
          </div>
        }
      />

      <Accordion type="multiple" defaultValue={sections.map(([s]) => s)} className="flex flex-col gap-3">
        {sections.map(([section, entries]) => (
          <Card key={section} className="overflow-hidden">
            <AccordionItem value={section} className="border-0">
              <AccordionTrigger className="px-5 py-4 hover:no-underline">
                <span className="flex items-center gap-2 text-sm font-semibold capitalize">
                  {section}
                  <Badge variant="secondary" className="text-xs">
                    {entries.length}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <CardContent className="flex flex-col gap-4 pt-0">
                  {entries.map((entry) => {
                    const current = edits[entry.key] ?? entry.value
                    const changed = current !== entry.value
                    return (
                      <div
                        key={entry.key}
                        className="grid gap-2 sm:grid-cols-[1fr_minmax(0,360px)] sm:items-center"
                      >
                        <div>
                          <Label className="flex items-center gap-2 font-mono text-sm">
                            {entry.key}
                            {entry.secret ? (
                              <Lock className="size-3 text-muted-foreground" />
                            ) : null}
                            {changed ? (
                              <span className="size-1.5 rounded-full bg-warning" aria-label="modified" />
                            ) : null}
                          </Label>
                          <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
                          <div className="mt-1 flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px] uppercase">
                              {entry.source}
                            </Badge>
                            {entry.restartRequired ? (
                              <Badge variant="outline" className="border-warning/40 text-[10px] uppercase text-warning">
                                restart
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <Input
                          value={entry.secret ? "••••••••••••" : current}
                          disabled={entry.secret}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [entry.key]: e.target.value }))
                          }
                          className="font-mono text-sm"
                        />
                      </div>
                    )
                  })}
                </CardContent>
              </AccordionContent>
            </AccordionItem>
          </Card>
        ))}
      </Accordion>

      <AdminConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Apply configuration changes"
        description={
          restartNeeded
            ? "Some of these changes require a service restart and may briefly interrupt the assistant."
            : "Review the staged configuration changes before applying."
        }
        impact={restartNeeded ? "high" : "medium"}
        diff={diff}
        confirmLabel="Apply changes"
        onConfirm={() => {
          setEdits({})
          setConfirmOpen(false)
        }}
      />
    </div>
  )
}
