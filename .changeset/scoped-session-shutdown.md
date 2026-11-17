---
'@hyper-effect/core': patch
---

Own live sessions and snapshot workers in the server layer's scope. Shutdown interrupts session commands, waits for in-flight and final snapshot writes before releasing the store, and retains snapshots for restart instead of leaving detached writers running.
