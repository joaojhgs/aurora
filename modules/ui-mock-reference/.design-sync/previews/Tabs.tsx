import { Tabs, TabsList, TabsTrigger, TabsContent } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Tabs defaultValue="overview" className="w-96">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="peers">Peers</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <p className="text-sm text-muted-foreground">
            Mesh health is nominal across 12 active peers, 3 pending pairing
            requests.
          </p>
        </TabsContent>
        <TabsContent value="peers">
          <p className="text-sm text-muted-foreground">
            office-relay-04, warehouse-node-2, and 10 others are currently
            routing traffic.
          </p>
        </TabsContent>
        <TabsContent value="diagnostics">
          <p className="text-sm text-muted-foreground">
            Last diagnostics run completed 6 minutes ago with no failed
            probes.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function LineVariant() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Tabs defaultValue="routing" className="w-96">
        <TabsList variant="line">
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="trust">Trust</TabsTrigger>
        </TabsList>
        <TabsContent value="routing">
          <p className="text-sm text-muted-foreground">
            Traffic is routed through the lowest-latency peer chain available
            at each hop.
          </p>
        </TabsContent>
        <TabsContent value="trust">
          <p className="text-sm text-muted-foreground">
            Devices are re-attested every 15 minutes; three consecutive
            failures trigger automatic revocation.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
