---
'@yolk-sdk/harness': patch
---

Move service construction into owning static layer factories (`RunStore.inMemoryLayer`/`snapshotLayer`, `Inbox.layer`, `RunCoordinator.layer`, `Driver.layer`) with the public `make*` factories delegating; model step outcomes with `Data.taggedEnum` constructors.
