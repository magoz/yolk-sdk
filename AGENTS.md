# PROJECT KNOWLEDGE BASE

SDK-first pnpm/Turbo monorepo. Public packages live in `packages/*`; private runnable apps live in `examples/*` and `cloudflare/*`.

## CRITICAL RULES

- Use `pnpm` only.
- Run `pnpm tsc` before finishing.
- Run `pnpm lint` before finishing.
- Run `pnpm test:run` before committing broad changes.
- Run `pnpm packages:check` when touching `packages/*`.
- Run `pnpm cloudflare:check` when touching `cloudflare/*`.
- Agent tools must be runtime-portable: no Node-only imports/deps in `examples/next/lib/agents/tools/*`; use Effect `Config`, `HttpClient`, Schema, and Worker-safe adapters.
- Never commit generated `.next`, `.turbo`, `dist`, coverage, or env files.

## MONOREPO STRATEGY

| Area | Role |
| --- | --- |
| `packages/*` | Public `@yolk-sdk/*` SDK packages; domain-free, reusable, publishable |
| `examples/next` | Private Next.js dogfood/reference app; consumes packages like users |
| `cloudflare/agent` | Private Cloudflare Worker/Durable Object agent runtime |
| `examples/next/lib/*` | App-owned adapters/services/domain functions for the Next example |
| `examples/next/components/*` | App-owned UI components |
| `scripts/*` | Repo tooling; Node CLI boundary |
| `.repos/*` | Gitignored reference clones only; never workspace members |

`pnpm-workspace.yaml` owns workspace membership, catalogs, lockfile, and `workspace:^` links. `turbo.json` owns task orchestration/cache/order. Turbo does not replace pnpm workspaces.

## PATTERNS

- Repo-wide SDK/package patterns: `patterns/README.md`.
- Agent HITL approval/question semantics: `patterns/AGENT_HITL.md`.
- Provider-facing tool schema compatibility: `patterns/AI_TOOL_SCHEMAS.md`.
- Next-only patterns: `examples/next/patterns/README.md`.
- Patterns describe intent; code describes reality. Check code before assuming.

## EFFECT / TYPESCRIPT RULES

| Rule | Description |
| --- | --- |
| `local/no-disable-validation` | Never use `{ disableValidation: true }` |
| `local/no-catch-all-cause` | Never use `Effect.catchCause` |
| `local/no-schema-from-self` | Never use `*FromSelf` schemas |
| `local/no-schema-decode-sync` | Never use sync Schema decode/encode |
| `local/prefer-option-from-nullable` | Use Effect nullish helpers |
| `@typescript-eslint/no-explicit-any` | Never use `any` |
| `@typescript-eslint/consistent-type-assertions` | Never use `as Type` casts |
| `local/no-node-deps-in-agent-tools` | Never import Node-only deps/raw `fetch()` in app tools |

Effect v4 notes: use `Context.Service`, `Effect.catch`, `Result`, `Logger.layer([Logger.consolePretty()])`, `Schema.TaggedErrorClass` when schema-bound errors are needed.

## ENV BOUNDARIES

- Effect app/service code uses `Config.*` inside `Effect.gen`; map config errors around the whole block.
- Direct `process.env` only in sync framework/config boundaries: root configs, `examples/next/lib/dotenv.ts`, Playwright setup/fixtures env handoff, sync SDK callbacks like `TelemetryLayer`.
- Never add direct `dotenv.config()` outside `examples/next/lib/dotenv.ts`.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Package code | `packages/*` | See `packages/AGENTS.md` |
| Package release | `patterns/PACKAGE_DISTRIBUTION.md` | Changesets + canary flow |
| Next app/page/API | `examples/next/app` | See `examples/next/AGENTS.md` + nested docs |
| Next patterns | `examples/next/patterns` | Pages, API routes, actions, nuqs, UX |
| Server actions/domain | `examples/next/lib/core/*` | App-owned; see local docs |
| Services/adapters | `examples/next/lib/services/*` | App-owned; see local docs |
| App agent wiring | `examples/next/lib/agents/*` | Provider selection, tools, MCP, runtime layers |
| UI components | `examples/next/components/ui` | App-owned Base UI/shadcn; see local docs |
| E2E | `examples/next/e2e` | Playwright; fixed port, no portless |
| Cloudflare app | `cloudflare/agent` | Worker/DO; explicit `.ts` relative imports |
| Scripts | `scripts` | Node/process/console/raw JSON exceptions documented locally |
| Local lint rules | `eslint-local-rules` | ESLint custom rules |

## PACKAGE BOUNDARIES

- `packages/*` must not import from `examples/*` or `cloudflare/*`.
- Packages use `@yolk-sdk/*` names and explicit subpath exports.
- Public packages release in lockstep via Changesets fixed group.
- `@yolk-sdk/cloudflare-agent` stays private and ignored by Changesets.
- Keep package roots tiny; source exports for workspace dev, `publishConfig.exports` to `dist`.

## APP BOUNDARIES

- CRUD mutations use server actions in `examples/next/lib/core/[domain]/*-action.ts`, not API routes.
- API routes are HTTP/webhook/streaming boundaries only.
- App-owned tools in `examples/next/lib/agents/tools/*` must stay runtime-portable.
- Next/Auth/UI rules live under `examples/next/*` docs, not root.

## REFERENCE REPOS

| Repo | Location | Use |
| --- | --- | --- |
| `effect-smol` | `.repos/effect` | Effect v4 source/docs |
| `ai-sdk` | `.repos/ai` | SDK/package/examples monorepo reference |
| `opencode` | `.repos/opencode` | Codex/OpenAI agent protocol/provider reference |
| `opencode-simulation` | `.repos/opencode-simulation` | opencode simulation/property testing reference |
| `fast-check` | `.repos/fast-check` | property-based testing internals/examples |
| `executor` | `.repos/executor` | Connector/source/tool/plugin architecture reference |
| `t3code` | `.repos/t3code` | Agent chat/product UI reference |
| `mcp-sdk` | `.repos/mcp-sdk` | MCP protocol reference |
| `pi`, `kody`, `flue`, `clanka` | `.repos/*` | Architecture/tooling inspiration |

Reference repos are shallow, gitignored, read-only inspiration. Run `pnpm clone-repos` to fetch. Keep `.repos/**` out of workspace, lint, typecheck, test, and build.

## NOTES

- No full CI; Vercel auto-deploys app. Package publish uses GitHub Actions.
- React Compiler enabled.
- PostHog proxied via `/ph/*`.
- Drizzle v1 RC with Effect-native driver.
- LSP may show stale Effect v3 errors; trust `pnpm tsc`.
- Root Vitest may discover package tests; `pnpm test:run` also runs package tests.
- This is canonical root knowledge.
