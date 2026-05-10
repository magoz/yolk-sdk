# PROJECT KNOWLEDGE BASE

Next.js 16 App Router app with Effect-TS services, Drizzle ORM (PostgreSQL/Neon), better-auth, Tailwind CSS 4, and `packages/*` reusable agent stack.

## CRITICAL RULES

- **Use `pnpm` exclusively** - not npm or yarn
- **Run `pnpm tsc` before finishing** - ensure types pass
- **Run `pnpm lint` to check for errors** - fix any issues
- **Run `pnpm test:run` to verify tests pass** - fix failures before committing

### Effect-TS Rules (Enforced by ESLint)

| Rule                                            | Description                                           |
| ----------------------------------------------- | ----------------------------------------------------- |
| `local/no-disable-validation`                   | NEVER use `{ disableValidation: true }`               |
| `local/no-catch-all-cause`                      | NEVER use `Effect.catchCause` - catches defects       |
| `local/no-schema-from-self`                     | NEVER use `*FromSelf` schemas (use standard variants) |
| `local/no-schema-decode-sync`                   | NEVER use sync decode/encode (throws exceptions)      |
| `local/prefer-option-from-nullable`             | Use `Option.fromNullable()` instead of ternary        |
| `@typescript-eslint/no-explicit-any`            | NEVER use `any` type                                  |
| `@typescript-eslint/consistent-type-assertions` | NEVER use `as` type casts                             |

See `patterns/EFFECT_BEST_PRACTICES.md` for detailed explanations and alternatives.

## PATTERNS

**Before implementing any feature, consult `patterns/README.md`.**

- **Patterns describe intent; code describes reality.** Check the codebase first before assuming something is/isn't implemented.
- **Use patterns as guidance.** Follow patterns, types, and architecture defined in relevant files.

## CAPABILITIES

| Capability         | Service   | Details                                              |
| ------------------ | --------- | ---------------------------------------------------- |
| Authentication     | Auth      | Sign up, sign in, sign out, sessions, OTP email flow |
| Database           | Db        | PostgreSQL via Drizzle ORM (Neon serverless)         |
| Email sending      | Email     | Transactional email via Resend                       |
| Observability      | Telemetry | OpenTelemetry spans + Sentry error tracking          |
| UI components      | shadcn/ui | Base UI primitives (not Radix), see `components/ui/` |
| Agent stack        | packages  | Domain-free protocol, agent-loop, runtime, client    |

## WHERE TO LOOK

| Task                 | Location                             | Notes                                        |
| -------------------- | ------------------------------------ | -------------------------------------------- |
| Add server action    | `lib/core/[domain]/*-action.ts`      | One action per file, see EFFECT_SERVER_ACTIONS |
| Add domain function  | `lib/core/[domain]/*.ts`             | Pure Effect functions, see EFFECT_DOMAIN_FUNCTIONS |
| Add new service      | `lib/services/[name]/`               | Follow `lib/services/AGENTS.md` pattern      |
| Add dynamic page     | `app/*/page.tsx`                     | See EFFECT_PAGES for Suspense pattern        |
| Add API route        | `app/api/[route]/route.ts`           | Only webhooks/external APIs, see EFFECT_API_ROUTES |
| Add UI component     | `components/ui/`                     | Uses Base UI, not Radix                      |
| Add tests            | `lib/core/[domain]/*.test.ts`        | Colocated with source, use @effect/vitest    |
| Add E2E tests        | `e2e/`                               | Playwright tests (api/, ui/, fixtures)       |
| Database schema      | `lib/services/db/schema.ts`          | Drizzle ORM                                  |
| Auth flow            | `app/(auth)/`                        | better-auth + OTP email                      |
| Service dependencies | `lib/layers.ts`                      | AppLayer merges all services                 |
| Error types          | `lib/core/errors/index.ts`           | Shared domain errors                         |
| URL state (filters)  | `app/*/search-params.ts`             | nuqs/server imports only, see NUQS pattern   |
| Code style & naming  | `patterns/TYPESCRIPT_CONVENTIONS.md` | Prettier, kebab-case, file naming            |
| Reusable agent stack | `packages/AGENTS.md`                 | Package boundaries and naming                |
| Agent loop design    | `AGENT_LOOP.md`                      | Stateless loop details and decisions         |

## CODE MAP

| Symbol                  | Type     | Location                                   | Role                                                |
| ----------------------- | -------- | ------------------------------------------ | --------------------------------------------------- |
| `AppLayer`              | Layer    | `lib/layers.ts`                            | Merged service layer for Effect pipelines           |
| `NextEffect.runPromise` | Function | `lib/next-effect/index.ts`                 | Handles redirects + notFound outside Effect context |
| `NextEffect.redirect`   | Function | `lib/next-effect/index.ts`                 | Redirect intent (use inside Effect pipelines)       |
| `NextEffect.notFound`   | Function | `lib/next-effect/index.ts`                 | NotFound intent (use inside Effect pipelines)       |
| `Auth`                  | Service  | `lib/services/auth/live-layer.ts`          | Authentication (sign in/up/out, sessions)           |
| `Db`                    | Service  | `lib/services/db/live-layer.ts`            | Database (returns Drizzle client)                   |
| `Email`                 | Service  | `lib/services/email/live-layer.ts`         | Resend email sending                                |
| `TelemetryLayer`        | Layer    | `lib/services/telemetry/live-layer.ts`     | OpenTelemetry + Sentry span/log processing          |
| `reportError`           | Function | `lib/services/telemetry/report-error.ts`   | Log error + Sentry capture (boundaries only)        |
| `reportWarning`         | Function | `lib/services/telemetry/report-warning.ts` | Log warning + Sentry warning (degraded paths)       |
| `run`                   | Function | `packages/agent-loop/src/run.ts`           | Stateless LLM/tool loop                            |
| `runRuntime`            | Function | `packages/agent-runtime/src/run-runtime.ts` | Session load/save orchestration over agent loop     |

## ANTI-PATTERNS (THIS PROJECT)

| Pattern                                             | Correct Approach                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| API routes for CRUD operations                      | Server actions (`lib/core/[domain]/*-action.ts`)                                         |
| Streaming files through server                      | Signed direct uploads (R2/S3); add file service first                                    |
| `process.env.X` with throws                         | `yield* Config.string('X')`                                                              |
| `router.push()` for logout                          | `window.location.href = '/'` (layout cache issue)                                        |
| Barrel files (`index.ts` re-exports)                | Import from `live-layer.ts` directly                                                     |
| `Effect.runPromise()` in pages                      | `NextEffect.runPromise()` (handles redirects)                                            |
| Layer `dependencies` option                         | `Layer.provide()` externally                                                             |
| Multiple services per directory                     | One service per directory                                                                |
| Multiple actions per file                           | One action per file ending in `-action.ts`                                               |
| `useState` for shareable UI state                   | nuqs URL state (`app/*/search-params.ts`)                                                |
| Import `parseAs*` from `nuqs`                       | Import from `nuqs/server` in search-params.ts                                            |
| Direct data fetch in page component                 | Suspense + Content pattern (see EFFECT_PAGES)                                            |
| Ad hoc nested async components                      | Use EFFECT_PAGES Shell + independent streaming sections pattern                          |
| Missing `export const dynamic`                      | Add `export const dynamic = 'force-dynamic'` for auth                                    |
| `matchEffect` for error handling                    | `catchTag` chains + `Effect.catch` catch-all                                             |
| `Config.string('X').pipe(Effect.mapError(...))`     | Yield Config directly, map errors on whole block                                         |
| `ServiceMap.Service<Self>()(id, { make })`          | `Context.Service<Self>()(id, { make })` — `ServiceMap` renamed to `Context` in Effect v4 |
| `Logger.pretty`                                     | `Logger.layer([Logger.consolePretty()])` — `Logger.pretty` removed in v4                 |
| `@effect/platform-node` for Db service              | `PgDrizzle.make()` from `drizzle-orm/effect-postgres` — handles connection internally    |
| `drizzle(client, { schema })` manual setup          | `PgDrizzle.make({ relations })` — Effect-native, every query is an Effect                |
| `Schema.TaggedError`                                | `Schema.TaggedErrorClass` — renamed in v4. Or use `Data.TaggedError` for simpler errors  |
| `Either.isRight(r)` / `r.right`                     | `Result.isSuccess(r)` / `r.success` — `Either` renamed to `Result` in v4                 |
| `Effect.catchAll(handler)`                          | `Effect.catch(handler)` — v4 rename                                                      |
| `FiberRef.unsafeMake` / `FiberRef.get`              | `Context.Reference` + `References.*` — `FiberRef` removed in v4                          |
| `dotenv.config({ path: '.env.local' })` in a module | `import '@/lib/dotenv'` — centralized, respects `NODE_ENV=test` → `.env.test`            |

## NOTES

- **No CI/CD configured** - deployment via Vercel auto-deploy
- **React Compiler enabled** - automatic memoization (experimental)
- **PostHog proxied** - requests via `/ph/*` rewrites to bypass ad-blockers
- **Drizzle v1 RC** - using `1.0.0-rc.1` with Effect-native driver (`drizzle-orm/effect-postgres`)
- Effect v4: services use `Context.Service`, errors use `catchTag` chains + `Effect.catch`
- **`@effect/platform-node` removed** - Db uses `PgDrizzle.make()` + `@effect/sql-pg` directly
- **LSP shows stale v3 errors** - always use `pnpm tsc` for accurate type checking
- **NextEffect.runPromise** required because Next.js redirects must be called outside try-catch

## SUBDIRECTORY DOCS

- `patterns/README.md` - Architecture and convention patterns index
- `lib/services/AGENTS.md` - Effect-TS service architecture, config, observability patterns
- `packages/AGENTS.md` - Domain-free reusable agent stack boundaries
- `components/ui/AGENTS.md` - UI component install sources and customizations
- `e2e/AGENTS.md` - E2E test patterns, locator priority, streaming guards, auth cookies
