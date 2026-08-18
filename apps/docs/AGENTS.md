# Docs App

Private Fumadocs/Next site for public `@yolk-sdk/*` package documentation.

## Role

- Explain package APIs, subpaths, host responsibilities, and canary constraints.
- Keep public package docs aligned with `packages/*/package.json`, `README.md`, and `AGENTS.md`.
- Mark app-owned examples as host integration, not SDK API.

## Content rules

- Follow `.agents/skills/docs-sync/SKILL.md` for the canonical audit, writing, discovery-page, and validation workflow.
- Lead with the smallest runnable path; keep architecture and reference details secondary.
- Use real exported symbols and descriptive host-owned placeholders; never invent imports.
- Keep auth, storage, DB, credentials, UI, deployment, and policy clearly host-owned.
- Mark fragments; runnable examples include setup, filename, run command, and expected result.
- Use concise sentence-case headings, stable links, active voice, and task-first procedures.
- Keep providers, connectors, integrations, subpaths, and action IDs discoverable in catalogs.
- Never include secrets, real tokens, private IDs, raw provider error bodies, or stability promises during canary.
- Keep contributor-only guidance in owner docs, not public pages.

## Rules

- Content lives in `content/docs`; nav order lives in `content/docs/**/meta.json`.
- Fumadocs config lives in `source.config.ts`; generated `.source` is ignored.
- Use relative imports in app code so root `tsc` does not resolve docs aliases to `examples/next`.
- Do not add auth, DB, telemetry, or product policy here unless the docs site itself needs it.
- Run `pnpm docs:check` after docs changes.
- Run `pnpm build:docs` after routing/config changes.
- Run docs checks/builds serially; both regenerate `.source`/`.next` types, and concurrent runs can produce transient TS6053 missing-file failures.
