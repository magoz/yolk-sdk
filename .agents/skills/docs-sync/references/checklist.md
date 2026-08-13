# Docs sync checklist

Use this checklist for thorough drift detection and update work.

## 1. Scope the change

- Inspect changed files and affected packages/apps.
- Classify each change:
  - public export/subpath
  - runtime behavior
  - provider behavior
  - connector/action/schema/credential slot
  - MCP behavior
  - knowledge behavior
  - sandbox behavior
  - workflow behavior
  - example/template behavior
  - docs-only change

## 2. Verify source reality

For every affected package:

- Read `packages/<pkg>/package.json`.
- Read `packages/<pkg>/src/index.ts` and changed subpath entrypoints.
- Read changed implementation files.
- Read tests covering changed behavior.
- Read `packages/<pkg>/README.md` and `packages/<pkg>/AGENTS.md`.
- Search for exported symbols and action ids in source/tests.

Do not document anything that is not exported through package `exports` or `publishConfig.exports`.

## 3. Docs surfaces to check

Always check these in `apps/docs/content/docs`:

- `index.mdx` for discovery/onboarding links
- `quickstart.mdx` if first-success flow changed
- `guides/*` for task guides
- `integrations/*` for providers/connectors/MCP/knowledge/sandbox/workflow
- package pages: `agent`, `mcp`, `knowledge`, `connectors`, `sandbox`, `vercel-workflows`
- `api-reference/*` for public exports
- `reference/packages.mdx` for subpaths
- `troubleshooting.mdx` for known failure modes
- `migration.mdx` for breaking/canary changes
- `meta.json` files for navigation
- `apps/docs/AGENTS.md` for durable docs process/philosophy changes

## 4. Content quality checks

For each updated page:

- Is the page serving one Diátaxis role?
- Is the first paragraph user-centered?
- Does the page lead with the shortest useful path?
- Are code blocks runnable or labeled fragment?
- Do snippets import only real public exports?
- Do snippets avoid `any`, `!`, and type assertions where possible?
- Are host-owned placeholders named clearly?
- Are secrets/tokens/private ids absent?
- Are host responsibilities explicit?
- Are next links present?
- Is navigation updated?

## 5. Catalog checks

Provider changes require:

- `integrations/index.mdx`
- `integrations/model-providers.mdx`
- `integrations/provider-setup.mdx`
- `agent/providers-oauth.mdx`
- `api-reference/agent.mdx`
- troubleshooting/migration if behavior changed

Connector changes require:

- `integrations/index.mdx`
- `integrations/connectors.mdx`
- `integrations/connector-tool.mdx` if adapter changed
- `connectors/index.mdx`
- `api-reference/integrations.mdx`
- troubleshooting/migration if behavior changed

Workflow/runtime changes require:

- `guides/persist-session.mdx`
- `guides/durable-session-store.mdx`
- `vercel-workflows/*`
- `integrations/vercel-workflow.mdx`
- `api-reference/agent.mdx` or `api-reference/workflows.mdx`
- troubleshooting/migration

## 6. Validation matrix

| Change                  | Commands                                                      |
| ----------------------- | ------------------------------------------------------------- |
| Docs only               | `pnpm docs:check`, `pnpm build:docs`, `pnpm tsc`, `pnpm lint` |
| Package API docs        | add `pnpm packages:check`                                     |
| Package behavior docs   | add package tests or `pnpm test:run` when broad               |
| Docs app code/config    | include `pnpm build:docs`                                     |
| Cloudflare docs/runtime | add `pnpm cloudflare:check`                                   |

## 7. Final audit before response

- Confirm no generated `.next`, `.source`, `.turbo`, `dist`, coverage, or env files are staged/mentioned as intended edits.
- Re-run failed checks after fixes.
- Report only important changed docs and checks.
