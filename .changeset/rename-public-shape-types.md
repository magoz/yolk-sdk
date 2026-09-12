---
'@yolk-sdk/agent': minor
'@yolk-sdk/harness': minor
---

**Breaking type imports** (runtime and wire unchanged; no compatibility aliases):

- `LoopConfigShape` → `LoopConfigSettings` from `@yolk-sdk/agent/loop`
- `RunStoreShape` → `RunStoreApi` from `@yolk-sdk/harness/store`
- `InboxShape` → `InboxApi` from `@yolk-sdk/harness/inbox`
- `DriverShape` → `DriverApi` from `@yolk-sdk/harness/driver`

```ts
import type { LoopConfigSettings } from '@yolk-sdk/agent/loop'
import type { RunStoreApi } from '@yolk-sdk/harness/store'
import type { InboxApi } from '@yolk-sdk/harness/inbox'
import type { DriverApi } from '@yolk-sdk/harness/driver'
```
