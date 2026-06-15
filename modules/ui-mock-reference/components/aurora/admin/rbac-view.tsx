"use client"

import { useState } from "react"
import { PageHeader } from "@/components/aurora/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AdminConfirmDialog } from "@/components/aurora/admin-confirm-dialog"
import { roles, principals, permissionCatalog, tokens, devices } from "@/lib/aurora/data"
import { ShieldCheck, UserCog, KeyRound, Smartphone, Plus } from "lucide-react"

export function RbacView() {
  const [selectedRole, setSelectedRole] = useState(roles[0])
  const [pendingPerm, setPendingPerm] = useState<{ id: string; grant: boolean } | null>(null)

  const pendingPermLabel =
    pendingPerm && permissionCatalog.find((p) => p.id === pendingPerm.id)?.label

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Roles & permissions"
        description="Define what each role can do across the assistant and admin surfaces. Changes are audited and require confirmation."
        icon={ShieldCheck}
      />

      <Tabs defaultValue="roles" className="w-full">
        <TabsList>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="principals">Principals</TabsTrigger>
          <TabsTrigger value="tokens">API tokens</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
        </TabsList>

        <TabsContent value="roles" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Roles</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 p-2">
                {roles.map((role) => (
                  <button
                    key={role.id}
                    onClick={() => setSelectedRole(role)}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      selectedRole.id === role.id
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    <span className="font-medium">{role.name}</span>
                    <Badge variant="secondary" className="text-xs">
                      {role.principalCount}
                    </Badge>
                  </button>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">{selectedRole.name}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{selectedRole.description}</p>
                </div>
                {selectedRole.system ? (
                  <Badge variant="outline" className="gap-1">
                    <KeyRound className="size-3" /> System
                  </Badge>
                ) : null}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Permission</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead className="text-right">Granted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {permissionCatalog.map((perm) => {
                      const granted = selectedRole.permissions.includes(perm.id)
                      return (
                        <TableRow key={perm.id}>
                          <TableCell>
                            <div className="font-medium">{perm.label}</div>
                            <div className="text-xs text-muted-foreground">{perm.id}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs capitalize">
                              {perm.scope}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Switch
                              checked={granted}
                              disabled={selectedRole.system}
                              onCheckedChange={(v) => setPendingPerm({ id: perm.id, grant: v })}
                              aria-label={`Toggle ${perm.label}`}
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="principals" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <UserCog className="size-4" /> Principals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Identity</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Last active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {principals.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">{p.id}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs capitalize">
                          {p.kind}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          {p.role}
                          {p.isAdmin ? (
                            <Badge className="bg-info/15 text-info text-xs">admin</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.lastActive}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tokens" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <KeyRound className="size-4" /> API tokens
              </CardTitle>
              <Button size="sm" variant="outline" className="gap-1">
                <Plus className="size-4" /> Issue token
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Token</TableHead>
                    <TableHead>Principal</TableHead>
                    <TableHead>Scopes</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs">{t.prefix}••••</TableCell>
                      <TableCell>{t.principal}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {t.scopes.map((s) => (
                            <Badge key={s} variant="secondary" className="text-xs">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t.expires}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            t.status === "active"
                              ? "border-success/40 text-success"
                              : t.status === "expiring"
                                ? "border-warning/40 text-warning"
                                : "border-destructive/40 text-destructive"
                          }
                        >
                          {t.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="devices" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Smartphone className="size-4" /> Enrolled devices
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead className="text-right">Trust</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {devices.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell>{d.user}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.platform}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.lastSeen}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={
                            d.trust === "trusted"
                              ? "border-success/40 text-success"
                              : d.trust === "pending"
                                ? "border-warning/40 text-warning"
                                : "border-destructive/40 text-destructive"
                          }
                        >
                          {d.trust}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AdminConfirmDialog
        open={pendingPerm !== null}
        onOpenChange={(o) => !o && setPendingPerm(null)}
        title={pendingPerm?.grant ? "Grant permission" : "Revoke permission"}
        description={`This will ${pendingPerm?.grant ? "grant" : "revoke"} "${pendingPermLabel}" for the ${selectedRole.name} role.`}
        impact={pendingPerm?.grant ? "medium" : "high"}
        diff={[
          {
            field: `${selectedRole.id}.${pendingPerm?.id ?? ""}`,
            before: pendingPerm?.grant ? "denied" : "granted",
            after: pendingPerm?.grant ? "granted" : "denied",
          },
        ]}
        confirmLabel={pendingPerm?.grant ? "Grant" : "Revoke"}
        onConfirm={() => setPendingPerm(null)}
      />
    </div>
  )
}
