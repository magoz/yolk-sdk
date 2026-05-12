# Skills + Commands Spec

## Goal

Add reusable agent behavior without bloating default context.

- **Skills**: model-callable context loaders.
- **Commands**: user-callable prompt macros.
- Consumer-facing format should stay folder/Markdown based.
- Runtime should consume normalized catalogs, not assume filesystem access.

## Reference

`opencode` is the main reference.

### Skills in opencode

- Stored as `skills/<name>/SKILL.md`.
- Discovered from project/global `.opencode`, `.claude`, and `.agents` dirs.
- Agent sees only compact metadata in `<available_skills>`.
- Agent calls a `skill` tool to load full content on demand.
- Tool returns skill body, base directory, and sampled files.
- Permissions can allow/deny/ask per skill pattern.

### Commands in opencode

- Stored as `commands/<name>.md`.
- Markdown frontmatter configures `description`, `agent`, `model`, `subtask`.
- Body is prompt template.
- Supports `$ARGUMENTS`, `$1`, `$2`, shell interpolation, and file refs.
- Execution renders prompt, then submits it as a normal user turn or subtask.

## Yolk architecture fit

Keep this app-owned first.

- `packages/*` stays domain-free.
- App owns prompts, config, tools, auth, and policy.
- `/api/agent` is stateless transcript mode.
- Browser owns transcript.
- Tools already go through `@yolk/tool-registry`.

## Architecture conclusion

Separate authoring format from runtime source.

```txt
Authoring format
  folders + Markdown
        ↓
Catalog source
  filesystem | bundle | KV/R2 | DB | remote package
        ↓
Runtime catalog
  list/get skills, list/get/render commands
        ↓
Agent runtime
  system prompt metadata + tools + normal user messages
```

Filesystem is one source adapter, not the core abstraction.

### Consumer format

Consumers author standard folders regardless of deployment target:

```txt
.yolk/skills/<name>/SKILL.md
.yolk/commands/<name>.md
.opencode/skills/<name>/SKILL.md
.opencode/commands/<name>.md
.claude/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
```

Runtime receives normalized records.

### Core interfaces

```ts
type SkillCatalog = {
  readonly list: () => Effect.Effect<ReadonlyArray<SkillInfo>>
  readonly get: (name: string) => Effect.Effect<Option.Option<SkillInfo>>
}

type CommandCatalog = {
  readonly list: () => Effect.Effect<ReadonlyArray<CommandInfo>>
  readonly get: (name: string) => Effect.Effect<Option.Option<CommandInfo>>
}
```

### Source adapters

```txt
FileCatalogSource
  reads standard folders at runtime

BundleCatalogSource
  imports build-generated catalog for no-filesystem runtimes

KvCatalogSource / R2CatalogSource
  reads persisted normalized records

DbCatalogSource
  reads user/project-owned records

CompositeCatalogSource
  merges sources with deterministic priority
```

### Merge priority

Higher priority overrides same-name lower priority entries:

```txt
user/project DB
> project .yolk
> project .opencode
> project .claude / .agents
> bundled defaults
```

### No-filesystem runtimes

For Cloudflare/Workers, preserve same consumer folders but compile them:

```txt
standard folders
  ↓
pnpm skillset:build
  ↓
generated/skillset.ts or .json
  ↓
Worker bundle
  ↓
BundleCatalogSource
```

This keeps authoring portable while runtime stays filesystem-free.

### Package boundary

Longer term, reusable parsing/merge/render can live in a domain-free package:

```txt
packages/skillset
  schemas
  markdown parsers
  command renderer
  catalog merge
  no filesystem dependency
```

Node-only helpers can live behind a subpath later:

```txt
@yolk/skillset/node
```

App and Cloudflare own concrete source adapters and policy.

Conceptually, `skillset` is a portable set of skills and commands that shape agent behavior.

It owns skills and commands only. Avoid broadening it into tools, providers, models, agents, auth, storage, or policy.

## Reference comparison

### opencode

Closest reference.

- Uses standard folders.
- Normalizes into `Skill.Service` and `Command.Service`.
- Runtime calls `skill.all/get` and `commands.list/get`.
- Still filesystem-first; no no-filesystem source abstraction needed.

### Codex app-server / t3code

Relevant at protocol level.

- Exposes `skills/list`, `skills/config/write`, `skills/changed`.
- Treats skills as normalized metadata behind an API.
- Implementation is hidden behind Codex server.

### kody

Related but different.

- Uses backend capability registries and MCP-style tools.
- Good registry pattern.
- Not folder-first for consumer authoring.

### Executor

Conceptually similar catalog pattern, different domain.

Executor maps integration sources into a normalized executable tool catalog:

```txt
integration source
  ↓
normalized tool catalog
  ↓
policy / auth / secrets / scopes
  ↓
tool invocation
```

Core concepts:

- `sources.list/detect/refresh`
- `tools.list/schema/invoke`
- connections, secrets, policies, scopes

The useful pattern is:

```txt
many source formats → normalized catalog → host consumes
```

`skillset` uses the same shape for a different layer:

```txt
authoring source
  ↓
normalized agent affordance catalog
  ↓
prompt/tool/UI projection
```

Executor answers:

```txt
What executable tools can the agent call?
```

`skillset` answers:

```txt
What behavior/context can agent or user invoke?
```

Do not copy Executor's execution/auth system into `skillset`.

Keep out of core:

- tool invocation
- OAuth/secrets
- policies/scopes
- DB/storage adapters

Those remain in `tool-registry`, app services, and host adapters.

### Yolk synthesis

```txt
opencode/Claude folder UX
+ Codex-like normalized catalog
+ Executor-like source → catalog shape
+ source adapters for fs/bundle/KV/DB
+ Yolk tool-registry/runtime boundaries
```

## Skills v1

### Discovery

Project-local only:

```txt
.opencode/skills/<name>/SKILL.md
.claude/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
```

No v1 support for:

- global dirs
- remote skill URLs
- file watchers
- permission DSL

### Skill shape

```ts
type SkillInfo = {
  readonly name: string
  readonly description: string
  readonly location: string
  readonly content: string
}
```

Frontmatter:

- `name` required
- `description` required

Name rules:

- lowercase alphanumeric
- single hyphen separators
- directory name must match `name`

### Runtime

Add app-owned code:

```txt
lib/agents/skills/
  skill.ts
  load-skills.ts
  skill-tool.ts
```

Register `skill` through `lib/agents/tools/registry.ts`.

Tool input:

```ts
{ readonly name: string }
```

Tool output includes:

- skill content
- base directory URL/path
- sampled sibling files, excluding `SKILL.md`

Tool metadata:

- `access: 'read'`
- text only initially
- voice disabled initially

### Prompt injection

Append compact skill metadata to the text agent system prompt:

```xml
<available_skills>
  <skill>
    <name>git-release</name>
    <description>Create consistent releases and changelogs</description>
  </skill>
</available_skills>
```

Do not inject full skill content by default.

## Commands v1

### Discovery

Project-local only:

```txt
.opencode/commands/<name>.md
```

### Command shape

```ts
type CommandInfo = {
  readonly name: string
  readonly description: string
  readonly template: string
  readonly hints: ReadonlyArray<string>
}
```

Frontmatter:

- `description` optional

Defer:

- `agent`
- `model`
- `subtask`

### Rendering

Support:

- `$ARGUMENTS`
- `$1`, `$2`, ...
- append raw args if template has no placeholders

Defer:

- shell interpolation
- file refs
- subagent execution

### UX

Add slash command UI to composer:

- `/` opens command picker.
- `/name args` renders command.
- Rendered command becomes normal user message.
- Existing `/api/agent` transport stays unchanged.

Prefer server-side rendering boundary:

```txt
POST /api/agent/command
{ command, arguments }
→ { content }
```

Then browser appends `content` as the user message and starts current text run.

## Security

Do not shell execute command templates in v1.

Do not load remote skills in v1.

Do not expose local filesystem content beyond the loaded skill and sampled skill-dir files.

Never let skills bypass existing tool policy.

## Implementation order

### Phase 0: lock v1 decisions

- Package name: `skillset`.
- Standard folder inputs.
- No filesystem dependency in core package.
- No shell interpolation v1.
- No command file refs v1.
- No global dirs v1.
- No permissions DSL v1.

### Phase 1: `packages/skillset` core

Build reusable, runtime-agnostic primitives first.

- schemas
- name validation
- parse `SKILL.md`
- parse command markdown
- render command args
- manifest schema
- merge skillsets
- semantic tests

No filesystem, Next.js, Cloudflare, auth, DB, or tool execution.

### Phase 2: file source

Start app-local unless Cloudflare build support is immediately needed:

```txt
lib/agents/skillset/file-source.ts
```

Reads standard folders and returns normalized skillset records.

Later, if useful, move Node helpers behind:

```txt
@yolk/skillset/node
```

### Phase 3: skills runtime

Wire into text agent.

- load skillset in `/api/agent`
- append `<available_skills>` to system prompt
- register `skill` tool
- test prompt/tool behavior

This gives first user-visible value.

### Phase 4: build manifest

Add no-filesystem support after skills runtime works in Next.

```txt
pnpm skillset:build
generated/skillset.ts or .json
```

Cloudflare imports generated manifest through a bundle/static source.

### Phase 5: commands backend

- list commands
- render command args
- route or server action for rendering
- tests

Keep rendered command as a normal user message.

### Phase 6: slash command UI

- `/` opens command picker
- show command descriptions/hints
- submit rendered prompt via existing chat flow

### Later

- global dirs
- DB/KV/R2 sources
- remote packages
- command file refs
- command shell interpolation
- permissions DSL
- voice skills

Preferred sequence:

```txt
skillset core
→ file source
→ skill tool
→ build manifest / Cloudflare
→ command renderer
→ slash UI
```

Do not start with UI. Lock runtime contract first.

## Implementation status

Completed:

- `packages/skillset` core package.
- Skill parsing + name/directory validation.
- Command parsing + argument rendering.
- Manifest schema + merge helpers.
- App filesystem source for standard project folders.
- App config source via `YOLK_SKILLSET` manifest JSON.
- Text-only `skill` tool via `@yolk/tool-registry`.
- `/api/agent` loads merged config + project filesystem skillset and injects `<available_skills>`.
- `/api/agent/commands` lists commands and renders command prompt macros.
- `/agent` composer has slash command picker + render/submit flow.
- Tests for package core, file source, skill tool, and slash command model.

Config shape:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "user-skill",
      "description": "User-authored skill",
      "location": "config:user-skill",
      "content": "Use this instruction when relevant."
    }
  ],
  "commands": []
}
```

Source priority:

```txt
YOLK_SKILLSET config
> project filesystem folders
```

Remaining:

- Build-generated manifest for Cloudflare/no-filesystem runtime.
- Global dirs, DB/KV/R2 sources, permissions, file refs, shell interpolation.

## Open questions

- Global skills?
- Commands repo only?
- Command file refs v1?
- Shell interpolation ever?
- Skills visible to voice?
