# Packages

Public `@yolk-sdk/*` packages. Domain-free SDK surface; apps own product policy, storage, auth, prompts, providers, and UI.

## Package map

| Package | Role | Local docs |
| --- | --- | --- |
| `@yolk-sdk/agent` | Protocol, loop, runtime, client, tool registry | `packages/agent/AGENTS.md` |
| `@yolk-sdk/react` | Headless React hooks over agent client state | `packages/react/AGENTS.md` |
| `@yolk-sdk/mcp` | MCP client/server/protocol package | `packages/mcp/AGENTS.md` |
| `@yolk-sdk/knowledge` | Knowledge record/artifact/context/retrieval contracts | `packages/knowledge/AGENTS.md` |
| `@yolk-sdk/connectors` | Effect-native connector/integration/action primitives | `packages/connectors/AGENTS.md` |
| `@yolk-sdk/oauth` | Provider-neutral OAuth token contracts | `packages/oauth/AGENTS.md` |
| `@yolk-sdk/openai` | OpenAI/Codex reusable provider mechanics | `packages/openai/AGENTS.md` |
| `@yolk-sdk/anthropic` | Anthropic/Claude reusable provider mechanics | `packages/anthropic/AGENTS.md` |
| `@yolk-sdk/skillset` | Portable skill + command parsing/catalog | `packages/skillset/AGENTS.md` |
| `@yolk-sdk/voice-runtime` | Provider-neutral voice tool-call bridge | `packages/voice-runtime/AGENTS.md` |
| `@yolk-sdk/vercel-workflows-runtime` | Vercel Workflow agent loop contract | `packages/vercel-workflows-runtime/AGENTS.md` |

## Dependency direction

```txt
examples/next, cloudflare/agent, e2e -> @yolk-sdk/*
react -> agent/client + agent/protocol
knowledge -> agent/protocol + agent/tools only for agent adapter
mcp -> agent/protocol only for ToolDef/ToolResult
agent -> no knowledge/react/mcp/app/Next/provider SDKs
provider packages -> oauth + Effect
connectors -> agent/tools only through ./agent; no app/storage/auth/UI policy
```

## Rules

- Package architecture: `patterns/PACKAGE_ARCHITECTURE.md`.
- Package distribution/release: `patterns/PACKAGE_DISTRIBUTION.md`.
- Keep roots tiny; feature APIs use explicit subpaths.
- Use source exports for workspace dev; npm `publishConfig.exports` points to `dist`.
- Package-internal relative imports use explicit `.ts` extensions.
- Keep package APIs generic over host context; never model app users, teams, orgs, projects, billing, token storage, or product permissions.
- Provider/OAuth packages may model vendor auth mechanics and wire contracts, not host storage or policy.
- Public package manifests include release metadata, `files`, `publishConfig`, and `tsdown` build scripts. Keep private app packages private.

## Commands

- Check packages: `pnpm packages:check`
- Build packages: `pnpm packages:build`
- Publish validation: `pnpm packages:publint && pnpm packages:smoke`
- Package tests run through root `pnpm test:run` unless a local doc says otherwise.
