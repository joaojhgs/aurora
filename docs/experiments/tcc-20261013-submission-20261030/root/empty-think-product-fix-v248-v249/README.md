# Grounded empty-thought final-reply correction

The real one-request diagnostic identified empty leading thought markup in an otherwise expected answer. The backend preserved it through history/final response, and the current UI renders that text unchanged. The correction removes one leading empty block at the nonstream final boundary and once at the streaming terminal boundary before final persistence/emission. Nonempty thinking/body content, model/task/settings/predicate, IDs, authorization and contracts remain unchanged. Incremental streaming cleanup is not claimed.

Independent Sol reviewed the exact two-file correction; its double-normalization finding was resolved by limiting the outer normalization to nonstream requests. The meaningful service-level regression uses the captured reply and verifies returned, persisted and emitted text plus correlation/request IDs. Four affected module cases passed before and after that guard; final integrated run0.69seconds, Ruff passed. The original failed observations are retained without reclassification or predicate relaxation.

No broader suite/edge matrix or source publication was performed. One affected real LocalBus/authenticated API pilot is the next runtime gate; this source/unit review does not itself claim that gate passes. The existing full aggregate remains active.
