# TypeScript 7 type check

Status: accepted.

Yolk type-checked with TypeScript 5.9 (`tsc --noEmit`) and had the Effect language service only as
a tsserver plugin (`@effect/language-service`), so Effect diagnostics never gated a change. The
TypeScript 7 compiler is native and much faster, and `@effect/tsgo` ships Effect-patched builds of
it (Go `tsc` and the Rust port [tsrs](https://github.com/oxc-project/tsrs)) that run without
patching `node_modules` and report Effect diagnostics in the same pass. TypeScript 7 has no
classic JS compiler API: Next.js 16.1 transpiled `next.config.ts` through it, knip 5 and the
package-boundary script parsed with it, and tsdown 0.22 emitted declarations with it.

## Decision

- Type checks run `effect-tsgo tsrs -p <tsconfig> --noEmit`, the bundled TypeScript 7 build, in the
  root `tsc` script and every workspace `check` script.
- The installed `typescript` package is 7. The JS-API consumers move to versions that do without
  the classic API: Next.js 16.4 (type-checks through the `tsc` CLI), knip 6 (oxc parser) and
  tsdown 0.23 (declarations through TypeScript 7's experimental API). The package-boundary script
  imports the classic API from `@typescript/typescript6`, Microsoft's compatibility package.
- Effect diagnostics gate the root `pnpm tsc`: warnings and errors fail it, suggestions are hidden
  (`includeSuggestionsInTsc: false`). Only the root `tsconfig.json` holds the plugin and its options
  (including `allowedUnstableApis` for the `@stability unstable` Effect modules Yolk depends on
  deliberately); it covers every workspace except `apps/docs`, which has no Effect code. Workspace
  `check` scripts stay compile-only rather than repeat the plugin options in each config.
- `@effect/language-service` is removed; editors use the Effect language server from
  `@effect/tsgo`.

## Consequences

- One pass replaces `tsc`, and Effect findings (global `Error` failures, chained `Effect.provide`,
  object literals posing as Schema class instances) are caught when introduced.
- The gate is tsrs at the newest 7.x the `@effect/tsgo` release bundles, which can be ahead of
  the installed `typescript` that tsdown and Next.js use. TypeScript 7's stricter defaults needed
  `types: ["node"]` in `packages/tsconfig.base.json`.
- tsdown warns that TypeScript 7's API is experimental. `pnpm packages:smoke` and
  `pnpm packages:publint` check the emitted packages.
- tsrs is young. If it diverges from TypeScript, switch the scripts to `effect-tsgo tsc` (same
  flags, the Go build). The packaged tsrs build does not support Linux musl.
