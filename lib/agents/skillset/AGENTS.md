# App Skillset Sources

Node/app adapters for loading project skills and commands into the app agent runtime.

## Boundaries

- `@yolk-sdk/skillset` owns pure parsing/rendering/merge logic.
- This directory owns DB/config/filesystem source adapters for the Next app only.
- Do not import these adapters into Cloudflare Worker/DO code.

## Sources

- Project directories: `.yolk`, `.opencode`, `.claude`, `.agents` where supported by source code.
- Env/config source uses `YOLK_SKILLSET` for app-provided skill/command data.
- DB source reads enabled `agentSkill` and `agentCommand` rows and converts them to portable `SkillsetManifest` data.
- Filesystem adapters are Node boundaries; keep raw FS here, not in packages.

## Rules

- Merge sources deterministically by priority; reject duplicates inside one source.
- Runtime priority is DB user skills/commands, then config, then project files.
- Skill tool runtime policy stays in `lib/agents/tools/skill-tool.ts`.
- Slash command UI/transport stays in `app/agent` and `app/api/agent/commands`.

## Tests

- Test config/filesystem/project source precedence without loading full agent runtime.
- Keep parser/rendering tests in `packages/skillset`.
