# Scripts

Node CLI/dev boundaries. Scripts may use runtime APIs banned from app/service code when the behavior stays script-local.

## Files

| File | Role |
| --- | --- |
| `clone-repos.ts` | Delete/re-clone gitignored reference repos under `.repos/*` |
| `build-skillset.ts` | Compile local `.opencode/skills/*` into Cloudflare generated skillset |
| `codex-ws-smoke.ts` | Manual Codex WebSocket smoke check |
| `check-package-boundaries.ts` | Validate app/package import boundary rules |
| `check-package-exports.ts` | Validate package export shape and tree-shaking smoke rules |

## Rules

- Run scripts through `pnpm` package scripts; do not add ad hoc npm/yarn commands.
- Node-only imports are allowed here: `node:fs`, `node:path`, `node:process`, `node:crypto`, `node:tls`, `node:child_process`.
- `process.env`, `console.*`, raw JSON, and raw network APIs are allowed only for CLI/smoke boundaries.
- Prefer Effect for orchestration, errors, config, and cleanup when scripts grow beyond simple file transforms.
- Import centralized dotenv (`@/lib/dotenv`) for scripts that need app env loading.
- Generated writes must be deterministic and documented in the owning app docs.

## Anti-Patterns

- Import script modules from app runtime, packages, or Cloudflare Worker code.
- Hide product/runtime behavior in scripts instead of source-controlled app/package code.
- Write/delete outside generated, gitignored, or explicitly documented dev-only paths.
