# Apps

Private product-facing apps. Docs site lives here because it is a public SDK surface, not a runnable integration example.

## Rules

- Apps may consume `@yolk-sdk/*`; packages never import from `apps/*`.
- Keep app-owned UI, routing, deployment, and docs presentation outside `packages/*`.
- Keep docs aligned with package manifests, package READMEs, and package-local `AGENTS.md` files.
- Do not publish app workspaces.
