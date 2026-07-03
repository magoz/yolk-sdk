# Scripts

Node CLI/dev boundaries. Scripts may use runtime APIs banned from app/service code when the behavior stays script-local.

## Files

| File                          | Role                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `clone-repos.ts`              | Delete/re-clone gitignored reference repos under `.repos/*`                                  |
| `build-skillset.ts`           | Compile configured project skillset sources/commands into Cloudflare generated skillset      |
| `codex-ws-smoke.ts`           | Manual Codex WebSocket smoke check                                                           |
| `check-package-boundaries.ts` | Validate example/package import boundaries, retired packages, and sandbox provider isolation |
| `check-package-exports.ts`    | Validate package export shape and tree-shaking smoke rules                                   |
| `check-package-publint.ts`    | Run `publint` strict checks across public packages                                           |
| `smoke-package-imports.ts`    | Pack public packages, install/extract into temp fixture, import every public subpath         |

## Rules

- Run scripts through `pnpm` package scripts; do not add ad hoc npm/yarn commands.
- Node-only imports are allowed here: `node:fs`, `node:fs/promises`, `node:path`, `node:process`, `node:crypto`, `node:tls`, `node:child_process`, `node:os`, `node:url`.
- `process.env`, `console.*`, raw JSON, and raw network APIs are allowed only for CLI/smoke boundaries.
- Prefer Effect for orchestration, errors, config, and cleanup when scripts grow beyond simple file transforms.
- App DB setup scripts live under `examples/next/scripts`.
- Generated writes must be deterministic and documented in the owning app docs.
- Release smoke scripts may create temp dirs and pack/install package tarballs only under OS temp paths.
- Package release scripts use explicit package/subpath allowlists; update them with every public package shape change.

## Anti-Patterns

- Import script modules from app runtime, packages, or Cloudflare Worker code.
- Hide product/runtime behavior in scripts instead of source-controlled app/package code.
- Write/delete outside generated, gitignored, or explicitly documented dev-only paths.
