# @aurora/local-speech

Provider-neutral local speech model manifest, lifecycle, and storage ports for
Aurora browser, desktop, and mobile clients.

This package intentionally keeps inference engines out of the initial boundary.
It consumes generated Aurora speech DTOs from `@aurora/client/generated` and
exposes deterministic ports that later OPFS, native, and worker adapters can
implement.
