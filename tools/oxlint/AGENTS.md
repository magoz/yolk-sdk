# Oxlint lint engine

Oxlint is the repository lint engine. Oxfmt is the repository formatter. ESLint is
not a lint engine, test engine, or config owner in this tree.

## Split

| Tool                                     | Owns                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oxlint 1.78.0 + `@oxlint/plugins` 1.78.0 | Native equivalents of the former ESLint 94/88 ruleset, 6 local JS rules, React compat plugins, all 23 anti-slop rules at error, plus native `oxc/no-accumulating-spread` |
| Oxfmt 0.63.0                             | Formatting (`format:check` / `format:fix`)                                                                                                                               |
| `eslint-plugin-react-hooks` 7.0.1        | Original compiler rules loaded as `hooks-compat/*` (reserved `react-hooks` name)                                                                                         |
| `eslint-plugin-react` 7.37.5             | Original `no-deprecated` loaded as `react-compat/no-deprecated`                                                                                                          |

This folder owns the vendor pin, root Oxlint config, DB-free harness, and focused
`test:anti-slop` runner. Do not rewrite anti-slop visitors. Do not disable or reoption
anti-slop rules here to hide application debt. A `SAFETY:` comment does not authorize
assertions banned by `typescript/consistent-type-assertions`. Categories stay off.
Do not enable type-aware Oxlint, unicorn, or a warning budget.

## Files

| File                    | Role                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `../../.oxlintrc.json`  | Root Oxlint config: native rules, local plugin, React compat, anti-slop, accumulating-spread |
| `../../.oxfmtrc.json`   | Root Oxfmt config matching current style; vendor/generated ignored                           |
| `plugins/`              | Production `hooks-compat` / `react-compat` loaders (direct package imports)                  |
| `anti-slop/`            | Vendored upstream `src/` at the pin in `anti-slop/UPSTREAM.md`                               |
| `anti-slop/UPSTREAM.md` | Provenance, licenses, local deviations, update plan                                          |
| `anti-slop.test.ts`     | DB-free anti-slop integration harness                                                        |
| `root-config.test.ts`   | Root-config reachability, React-compat proof, documented negative gaps                       |
| `vitest.config.ts`      | Minimal Node Vitest config; no dotenv/DB                                                     |
| `package.json`          | ESM marker so native Node can load vendored RuleTester files                                 |

## Commands

- `pnpm lint` / `pnpm lint:fix` — Oxlint using `.oxlintrc.json`
- `pnpm format:check` / `pnpm format:fix` — Oxfmt using `.oxfmtrc.json`
- `pnpm test:anti-slop` — focused harness + native upstream suites + root-config tests

Root Vitest excludes `tools/oxlint/**`. `pnpm test:anti-slop` is the sole safe
entry for this harness.

Native diagnostic spans use UTF-8 byte offsets, not JavaScript/TypeScript UTF-16
indices. Convert both span endpoints against the same source snapshot before AST
edits; require exact matches rather than guessing at an encoding mismatch.

## Ignores

Oxlint ignore patterns cover generated artifacts, gitignored reference clones, agent
skill assets, and this vendor tree. Never ignore `packages/*`, `apps/*`, `examples/*`,
`cloudflare/*`, `scripts/*`, or test files to dodge findings.

Vendor source stays in the root TypeScript check. Exclude it from Oxfmt, Oxlint,
and Vitest discovery only.

## Anti-Patterns

- Parser shims or visitor rewrites of vendored / upstream React rules
- Hidden ESLint `Linter` / `RuleTester` as a second engine
- Resolving plugins through `eslint-config-next` or hardcoded `node_modules` paths
- Effect/compiler upgrades as part of tooling changes
- Blind vendor overwrites; follow `anti-slop/UPSTREAM.md`
- Formatting vendored `anti-slop/**` with Oxfmt
- Rule-off overrides or ignore patterns that hide application debt
- Copying 10x/Speldosa plugin lists that omit `oxc` (drops `oxc/no-accumulating-spread`)
