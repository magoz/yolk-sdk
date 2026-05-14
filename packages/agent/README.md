# @yolk/agent

Domain-free agent protocol, loop, runtime, client, and tool primitives.

Root export is intentionally tiny. Import feature APIs from explicit subpaths.

## Subpaths

```ts
import { UserMessage } from '@yolk/agent/protocol'
import { run } from '@yolk/agent/loop'
import { runRuntime } from '@yolk/agent/runtime'
import { initialAgentClientState } from '@yolk/agent/client'
import { makeTaskToolModule, resolveTools } from '@yolk/agent/tools'
```

Test helpers live behind their own subpath:

```ts
import { FauxProvider, Reply, TestToolExecutor } from '@yolk/agent/loop/testing'
```

## Boundaries

- No React, Next.js, provider SDKs, auth, storage drivers, or app concepts.
- Loop stays stateless: transcript in, events out.
- Runtime owns generic session orchestration only; host apps own persistence adapters and policy.
- Tools model generic metadata/execution; host apps own concrete tool catalogs.
- `task` is the standard subagent delegation tool. Packages define the schema; host apps execute subagents and omit `task` from subagent toolsets in v1.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No top-level env reads, network calls, SDK clients, or service construction.
