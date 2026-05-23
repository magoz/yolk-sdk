# Architecture

Historical pointer. Do not use this file as source of truth.

Current architecture lives in:

- `AGENTS.md` — repo contract, boundaries, commands, where to look
- `patterns/PACKAGE_ARCHITECTURE.md` — public package shape and dependency direction
- `packages/AGENTS.md` — package map and package-local docs
- `examples/next/AGENTS.md` — Next dogfood app boundaries
- `cloudflare/agent/AGENTS.md` — Worker/Durable Object adapter boundaries

Preservation map:

| Old topic | Current owner |
| --- | --- |
| Package split/dependency direction | `patterns/PACKAGE_ARCHITECTURE.md` |
| Package map | `packages/AGENTS.md` |
| App-owned product boundaries | `examples/next/AGENTS.md` |
| Agent loop/runtime/client details | `packages/agent/AGENTS.md` + package source READMEs |
