---
name: tidy
description: Maintains Yolk repo knowledge docs. Use when cleaning AGENTS.md, patterns, monorepo docs, stale paths, duplicated rules, or docs after repo structure changes.
---

# Tidy

Keep Yolk's knowledge hierarchy accurate, concise, and boundary-aware.

Default mode: surgical update. Do not rewrite from scratch unless user passes `--create-new`.

## Scope

Tidy:

- `AGENTS.md` hierarchy
- `patterns/README.md` and root `patterns/*`
- `examples/next/patterns/*`
- stale path references after moves
- duplicated parent/child rules
- docs that violate monorepo boundaries

Do not tidy source code unless docs require tiny path/config updates.

## Arguments

| Arg | Meaning |
| --- | --- |
| `--check` | Report only. Do not edit. |
| `--docs` | Docs only. Default. |
| `--create-new` | Read existing first, then rebuild docs. Ask before using. |
| `--max-depth=N` | Limit AGENTS scan depth. Default: 5. |

## Repo Knowledge Model

| Area | Doc owner | Rules |
| --- | --- | --- |
| Root `AGENTS.md` | Monorepo contract | SDK-first strategy, commands, boundaries only |
| `patterns/*` | Repo-wide reusable patterns | Packages, shared Effect/TS/testing/telemetry only |
| `examples/next/*` | Next app docs | App Router, server actions, API routes, auth, nuqs, UX |
| `packages/*` | Public SDK docs | Domain-free package contracts and exports |
| `lib/*` | App-owned backend docs | Services, domain actions, app agent wiring |
| `cloudflare/*` | Worker app docs | Durable Object/Worker/runtime specifics |
| `.repos/*` | Reference only | Never index, edit, lint, or workspace |

## Workflow

### 1. Plan + todos

Use TodoWrite for non-trivial runs:

1. Audit docs and stale refs
2. Classify misplaced knowledge
3. Edit surgically
4. Validate

### 2. Discover docs

Use Glob/Read/Grep, not shell `find`/`grep`.

Read first:

- `AGENTS.md`
- `patterns/README.md`
- `examples/AGENTS.md`
- `examples/next/AGENTS.md`
- `examples/next/patterns/README.md`
- relevant nested `AGENTS.md`

Glob:

- `**/AGENTS.md`
- `patterns/*.md`
- `examples/next/patterns/*.md`

Ignore:

- `.repos/**`
- `node_modules/**`
- `.next/**`
- `.turbo/**`
- `dist/**`
- coverage/output dirs

### 3. Classify problems

Move or rewrite content by boundary:

- Next/App Router rules in root → `examples/next/AGENTS.md`, `examples/next/app/AGENTS.md`, or `examples/next/patterns/*`
- Package release/build/export rules → `packages/AGENTS.md` or `patterns/PACKAGE_DISTRIBUTION.md`
- Domain-free package architecture → `patterns/PACKAGE_ARCHITECTURE.md`
- App-owned service/domain rules → `lib/services/AGENTS.md`, `lib/core/AGENTS.md`, or local child docs
- Cloudflare Worker/DO rules → `cloudflare/agent/AGENTS.md`
- Reference repo notes → root `REFERENCE REPOS`, never `.repos/**` docs

### 4. AGENTS.md rules

Root `AGENTS.md` should stay compact:

- max ~150 lines
- no giant codemap
- no Next page/API details
- no package-specific export list
- no duplicated child rules
- must include pnpm/Turbo strategy and `.repos` boundary

Child `AGENTS.md`:

- max ~80 lines unless truly dense
- never repeats parent rules except critical local reminders
- sections: Role/Structure/Rules/Anti-patterns/Commands only as needed
- prefer links to patterns over copying pattern text

### 5. Pattern placement rules

Root `patterns/*` keeps only repo-wide/shared docs:

- `PACKAGE_ARCHITECTURE.md`
- `PACKAGE_DISTRIBUTION.md`
- shared Effect/TS/testing/MCP/telemetry docs

`examples/next/patterns/*` keeps Next-only docs:

- pages/layouts/Suspense
- API routes
- server actions
- RSC/data flow
- nuqs URL state
- app UX/forms/navigation

When moving a pattern, update every link. Do not leave compatibility pointer files unless user asks.

### 6. Stale reference checks

Always grep for moved/stale refs relevant to the run:

- `app/` → should usually be `examples/next/app/`
- `patterns/EFFECT_PAGES`, `patterns/EFFECT_API_ROUTES`, `patterns/EFFECT_SERVER_ACTIONS`
- `patterns/DATA_ACCESS_PATTERNS`, `patterns/NUQS_URL_STATE`, `patterns/USABILITY_BEST_PRACTICES`
- removed integrations like `Sentry` if recently removed
- generated dirs: `.next`, `.turbo`, `dist`

Keep references to literal app route paths (`/app`, `/api/...`) when they are URLs/routes, not filesystem paths.

### 7. Edit style

- Minimal, surgical changes.
- Telegraphic style.
- Prefer tables for maps.
- Prefer “where to look” over long explanations.
- Delete generic advice.
- Preserve useful project-specific gotchas.

### 8. Validation

For docs-only runs:

- link/stale-ref grep sanity
- `pnpm tsc`
- `pnpm lint`

When touching package docs/boundaries:

- `pnpm packages:check`

When touching Cloudflare docs/boundaries:

- `pnpm cloudflare:check`

When changing executable scripts/config:

- run the targeted script/check too.

## Report

Final response:

- files moved/updated
- misplaced knowledge fixed
- stale refs checked
- validation run + result
- no commit unless explicitly requested

## Anti-patterns

- Regenerating everything by default.
- Creating AGENTS.md for every directory.
- Duplicating root rules in children.
- Putting Next-only rules in root `patterns/*`.
- Indexing `.repos/**` as project code.
- Adding generated `.next`, `.turbo`, `dist`, coverage, or env files.
- Committing without explicit user request.
