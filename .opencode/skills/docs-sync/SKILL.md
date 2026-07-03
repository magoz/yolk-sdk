---
name: docs-sync
description: Audits and updates Yolk docs after code changes. Use when package exports, runtime semantics, integrations, examples, or docs content may drift.
---

# Docs Sync

Use this skill to keep `apps/docs` aligned with actual Yolk package code and examples.

This is a deep docs-drift workflow. It verifies code reality first, maps changed surfaces to docs, updates docs surgically, and validates the docs site plus relevant repo checks.

## In This Skill

| File                                                 | Purpose                     |
| ---------------------------------------------------- | --------------------------- |
| [references/checklist.md](./references/checklist.md) | Full audit/update checklist |
| [references/doc-map.md](./references/doc-map.md)     | Changed-code → docs mapping |

## Modes

| User intent                            | Behavior                                          |
| -------------------------------------- | ------------------------------------------------- |
| “audit docs”, “what’s stale?”          | Read-only audit; return gaps and file-level plan. |
| “sync docs”, “update docs”, “fix docs” | Audit, edit docs, validate.                       |
| ambiguous                              | Ask whether to audit only or edit.                |

## Quick Start

1. Read docs rules first:
   - `apps/docs/AGENTS.md`
   - root `AGENTS.md`
   - package-local `packages/*/AGENTS.md` for changed packages

2. Inspect working tree:
   - `git status --short`
   - `git diff --stat`
   - `git diff --name-only`
   - recent commits only if needed for context

3. Map changed code to docs with [doc-map.md](./references/doc-map.md).

4. Verify source of truth before editing:
   - package `package.json` exports and `publishConfig.exports`
   - subpath entrypoints under `packages/*/src`
   - tests for runtime semantics
   - package README and package-local `AGENTS.md`
   - examples if docs reference example behavior

5. Update docs surfaces:
   - guides and integration pages
   - catalogs/discovery pages
   - API reference pages
   - troubleshooting
   - migration/versioning
   - `apps/docs/AGENTS.md` only for durable doc philosophy/process changes

6. Validate.

## Required Validation

Always run after docs edits:

```bash
pnpm docs:check
pnpm build:docs
pnpm tsc
pnpm lint
```

Also run when relevant:

```bash
pnpm packages:check      # if packages/* changed or package APIs/subpaths changed
pnpm docs:check          # always for apps/docs edits
pnpm cloudflare:check    # if cloudflare/* docs/runtime touched
pnpm test:run            # broad behavioral docs or test-backed examples
```

## Core Rules

- Never invent exports, types, action ids, config keys, or behavior.
- Prefer package source/tests over stale docs.
- Keep docs usage-first and task-first.
- Keep package internals out of onboarding.
- Every runnable snippet needs install command, filename, run command, and expected result.
- Clearly label fragments.
- Every new provider/connector/integration updates discovery/catalog docs.
- Every new public subpath/export updates API/reference docs.
- Every breaking/canary behavior updates migration/versioning docs.
- Every repeated user/runtime failure updates troubleshooting.
- Every docs IA/content principle learned during work updates `apps/docs/AGENTS.md`.
- Preserve host-vs-SDK boundaries: auth, storage, DB, credentials, UI, deployment, and policy stay host-owned.

## Reading Order

| Task                           | Files                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Quick docs drift audit         | SKILL.md → checklist.md                                                      |
| Package API change             | SKILL.md → doc-map.md → checklist.md → package-docs skill if README affected |
| Provider/connector change      | SKILL.md → doc-map.md → relevant package source/tests                        |
| Workflow/runtime change        | SKILL.md → doc-map.md → tests/source → docs pages                            |
| Docs philosophy/process update | SKILL.md → apps/docs/AGENTS.md                                               |

## Output Format

For read-only audit:

```txt
Docs drift audit
- Changed surfaces:
- Stale/missing docs:
- Recommended edits:
- Validation needed:
```

For edits:

```txt
Docs synced
- Updated:
- Verified against:
- Checks:
- Follow-ups:
```

Keep final user response concise.
