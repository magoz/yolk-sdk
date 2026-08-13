---
name: learn
description: Capture durable Yolk codebase knowledge from the current session. Use after implementation, debugging, or architectural decisions reveal non-obvious rules that belong in AGENTS.md, patterns, or project skills.
---

# Learn

Capture durable knowledge from the current session and place it in Yolk's existing knowledge
hierarchy.

This is a focused maintenance skill, not a broad documentation audit:

- Use `learn` to preserve verified discoveries from current work.
- Use `tidy` to audit stale, duplicated, or misplaced knowledge across the repo.
- Use `conform` to change implementation code.
- Use `package-docs` for package READMEs and package-local documentation.
- Use `docs-sync` to align the public `apps/docs` site with package code and examples.

## Core principles

- **Evidence before instruction.** Confirm session conclusions against code, tests, config, or owner
  docs before recording them.
- **Durable over incidental.** Record constraints and decisions likely to matter in future sessions,
  not one-off implementation details.
- **Progressive disclosure.** Put knowledge in the narrowest owner document where a future agent will
  find it.
- **Capabilities over file trees.** Explain what exists, where its contract lives, and important
  constraints; avoid exhaustive structure maps.
- **Code is reality.** Patterns explain intent, but current implementation and verified behavior
  decide whether a statement is true.
- **Small context budget.** Every root instruction must prevent a likely cross-repo mistake. Local
  knowledge belongs in local docs.

## Arguments

| Arg       | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `--check` | Propose learnings and destinations without editing.         |
| `<path>`  | Limit capture and verification to one owner area.           |
| `--all`   | Consider all areas touched in the current session. Default. |

If there is no durable, verified learning, do not edit files. Report that there is nothing to
capture.

## Yolk knowledge model

| Knowledge                                              | Owner                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| Repo-wide strategy, hard boundaries, required checks   | `AGENTS.md`                                                   |
| Public package-local design and contributor rules      | `packages/<name>/AGENTS.md`                                   |
| Cross-package architecture/distribution                | `patterns/PACKAGE_ARCHITECTURE.md`, `PACKAGE_DISTRIBUTION.md` |
| Shared Effect, TypeScript, testing, MCP, telemetry     | Root `patterns/*`                                             |
| Next example routing, actions, data flow, UX, e2e      | `examples/next/patterns/*`                                    |
| Next app-owned implementation constraints              | Nearest `examples/next/**/AGENTS.md`                          |
| Docs app, Cloudflare app, scripts, lint implementation | Nearest owner `AGENTS.md`                                     |
| Reusable agent workflow instructions                   | `.agents/skills/<name>/SKILL.md`                              |
| Package README and package-local docs                  | `package-docs` skill                                          |
| Public guides, integrations, and API reference         | `docs-sync` skill                                             |

`.repos/*` contains gitignored, read-only references. Never document reference-repo behavior as a
Yolk contract unless Yolk code or owner docs adopt it explicitly.

## Workflow

### 1. Extract candidate learnings

Review the current conversation, decisions, tool results, and changes made in this session. Candidate
learnings include:

- a new or corrected architectural boundary
- a non-obvious invariant required for correctness or portability
- a reusable implementation/testing pattern established by the work
- a rejected approach and the durable reason it is unsafe
- a capability future agents should reuse instead of rebuilding
- a command, validation gate, or operational gotcha that is not discoverable from config
- a stale owner instruction directly contradicted by verified code encountered in the session

Do not infer session learnings from unrelated pre-existing working-tree changes. Distinguish files
changed before this session from files changed by the current work.

### 2. Apply the durability filter

Record a candidate only when it is:

1. **Verified** — supported by code, tests, config, or an explicit settled user decision.
2. **Non-obvious** — not immediately discoverable from names, types, package scripts, or standard
   framework behavior.
3. **Reusable** — likely to affect a future task, review, or architectural choice.
4. **Project-specific** — says something meaningful about Yolk rather than generic engineering.
5. **Stable** — not merely an experiment, temporary workaround, or unmerged intention.

Do not record:

- a summary of files changed
- exact implementation steps already clear from code
- generic framework advice
- speculative plans or unresolved alternatives
- transient debugging commands, temporary paths, secrets, or environment values
- line numbers, exhaustive trees, or generated artifacts
- a rule already stated accurately at the correct owner

### 3. Verify owner and current knowledge

Read only what is needed for the touched area:

1. Root `AGENTS.md`.
2. The nearest owner `AGENTS.md` files.
3. Relevant root or Next pattern docs.
4. Relevant project skill if the learning changes a workflow.
5. The implementation, test, manifest, config, or diff that proves the learning.

Search for equivalent instructions before adding text. If the knowledge already exists, update the
stale owner or leave it unchanged rather than duplicating it.

Do not scan every `AGENTS.md` by default. A repo-wide hierarchy/staleness audit belongs to `tidy`.

### 4. Route to the narrowest durable owner

- Put a rule in root only when it applies across packages/apps or prevents a repo-wide boundary
  violation.
- Put package-specific behavior in `packages/<name>/AGENTS.md`, not `packages/AGENTS.md` or root.
- Put cross-package policy in root patterns, not package-local docs.
- Put Next-only behavior under `examples/next`, never in root patterns.
- Put Cloudflare, docs-app, script, and lint behavior with those owners.
- Put reusable agent workflow instructions in `.agents/skills`.
- Route package README/import/host-responsibility documentation through `package-docs`.
- Route public guides, integration catalogs, and API reference drift through `docs-sync`.

When one learning affects multiple layers, keep the detailed rule at the narrow owner and add only a
short pointer at broader layers when discoverability requires it.

### 5. Patch surgically

- Preserve existing document structure and telegraphic style.
- Add or correct the smallest useful statement.
- Prefer a table row or concise bullet over a new section.
- Link to an existing detailed pattern instead of copying it.
- Avoid broad rewrites and unrelated cleanup.
- Never create an `AGENTS.md` merely because a directory exists. Create one only for genuinely
  complex, non-obvious local constraints with no suitable owner.
- Never edit source code to make documentation true.
- Do not commit unless the user asks.

If a discovered contradiction requires broad moves, deduplication, or hierarchy cleanup, stop after
capturing the local verified fact and recommend a `tidy` pass.

### 6. Validate

After edits:

1. Re-read changed passages in context.
2. Search for direct contradictions or duplicate wording in parent/child owners.
3. Verify every referenced path and command exists.
4. Confirm no `.repos`, generated output, environment file, or unrelated dirty file was added.
5. Run the checks required by root `AGENTS.md` (`pnpm tsc` and `pnpm lint`).
6. If the learning changes package boundaries or public package docs, also run
   `pnpm packages:check` when practical.
7. If it changes docs-app or Cloudflare expectations, run the owning check.

Report exact unrelated blockers instead of weakening or deleting a valid instruction.

## Report

Final response:

- knowledge captured and why it is durable
- owner files changed
- existing duplicate/stale statement corrected, if any
- checks run and results
- follow-up `tidy`, `package-docs`, `docs-sync`, or implementation work, if needed

If nothing qualifies, report: `Nothing durable to capture from this session.`

## Anti-patterns

- Turning the current diff into a changelog.
- Promoting a package- or app-local detail into root context.
- Documenting intent that code and tests do not yet support.
- Copying the same rule into root, child AGENTS, patterns, and skills.
- Treating `.repos/*` reference implementations as Yolk architecture.
- Using `learn` for a broad stale-doc cleanup; use `tidy`.
- Changing code while trying to preserve knowledge; use `conform`.
- Committing without explicit request.
