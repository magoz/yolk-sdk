# Effect 4.0.0 compatibility patches

These are pnpm-managed dependency patches, not generated build output or peer-range
suppressions. `pnpm-workspace.yaml#patchedDependencies` and `pnpm-lock.yaml` own their
application and integrity.

## Scope

| Package       | Pinned version       | Patch                                     | Owner                                                                                                        |
| ------------- | -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `drizzle-orm` | `1.0.0-rc.5-ab785fc` | Type declarations: `SqlError` import path | `examples/next` (applies to every install of this version, including the root and Alchemy's transitive copy) |

`drizzle-orm@1.0.0-rc.5-ab785fc` declares `effect >=4.0.0-beta.105 || >=4.0.0`, and its runtime
JavaScript imports no removed Effect paths. Its type declarations (46 `.d.ts`/`.d.cts` files)
still import `SqlError` from `effect/unstable/sql/SqlError`, which Effect 4.0.0 removed. Root
`skipLibCheck` hides the missing module, so `SqlError` silently becomes `any` and transaction
error channels in the Next example (`db.transaction`, `catchTag('SqlError')`) stop being
type-checked. The patch rewrites only that specifier to `effect/sql/SqlError`, the same module in
Effect 4.0.0. No newer drizzle build (checked through `1.0.0-rc.5-5935859`) fixes it yet.

## Maintenance

Use `pnpm patch` / `pnpm patch-commit`, not direct edits to installed dependencies. After changing
a patch, force pnpm to reevaluate the patch configuration:

```sh
pnpm install --ignore-scripts --no-frozen-lockfile --config.optimistic-repeat-install=false
pnpm peers check
pnpm --filter @yolk-example/next check
```

The explicit install option avoids pnpm 11's optimistic repeat-install shortcut reporting
“Already up to date” without refreshing a changed patch. Verify the lockfile's `patch_hash` and
the installed declarations, not just the install exit code.

When drizzle ships declarations that import `effect/sql/SqlError`, upgrade it, remove the patch and
its registration, refresh the lockfile, and rerun the same checks. Do not alias the removed path or
suppress the type error instead.
