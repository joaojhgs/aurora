# Matched mesh second-call backend follow-up (V299)

## Finding

The SDK fallback path forwards the `sendMessage` failure into a typed stream
failure (`fallback.error`) at `packages/aurora-sdk/src/client.ts:1397-1418`.
`streamFailure` preserves that `AuroraError`, including its code and method, at
`client.ts:1959-1984`. The V296 probe recorded the fallback as a mismatch but
did not retain that error discriminator. This identifies the next useful safe
field to examine: the existing finite `fallback.error.code` (and method/status
if already represented), without recording its message or response body.

This does not determine the cause. The V296 receipt does not contain that
field, and the retained Python service log has no call-specific error marker.

## Teardown boundary

`client.ts:1417-1418` closes only the assistant event stream in `finally`.
For mesh transport, `packages/aurora-sdk/src/webrtc/mesh-peer-bridge.ts:596-604`
removes the local stream, pending subscription, and scoped event-subscription
registration, then sends an `unsubscribe` frame. On the server,
`app/services/gateway/webrtc/rpc.py:1031-1060` removes only the subscription
for the authenticated peer and subscription ID. Neither path closes the
authenticated peer session or the RTC transport.

The backend's scoped subscription registry at
`app/services/gateway/webrtc/event_subscriptions.py:266-281` likewise removes
only that subscription. The event subscription close therefore is not source
evidence for authorization, peer-session, or transport teardown between calls.

The RTC bridge also uses independent IDs for calls and subscriptions. Its
`streamRequest` path constructs an outbound call (`mesh-peer-bridge.ts:607-648`),
while event subscription teardown uses an `unsubscribe` frame. The inspected
boundaries show no shared teardown action connecting those operations.

## Limit

No backend cause or product fix is established. Root's existing safe
failure-code capture at the SDK fallback boundary is the next discriminator;
this report does not request another broad run, new instrumentation, or a
transport/authentication change.
