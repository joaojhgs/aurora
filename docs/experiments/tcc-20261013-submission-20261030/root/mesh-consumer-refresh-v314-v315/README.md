# Mesh consumer registry refresh correction

A registry refresh cleared remote readiness, but rebuilding only negotiated remote-provider targets omitted authenticated consumer sessions. Two consecutive Assistant calls could therefore leave the second request unavailable before model dispatch. The final source includes authenticated active consumer targets through the existing authorization/session/send guard and preserves generation catch-up plus fresh manifest acknowledgement and lease requirements.

These are retained closed gates, exported without rerunning tests: [independent Sol review](independent-sol-review.md), [three focused passing checks](targeted-regression.xml), and [actual two consecutive mesh replies with complete matching provider inputs](../matched-readiness-v315-mesh/README.md). Earlier failed cases remain separate chronological histories. No permission evaluator or authentication scope was broadened. The final source hashes are in [manifest.json](manifest.json).
