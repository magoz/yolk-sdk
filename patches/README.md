# Effect rc.115 compatibility patches

These are pnpm-managed dependency patches, not generated build output or peer-range
suppressions. `pnpm-workspace.yaml#patchedDependencies` and `pnpm-lock.yaml` own their
application and integrity. The Cloudflare app owns this compatibility requirement.

Alchemy beta.77 and its current dependency cohort declare support for Effect rc.112+
but still call APIs removed by rc.115. An unpatched Node import fails on
`Config.string`; the CLI also fails on `GlobalFlag.setting` and `Flag.boolean`.
Typechecks alone do not exercise these runtime calls.

## Scope

| Package                                                                           | Pinned version  | Patch                            |
| --------------------------------------------------------------------------------- | --------------- | -------------------------------- |
| `alchemy`                                                                         | `2.0.0-beta.77` | Config and CLI constructor names |
| `@alchemy.run/cloudflare-runtime`                                                 | `2.0.0-beta.77` | Config constructor names         |
| `@distilled.cloud/{aws,axiom,cloudflare,core,fly-io,hetzner,planetscale,railway}` | `1.0.0-rc.9`    | Config string constructor names  |

The changes use public rc.115 APIs with the same arguments:

- `Config.string/redacted/boolean/number/int/duration` →
  `Config.String/Redacted/Boolean/Number/Int/Duration` (where used).
- `Config.mapOrFail` → `Config.mapEffect`.
- `GlobalFlag.setting` → `GlobalFlag.Setting`.
- `Flag.boolean/string/integer/file/choice` → `Flag.Boolean/String/Int/File/Literals`.
- `Argument.file/string` → `Argument.File/String`.

Both shipped source and compiled runtime files are patched: Node imports and the
published Node CLI use compiled exports, while Bun/Worker conditions select source.
Alchemy's generated code templates are included. Existing error policies, defaults,
provider logic, and peer declarations are unchanged. The broader provider imports
are loaded by the CLI; this is not a claim that those providers were exercised.

## Maintenance

Use `pnpm patch` / `pnpm patch-commit`, not direct edits to installed dependencies.
After changing a patch, force pnpm to reevaluate the patch configuration:

```sh
pnpm install --ignore-scripts --no-frozen-lockfile --config.optimistic-repeat-install=false
pnpm peers check
pnpm cloudflare:check
```

The explicit install option avoids pnpm 11's optimistic repeat-install shortcut
reporting “Already up to date” without refreshing a changed patch. Verify the
lockfile's `patch_hash` and installed files, not just the install exit code.

`cloudflare:check` includes a non-deploying Node import/CLI smoke and verifies a
single Effect instance. Run it without cloud credentials; no DB or live-provider
checks are needed. Worker execution and deployment remain separate validation.

When upstream packages adopt rc.115, remove each obsolete patch and its registration,
refresh the lockfile, and rerun the same checks plus the DB-free regression suite.
Do not restore removed Effect APIs or suppress peer warnings to make a check pass.
