# Local Oxlint Rules

Small project-local Oxlint JS plugin enforcing Effect/type-safety conventions from `patterns/*`.

## Files

| File                 | Role                                          |
| -------------------- | --------------------------------------------- |
| `index.js`           | Default-export plugin `local`                 |
| `no-*.js`            | Individual AST rules                          |
| `test.oxlintrc.json` | Isolated local-rule corpus config             |
| `test/rules.test.js` | Pinned Oxlint CLI harness (temp fixtures)     |
| `package.json`       | ESM marker only; not a pnpm workspace package |

## Rule Conventions

- Add a local rule only for repeated, high-cost mistakes that docs cannot reliably prevent.
- Keep rules syntax-only unless type services are explicitly wired.
- Keep messages actionable: name the forbidden pattern and the allowed replacement.
- Root `.oxlintrc.json` lists each `local/*` rule; update both when adding a rule.
- Update `AGENTS.md` and relevant `patterns/*` docs when adding/removing enforced rules.

## Enforced Rules

| Rule                          | Contract                                               |
| ----------------------------- | ------------------------------------------------------ |
| `no-disable-validation`       | Ban `{ disableValidation: true }`                      |
| `no-catch-all-cause`          | Ban `Effect.catchCause`                                |
| `no-schema-from-self`         | Ban removed `*FromSelf` schemas                        |
| `no-schema-decode-sync`       | Ban synchronous Schema decode/encode                   |
| `prefer-option-from-nullable` | Prefer Effect nullish helpers                          |
| `no-node-deps-in-agent-tools` | Ban Node-only deps and raw `fetch()` in Next app tools |

TypeScript's `no-explicit-any` and `consistent-type-assertions` rules enforce the related bans on
`any` and `as Type`; see `patterns/TYPESCRIPT_CONVENTIONS.md`.

## Current Limits

- Most rules match identifiers named exactly `Effect`, `Schema`, or `Option`; aliased/direct imports may bypass checks. Only `prefer-option-from-nullable` resolves real Effect imports through Oxlint `sourceCode.getScope`: `{ Option }` from `effect` (incl. aliases), `E.Option` from `import * as E from 'effect'`, namespace/direct helpers from `effect/Option`. Root `E.some` / `import { some } from 'effect'` are invalid code and stay silent, as do shadowed locals. Re-exported helper wrappers are still invisible. TS-generic `none<T>()` is covered by the native Oxlint CLI corpus (no ESLint parser).
- `prefer-option-from-nullable` is a warning; the other local rules are errors. There is no autofix.
- `no-node-deps-in-agent-tools` applies only to non-test files under `examples/next/lib/agents/tools/*`; it bans Node imports, `@effect/platform-node`, `@yolk-sdk/mcp/client/node`, and raw `fetch()`.
- Dedicated rule tests live in `test/rules.test.js`; run them with `vitest run --config tools/tooling/vitest.config.ts` (or `pnpm test:tooling`). Root vitest excludes this tree so the tooling gate is the sole runner.

## Anti-Patterns

- Type-aware rule without configuring type services.
- Broad AST selector that flags unrelated libraries.
- Rule message with no migration path.
- Weakening `prefer-option-from-nullable` to identifier-only matching, or dropping `getScope` / `ImportBinding`.
- ESLint `RuleTester` as the local-rule runner.
