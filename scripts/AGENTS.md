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

`pnpm skillset:build` is the canonical generated fallback writer for `cloudflare/agent/src/generated/skillset.ts` and includes a formatter post-stage. Direct `tsx scripts/build-skillset.ts` does not format.

## Rules

- Run scripts through `pnpm` package scripts; do not add ad hoc npm/yarn commands.
- Node-only imports are allowed here: `node:fs`, `node:fs/promises`, `node:path`, `node:process`, `node:crypto`, `node:tls`, `node:child_process`, `node:os`, `node:url`.
- `process.env`, `console.*`, raw JSON, and raw network APIs are allowed only for CLI/smoke boundaries.
- Prefer Effect for orchestration, errors, config, and cleanup when scripts grow beyond simple file transforms.
- App DB setup scripts live under `examples/next/scripts`.
- Generated writes must be deterministic and documented in the owning app docs.
- Release smoke scripts may create temp dirs and pack/install package tarballs only under OS temp paths.
- Package export/smoke scripts use explicit package/subpath allowlists; update them with every public package shape change.
- Boundary checks have dedicated DB-free fixture tests in `test/*.test.ts`; run `pnpm test:tooling` or `pnpm exec vitest run --config tools/tooling/vitest.config.ts`. Fixtures own their temporary directories and remove them on test completion.
- The checker scans `.ts/.tsx/.mts/.cts` (including declarations). The global packages->apps/examples/cloudflare ban is independent of per-area exclusions. An index export owns its directory subtree (a root index owns the package); more specific export targets take precedence. Aliases use the nearest tsconfig, including extends/baseUrl-only settings and explicit moduleResolution. Config parsing reads options without expanding source globs; typechecks own input-file validation.
- The caller-selected workspace is canonicalized once (supporting path aliases such as macOS `/tmp`); descendant symlinks and outside-workspace resolution reads are rejected. Source manifests and configs are validated rather than silently coerced. Computed or non-literal dynamic imports (`import(expr)`) cannot be resolved statically and are intentionally ignored, never guessed.

## Anti-Patterns

- Import script modules from app runtime, packages, or Cloudflare Worker code.
- Hide product/runtime behavior in scripts instead of source-controlled app/package code.
- Write/delete outside generated, gitignored, or explicitly documented dev-only paths.
