# TypeScript 7 type check

Status: accepted.

Yolk type-checked with TypeScript 5.9 (`tsc --noEmit`) and had the Effect language service only as
a tsserver plugin (`@effect/language-service`), so Effect diagnostics never gated a change. The
TypeScript 7 compiler is native and much faster, and `@effect/tsgo` ships Effect-patched builds of
it (Go `tsc` and the Rust port [tsrs](https://github.com/oxc-project/tsrs)) that run without
patching `node_modules` and report Effect diagnostics in the same pass. TypeScript 7 has no
classic JS compiler API, which Next.js 16.1 (to transpile `next.config.ts`), tsdown, knip and the
package-boundary script still need.

## Decision

- Type checks run `effect-tsgo tsrs -p <tsconfig> --noEmit`, the bundled TypeScript 7 build, in the
  root `tsc` script and every workspace `check` script.
- The installed `typescript` package stays 5.9 for the JS-API consumers above. Moving it to 7
  waits for those consumers (at least a Next.js upgrade that type-checks through the `tsc` CLI).
- Effect diagnostics gate the check: warnings and errors fail it, suggestions are hidden
  (`includeSuggestionsInTsc: false`). The root `tsconfig.json` holds the plugin options, including
  `allowedUnstableApis` for the `@stability unstable` Effect modules Yolk depends on deliberately.
- `@effect/language-service` is removed; editors use the Effect language server from
  `@effect/tsgo`.

## Consequences

- One pass replaces `tsc`, and Effect findings (global `Error` failures, chained `Effect.provide`,
  object literals posing as Schema class instances) are caught when introduced.
- Two TypeScript versions coexist: the gate is TypeScript 7 (tsrs tracks the newest 7.x the
  `@effect/tsgo` release bundles), while declaration emit through tsdown uses 5.9. Code must
  satisfy both; differences so far were TypeScript 7's stricter defaults (`types`, checked
  side-effect imports).
- tsrs is young. If it diverges from TypeScript, switch the scripts to `effect-tsgo tsc` (same
  flags, the Go build). The packaged tsrs build does not support Linux musl.
