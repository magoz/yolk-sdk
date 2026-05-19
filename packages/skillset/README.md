# @yolk-sdk/skillset

Domain-free parsing and catalog primitives for portable skills and slash commands.

## Install

```bash
pnpm add @yolk-sdk/skillset@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Imports

```ts
import {
  formatAvailableSkills,
  mergeSkillsets,
  parseCommandMarkdown,
  parseSkillMarkdown,
  renderCommand,
  validateSkillsetName
} from '@yolk-sdk/skillset'
```

## Skill markdown

```md
---
name: web-search
description: Search the web. Use when current public web context is needed.
---

# Web Search

Instructions...
```

```ts
const skill = parseSkillMarkdown({ path: 'web-search/SKILL.md', content })
```

## Command markdown

```md
---
description: Run a guided package release
---

First load the package-release skill.

<user-request>
$ARGUMENTS
</user-request>
```

```ts
const command = parseCommandMarkdown({ path: 'package-release.md', content })
const prompt = renderCommand(command, 'publish first canary')
```

## Merge model

`mergeSkillsets` combines multiple host-provided sources deterministically. Hosts decide source priority and policy.

## Host responsibilities

- Load skills/commands from filesystem, DB, KV, bundles, or remote sources.
- Enforce policy, permissions, runtime tool wiring, and UI.
- Decide when to inject `formatAvailableSkills` into model context.

## Boundaries

- No filesystem, Next.js, Cloudflare, DB, auth, provider SDKs, or tool execution.
- Package owns schemas, markdown parsing, command rendering, manifests, and merge helpers only.
