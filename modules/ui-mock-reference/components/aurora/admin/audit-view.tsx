"use client"

import { useState } from "react"
import { PageHeader } from "@/components/aurora/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { auditEvents } from "@/lib/aurora/data"
import { Activity, Search, CheckCircle2, XCircle, AlertTriangle } from "lucide-react"

const severityStyle: Record<string, string> = {
  info: "border-info/40 text-info",
  warning: "border-warning/40 text-warning",
  critical: "border-destructive/40 text-destructive",
}

const resultIcon = {
  success: CheckCircle2,
  denied: XCircle,
  error: AlertTriangle,
}

export function AuditView() {
  const [query, setQuery] = useState("")
  const [severity, setSeverity] = useState("all")

  const filtered = auditEvents.filter((e) => {
    const matchesQuery =
      query === "" ||
      [e.actor, e.action, e.resource].some((f) =>
        f.toLowerCase().includes(query.toLowerCase()),
      )
    const matchesSeverity = severity === "all" || e.severity === severity
    return matchesQuery && matchesSeverity
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every privileged action is recorded with actor, target, and result. This log is append-only."
        icon={Activity}
      />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search actor, action, or resource"
                className="pl-9"
              />
            </div>
            <Select value={severity} onValueChange={(value) => setSeverity(value ?? "all")}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((e) => {
                const Icon = resultIcon[e.result]
                return (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.timestamp}
                    </TableCell>
                    <TableCell className="font-medium">{e.actor}</TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{e.resource}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={severityStyle[e.severity]}>
                        {e.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span
                        className={`inline-flex items-center gap-1 text-xs ${
                          e.result === "success"
                            ? "text-success"
                            : e.result === "denied"
                              ? "text-warning"
                              : "text-destructive"
                        }`}
                      >
                        <Icon className="size-3.5" />
                        {e.result}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No audit events match your filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
