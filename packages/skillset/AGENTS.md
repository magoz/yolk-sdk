# Skillset

Domain-free parsing and catalog primitives for portable skills and commands.

## Boundaries

- No filesystem, Next.js, Cloudflare, DB, auth, provider SDKs, or tool execution.
- Core package owns schemas, markdown parsing, command rendering, manifest shape, and merge helpers.
- Host apps own source adapters, policy, storage, and runtime tool wiring.
- Keep v1 scoped to skills and commands; do not broaden into tools, providers, models, agents, storage, or permissions.

## Public model

| Export area | Purpose                                              |
| ----------- | ---------------------------------------------------- |
| `skill`     | Skill metadata, parsing, available-skills formatting |
| `command`   | Command metadata, parsing, argument rendering        |
| `manifest`  | Portable serialized skillset shape                   |
| `merge`     | Deterministic source priority merging                |

## Tests

- Test behavior semantically: validation, parsing, rendering, merge priority.
- Do not import app or tool packages.
