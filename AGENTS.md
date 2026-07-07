# PROJECT KNOWLEDGE BASE

SDK-first pnpm/Turbo monorepo. Public packages live in `packages/*`; private product/docs apps live in `apps/*`; private runnable examples live in `examples/*` and `cloudflare/*`.

## CRITICAL RULES

- Use `pnpm` for repo/package scripts; use `npm` only for registry publish/view/trust flows documented in `patterns/PACKAGE_DISTRIBUTION.md`.
- Run `pnpm tsc` before finishing.
- Run `pnpm lint` before finishing.
- Run `pnpm test:run` before committing broad changes.
- Run `pnpm packages:check` when touching `packages/*`.
- Run `pnpm docs:check` when touching `apps/docs`.
- Run `pnpm cloudflare:check` when touching `cloudflare/*`.
- Follow local `AGENTS.md` before editing scoped app/package areas; root owns repo-wide boundaries only.
- Never commit ignored generated/dev artifacts (`.next`, `.turbo`, `.source`, package `dist`, `.alchemy`, `.workflow-*`, `playwright-report`, `test-results`, coverage, `*.tsbuildinfo`, `next-env.d.ts`) or env files; tracked generated fallbacks need owning docs.

## MONOREPO STRATEGY

| Area                         | Role                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `packages/*`                 | Public `@yolk-sdk/*` SDK packages; domain-free, reusable, publishable |
| `apps/docs`                  | Private Fumadocs/Next SDK documentation site                          |
| `examples/next`              | Private Next.js dogfood/reference app; consumes packages like users   |
| `cloudflare/agent`           | Private Cloudflare Worker/Durable Object agent runtime                |
| `examples/next/lib/*`        | App-owned adapters/services/domain functions for the Next example     |
| `examples/next/components/*` | App-owned UI components                                               |
| `scripts/*`                  | Repo tooling; Node CLI boundary                                       |
| `.repos/*`                   | Gitignored reference clones only; never workspace members             |

`pnpm-workspace.yaml` owns workspace membership, catalogs, lockfile, and `workspace:^` links. `turbo.json` owns task orchestration/cache/order. Turbo does not replace pnpm workspaces.

## PATTERNS

- Repo-wide SDK/package patterns: `patterns/README.md`.
- Agent HITL approval/question semantics: `patterns/AGENT_HITL.md`.
- Provider-facing tool schema compatibility: `patterns/AI_TOOL_SCHEMAS.md`.
- Next-only patterns: `examples/next/patterns/README.md`.
- Patterns describe intent; code describes reality. Check code before assuming.

## EFFECT / TYPESCRIPT RULES

| Rule                                            | Description                                            |
| ----------------------------------------------- | ------------------------------------------------------ |
| `local/no-disable-validation`                   | Never use `{ disableValidation: true }`                |
| `local/no-catch-all-cause`                      | Never use `Effect.catchCause`                          |
| `local/no-schema-from-self`                     | Never use `*FromSelf` schemas                          |
| `local/no-schema-decode-sync`                   | Never use sync Schema decode/encode                    |
| `local/prefer-option-from-nullable`             | Use Effect nullish helpers                             |
| `@typescript-eslint/no-explicit-any`            | Never use `any`                                        |
| `@typescript-eslint/consistent-type-assertions` | Never use `as Type` casts                              |
| `local/no-node-deps-in-agent-tools`             | Never import Node-only deps/raw `fetch()` in app tools |

Effect v4 notes: use `Context.Service`, `Effect.catch`, `Result`, `Logger.layer([Logger.consolePretty()])`, `Schema.TaggedErrorClass` when schema-bound errors are needed.

## ENV BOUNDARIES

- Effect app/service code uses `Config.*` inside `Effect.gen`; map config errors around the whole block.
- Direct `process.env` only in sync config/script/test boundaries: root/app configs, `examples/next/lib/dotenv.ts`, Playwright setup/fixtures/spec skips, property-test helpers, app DB scripts, and sync SDK callbacks like `TelemetryLayer`.
- Never add direct `dotenv.config()` outside `examples/next/lib/dotenv.ts`.

## WHERE TO LOOK

| Task                  | Location                           | Notes                                                       |
| --------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Package code          | `packages/*`                       | See `packages/AGENTS.md`                                    |
| Package release       | `patterns/PACKAGE_DISTRIBUTION.md` | Changesets + canary flow                                    |
| Docs app/content      | `apps/docs`                        | Fumadocs site; public package docs                          |
| Next app/page/API     | `examples/next/app`                | See `examples/next/AGENTS.md` + nested docs                 |
| Next patterns         | `examples/next/patterns`           | Pages, API routes, actions, nuqs, UX                        |
| Server actions/domain | `examples/next/lib/core/*`         | App-owned; see local docs                                   |
| Services/adapters     | `examples/next/lib/services/*`     | App-owned; see local docs                                   |
| App agent wiring      | `examples/next/lib/agents/*`       | Provider selection, tools, MCP, runtime layers              |
| UI components         | `examples/next/components/ui`      | App-owned Base UI/shadcn; see local docs                    |
| E2E                   | `examples/next/e2e`                | Playwright; fixed port, no portless                         |
| Cloudflare app        | `cloudflare/agent`                 | Worker/DO; explicit `.ts` relative imports                  |
| Scripts               | `scripts`                          | Node/process/console/raw JSON exceptions documented locally |
| Local lint rules      | `eslint-local-rules`               | ESLint custom rules                                         |

## PACKAGE BOUNDARIES

- `packages/*` must not import from `apps/*`, `examples/*`, or `cloudflare/*`.
- Packages use `@yolk-sdk/*` names and explicit subpath exports.
- Public packages release in lockstep via Changesets fixed group.
- `@yolk-sdk/cloudflare-agent` stays private and ignored by Changesets.
- Keep package roots intentional: `agent`/`mcp` empty; `knowledge`/`connectors`/`sandbox`/`vercel-workflows` core-only; feature APIs use explicit subpaths; source exports for workspace dev, `publishConfig.exports` to `dist`.

## APP BOUNDARIES

- App-owned code stays outside packages unless it becomes domain-free SDK surface.
- Docs app content in `apps/docs` documents public package APIs; do not present app-owned example details as SDK APIs.
- Next page/API/server-action/tool/auth/UI rules live under `examples/next/*` docs and patterns, not root.

## REFERENCE REPOS

| Repo                           | Location                     | Use                                                 |
| ------------------------------ | ---------------------------- | --------------------------------------------------- |
| `effect-smol`                  | `.repos/effect`              | Effect v4 source/docs                               |
| `ai-sdk`                       | `.repos/ai`                  | SDK/package/examples monorepo reference             |
| `opencode`                     | `.repos/opencode`            | Codex/OpenAI agent protocol/provider reference      |
| `opencode-simulation`          | `.repos/opencode-simulation` | opencode simulation/property testing reference      |
| `fast-check`                   | `.repos/fast-check`          | property-based testing internals/examples           |
| `executor`                     | `.repos/executor`            | Connector/source/tool/plugin architecture reference |
| `t3code`                       | `.repos/t3code`              | Agent chat/product UI reference                     |
| `mcp-sdk`                      | `.repos/mcp-sdk`             | MCP protocol reference                              |
| `pi`, `kody`, `flue`, `clanka` | `.repos/*`                   | Architecture/tooling inspiration                    |

Reference repos are shallow, gitignored, read-only inspiration. Run `pnpm clone-repos` to fetch. Keep `.repos/**` out of workspace, lint, typecheck, test, and build.

## NOTES

- No full CI; Vercel auto-deploys app. Package publish uses GitHub Actions.
- React Compiler enabled.
- PostHog proxied via `/ph/*`.
- Drizzle v1 RC with Effect-native driver.
- LSP may show stale Effect v3 errors; trust `pnpm tsc`.
- Root Vitest may discover package tests; `pnpm test:run` also runs package tests.
- This is canonical root knowledge.
