# Packages

Public `@yolk-sdk/*` packages. Domain-free SDK surface; apps own product policy, storage, auth, prompts, provider selection, and UI.

## Package map

| Package | Role | Local docs |
| --- | --- | --- |
| `@yolk-sdk/agent` | Agent protocol, loop, runtime, client, tools, React, providers, OAuth, skillset, voice | `packages/agent/AGENTS.md` |
| `@yolk-sdk/mcp` | MCP client/server/protocol package | `packages/mcp/AGENTS.md` |
| `@yolk-sdk/knowledge` | Knowledge record/artifact/context/search contracts | `packages/knowledge/AGENTS.md` |
| `@yolk-sdk/connectors` | Effect-native connector/integration/action primitives | `packages/connectors/AGENTS.md` |
| `@yolk-sdk/vercel-workflows` | Vercel Workflows agent loop contract | `packages/vercel-workflows/AGENTS.md` |

## Dependency direction

```txt
examples/next, cloudflare/agent, e2e -> @yolk-sdk/*
knowledge -> agent/protocol + agent/tools + agent/loop only for agent adapter
mcp -> agent/protocol only for tool/content adapters
agent core -> no knowledge/mcp/app/Next/provider SDKs
agent/react -> agent/client + agent/protocol + optional React peer
agent/providers -> agent/oauth + agent/loop + agent/protocol + Effect
connectors -> agent/protocol + agent/loop + agent/tools only through ./agent; no app/storage/auth/UI policy
agent/voice -> agent/loop + agent/protocol
```

## Rules

- Package architecture: `patterns/PACKAGE_ARCHITECTURE.md`.
- Package distribution/release: `patterns/PACKAGE_DISTRIBUTION.md`.
- Keep roots tiny; feature APIs use explicit subpaths.
- Use source exports for workspace dev; npm `publishConfig.exports` points to `dist`.
- Package-internal relative imports use explicit `.ts` extensions.
- Keep package APIs generic over host context; never model app users, teams, orgs, projects, billing, token storage, or product permissions.
- Provider/OAuth subpaths may model vendor auth mechanics, wire contracts, and agent provider adapters, not host storage or policy.
- Public package manifests include release metadata, `files`, `publishConfig`, and `tsdown` build scripts. Keep private app packages private.
- Retired standalone package dirs/imports are forbidden; use unified subpaths checked by `scripts/check-package-boundaries.ts`.
- When public packages/subpaths change, update package `exports`, `publishConfig.exports`, `scripts/check-package-exports.ts`, and `scripts/smoke-package-imports.ts` together.

## Commands

- Check packages: `pnpm packages:check`
- Build packages: `pnpm packages:build`
- Publish validation: `pnpm packages:build && pnpm packages:publint && pnpm packages:smoke`
- Package tests run through root `pnpm test:run` unless a local doc says otherwise.
