# Local ESLint Rules

Small project-local ESLint plugin enforcing Effect/type-safety conventions from `patterns/*`.

## Files

| File           | Role                                              |
| -------------- | ------------------------------------------------- |
| `index.js`     | Exports `localRulesPlugin` + `recommended` config |
| `no-*.js`      | Individual AST rules                              |
| `package.json` | ESM marker only; not a pnpm workspace package     |

## Rule Conventions

- Add a local rule only for repeated, high-cost mistakes that docs cannot reliably prevent.
- Keep rules syntax-only unless ESLint type services are explicitly wired.
- Keep messages actionable: name the forbidden pattern and the allowed replacement.
- Root `eslint.config.mjs` imports `recommended`; update both when adding a rule.
- Update `AGENTS.md` and relevant `patterns/*` docs when adding/removing enforced rules.

## Current Limits

- Most rules match identifiers named exactly `Effect`, `Schema`, or `Option`; aliased/direct imports may bypass checks.
- `prefer-option-from-nullable` is a warning; the other local rules are errors.
- There are no dedicated rule tests yet; validate changes with `pnpm lint`.

## Anti-Patterns

- Type-aware rule without configuring type services.
- Broad AST selector that flags unrelated libraries.
- Rule message with no migration path.
