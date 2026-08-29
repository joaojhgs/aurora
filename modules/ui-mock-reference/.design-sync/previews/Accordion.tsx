import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@aurora/ui-mock-reference'

export function Collapsed() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Accordion className="max-w-md">
        <AccordionItem value="routing">
          <AccordionTrigger>How does mesh routing choose a path?</AccordionTrigger>
          <AccordionContent>
            Aurora scores each peer hop by latency, trust level, and link
            stability, then re-evaluates the route every 30 seconds.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="diagnostics">
          <AccordionTrigger>What does a failed diagnostics run mean?</AccordionTrigger>
          <AccordionContent>
            A failed run flags the specific probe — latency, DNS, or
            attestation — that didn&apos;t respond within the timeout window.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="trust">
          <AccordionTrigger>When is a device auto-revoked?</AccordionTrigger>
          <AccordionContent>
            After three consecutive failed attestation checks, or immediately
            if a compromised key is reported.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

export function Expanded() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Accordion className="max-w-md" value={['routing']}>
        <AccordionItem value="routing">
          <AccordionTrigger>How does mesh routing choose a path?</AccordionTrigger>
          <AccordionContent>
            Aurora scores each peer hop by latency, trust level, and link
            stability, then re-evaluates the route every 30 seconds.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="diagnostics">
          <AccordionTrigger>What does a failed diagnostics run mean?</AccordionTrigger>
          <AccordionContent>
            A failed run flags the specific probe — latency, DNS, or
            attestation — that didn&apos;t respond within the timeout window.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
