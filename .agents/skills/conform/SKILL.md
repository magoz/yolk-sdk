---
name: conform
description: Audits and fixes code against Yolk repo patterns. Use when code should align with AGENTS.md, patterns/*.md, examples/next/patterns/*.md, and package/cloudflare boundaries.
---

# Conform

Make implementation code conform to Yolk's documented patterns.

This is code-changing. For docs-only cleanup, use `/tidy`.

## Scope

Conform checks and fixes:

- monorepo package/app/cloudflare boundaries
- public package exports, release-readiness, and SDK-first constraints
- Effect v4 service, config, schema, error, layer, and test patterns
- Next App Router page/action/API/domain boundaries
- app-owned agent tool runtime portability
- provider-facing AI tool schema compatibility
- HITL approval/question semantics
- telemetry/reporting placement
- tests and e2e safety
- TypeScript/style conventions when touched

Do not rewrite broad areas. Patch the smallest safe slice.

## Arguments

| Arg                 | Meaning                            |
| ------------------- | ---------------------------------- |
| `--check`           | Audit only. Do not edit.           |
| `--area=packages`   | Focus `packages/*`.                |
| `--area=next`       | Focus `examples/next/*`.           |
| `--area=cloudflare` | Focus `cloudflare/*`.              |
| `--area=agents`     | Focus app agent wiring/tools/HITL. |
| `--area=test`       | Focus unit/e2e tests.              |
| `--all`             | Broad audit and fixes.             |

## Workflow

### 1. Plan

For every non-trivial run, keep a short inline plan:

1. Audit relevant owner docs and patterns
2. Find violations
3. Patch surgically
4. Verify
5. Report remaining gaps

### 2. Read pattern docs first

Always read relevant owner docs before editing:

- `AGENTS.md`
- nearest nested `AGENTS.md`
- `patterns/README.md`
- task-specific root patterns:
  - packages: `patterns/PACKAGE_ARCHITECTURE.md`, `patterns/PACKAGE_DISTRIBUTION.md`
  - Effect: `patterns/EFFECT_BEST_PRACTICES.md`, `patterns/EFFECT_TESTING.md`, `patterns/SIMULATION_PROPERTY_TESTING.md`
  - AI tools: `patterns/AI_TOOL_SCHEMAS.md`, `patterns/AGENT_HITL.md`, `patterns/MCP_TRANSPORTS.md`
  - telemetry: `patterns/TELEMETRY.md`
  - tests: `patterns/TESTING_STRATEGY.md`
  - TS: `patterns/TYPESCRIPT_CONVENTIONS.md`
- task-specific Next patterns:
  - pages: `examples/next/patterns/EFFECT_PAGES.md`
  - actions: `examples/next/patterns/EFFECT_SERVER_ACTIONS.md`
  - API routes: `examples/next/patterns/EFFECT_API_ROUTES.md`
  - domain/data: `examples/next/patterns/EFFECT_DOMAIN_FUNCTIONS.md`, `examples/next/patterns/DATA_ACCESS_PATTERNS.md`
  - URL state/UX: `examples/next/patterns/NUQS_URL_STATE.md`, `examples/next/patterns/USABILITY_BEST_PRACTICES.md`
  - E2E: `examples/next/patterns/E2E_TESTING.md`

Use the harness's file discovery, read, and content-search tools. In Pi, prefer `fd`, `read`, and
`rg` over shell `find`/`grep`.

### 3. Audit targets

Check common violations:

#### Monorepo boundaries

- `packages/*` importing from `examples/*` or `cloudflare/*`
- private app code leaking into public package exports
- missing or stale package subpath exports
- package roots with too much implementation detail
- generated `.next`, `.turbo`, `dist`, coverage, or env files
- direct `process.env` outside approved sync config boundaries

#### Packages

- domain-specific logic in reusable SDK packages
- public APIs with weak schema or nullable state instead of typed unions
- publish config not matching source exports
- missing README/package docs for changed public subpaths
- changes requiring Changeset without one

#### Effect / TypeScript

- `{ disableValidation: true }`
- `Effect.catchCause`
- `*FromSelf` schemas
- sync Schema decode/encode
- missing `Option.fromNullishOr` / nullish helpers
- untyped catch-all recovery that hides failures
- Node-only imports where runtime-portability is required
- `any`, non-null assertions, or type assertions

#### Next pages/actions/API/domain

- API routes used for browser CRUD instead of server actions
- missing `'use server'` in server action files
- request/UI concerns in domain code: redirect, notFound, revalidate, Response, toast, raw reportError
- weak action return shapes instead of discriminated unions
- `tapError(reportError)` after conversion to UI result
- missing `Effect.withSpan` on domain functions where patterns require it
- Suspense fallback not shape-matched

#### App agent tools / HITL

- Node-only imports/deps or raw `fetch()` in `examples/next/lib/agents/tools/*`
- provider-incompatible schemas for AI-facing tools
- approval/question state encoded as nullable flags instead of explicit tagged states
- MCP transport assumptions not isolated behind adapters

#### Cloudflare

- missing explicit `.ts` on relative imports
- Node/runtime-incompatible APIs in Worker/Durable Object code
- package imports that bypass public subpaths

#### Tests

- package changes without targeted package tests/checks
- Effect tests using non-Effect helpers where `@effect/vitest` fits
- DB/e2e tests lacking safe guards or retry-safe setup
- Playwright selectors weaker than role/label/text when available
- external network dependency in e2e

### 4. Patch rules

- Minimal, surgical changes.
- Preserve behavior unless pattern requires safer behavior.
- Prefer typed unions and ADTs over nullable flags.
- Parse inputs at boundaries into typed structures.
- No `any`, non-null assertions, or type assertions.
- Do not weaken schemas, auth, runtime portability, or package boundaries.
- Do not commit unless user asks.
- Do not touch unrelated formatting churn.

### 5. Verification

Run narrow checks first, then required repo checks when practical:

```bash
pnpm tsc
pnpm lint
```

When touching `packages/*`:

```bash
pnpm packages:check
```

When touching `cloudflare/*`:

```bash
pnpm cloudflare:check
```

For broad changes:

```bash
pnpm test:run
```

For e2e-affecting changes, run targeted Playwright when feasible.

If a check fails because of unrelated pre-existing work, report exact blockers and avoid hiding them.

### 6. Report

Final response:

- patterns enforced
- files changed by area
- checks run + result
- remaining gaps, if any
- unrelated blockers, if any

## Anti-patterns

- Treating `/conform` as docs cleanup; use `/tidy` instead.
- Large rewrites across unrelated features.
- Fixing lint by weakening types.
- Hiding expected failures by returning generic success.
- Committing without explicit request.
