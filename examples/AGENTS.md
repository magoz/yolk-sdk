# Examples

Runnable SDK examples and integration apps.

## Role

- Demonstrate `@yolk-sdk/*` usage in real host environments.
- Dogfood package APIs without making packages depend on examples.
- Keep examples private workspaces; never publish them.

## Rules

- Packages must not import from `examples/*`.
- Example-only auth, DB, UI, and deployment code stays outside `packages/*`.
- Add new examples under `examples/<framework>` with a private package manifest.
- Root release scripts publish `packages/*` only.
