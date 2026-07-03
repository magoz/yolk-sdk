# Docs App

Private Fumadocs/Next site for public `@yolk-sdk/*` package documentation.

## Role

- Explain package APIs, subpaths, host responsibilities, and canary constraints.
- Keep public package docs aligned with `packages/*/package.json`, `README.md`, and `AGENTS.md`.
- Mark app-owned examples as host integration, not SDK API.

## Documentation philosophy

- Docs are a product surface, not a package-internals map.
- Optimize for "what can I build now?" before "how is it architected?".
- Lead with runnable paths: install, minimal code, run it, expected result, production notes.
- Make available surfaces discoverable early: providers, connectors, integrations, subpaths, action ids.
- Use task-first IA: quickstart, build guides, integrations, then reference.
- Follow Diátaxis separation: tutorials teach first success, how-to guides solve tasks, reference states facts, explanation gives context.
- Keep reference secondary but complete: package roles, protocol terms, boundaries, host duties, signatures, params, returns, errors.
- Prefer copy-paste snippets that use real exported symbols. Never invent imports.
- Name host-owned placeholders clearly: `HostConnectorLayer`, `HostKnowledgeLayer`, `hostOAuthAccessToken`.
- Distinguish package API from host policy every time auth, storage, DB, UI, credentials, or deployment appears.
- Explain canary instability and lockstep package versions without burying first success.
- Show how packages compose; avoid isolated API lists unless cataloging available capabilities.
- When adding a feature doc, also update discovery pages if it changes what users can use.
- Keep docs AI-readable: concise Markdown, stable headings, explicit links, and `llms.txt`/full Markdown exports when available.
- Treat examples/templates as docs. Link runnable examples from relevant guides and keep them working.
- Prefer sentence-case headings, active voice, imperative task titles, and short sections.

## Models we follow

- **Diátaxis / Divio**: separate tutorials, how-to guides, reference, and explanation. Do not make one page serve all four jobs.
- **AI SDK / Stripe**: surface capability catalogs early, especially providers, integrations, examples, and templates.
- **tRPC / Prisma**: support both new-project and existing-project adoption paths.
- **TanStack Query / Zod**: explain the mental model, then show the smallest useful code.
- **Google / Microsoft style**: get to the point, use active voice, sentence case, concise headings, and imperative steps.
- **llms.txt**: make docs usable by agents through clean Markdown, stable links, and curated full-context exports.

## Content types

| Type        | Reader need                       | Yolk location                | Rule                                                         |
| ----------- | --------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Tutorial    | Learn by completing first success | `quickstart`                 | Must be runnable end-to-end.                                 |
| How-to      | Solve a concrete task             | `guides/*`, `integrations/*` | Must include prerequisites, steps, verification, next links. |
| Reference   | Look up exact facts               | `reference/*`, package pages | Must be complete, terse, and synchronized with exports.      |
| Explanation | Understand tradeoffs/mental model | reference/concept sections   | Must not block first success.                                |

## Writing style

- Use sentence case: `Add MCP tools`, not `Add MCP Tools`.
- Start task headings with an imperative verb: `Create`, `Add`, `Run`, `Deploy`.
- Front-load the user value in the first sentence.
- Use second person sparingly but directly: `Use this when...`.
- Prefer tables for catalogs and choices.
- Prefer numbered steps for procedures.
- Introduce every code block with what it does.
- Label non-runnable snippets as fragments.
- Keep placeholders descriptive and obviously host-owned.

## Anti-patterns

- Do not lead with package architecture before first runnable code.
- Do not document app-owned examples as SDK-owned APIs.
- Do not hide available integrations behind package names.
- Do not show client-provided tools as trusted server policy.
- Do not include secrets, real tokens, private ids, or raw provider error bodies.
- Do not repeat long procedure blocks; link the canonical guide.
- Do not add a public docs page that is only useful to repo agents; put that in `AGENTS.md`.
- Do not promise stable APIs during canary.

## Page shape

- What you will build/use.
- Install.
- Minimal working code with filename.
- Run or wire it with exact command.
- Expected output or UI result.
- Production notes / host responsibilities.
- Related APIs.

## Quality checks for content changes

- Every visible content directory is in `content/docs/**/meta.json`, or intentionally hidden.
- Every how-to has a user goal, prerequisites, steps, verification, and next link.
- Every code block is either runnable or clearly labeled as a fragment.
- Every runnable code block has a filename, install command, run command, and expected result.
- Every new package export/subpath updates reference and discovery/catalog pages.
- Every new provider/connector/integration updates the integrations catalog.
- Every known recurring failure mode belongs in troubleshooting, not issue memory.
- Every breaking/canary behavior belongs in migration/versioning docs.
- `llms.txt` and `llms-full.txt` should keep building after content/config changes.

## Rules

- Content lives in `content/docs`; nav order lives in `content/docs/**/meta.json`.
- Fumadocs config lives in `source.config.ts`; generated `.source` is ignored.
- Use relative imports in app code so root `tsc` does not resolve docs aliases to `examples/next`.
- Do not add auth, DB, telemetry, or product policy here unless the docs site itself needs it.
- Run `pnpm docs:check` after docs changes.
- Run `pnpm build:docs` after routing/config changes.
