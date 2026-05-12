import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { loadProjectSkillset } from './file-source'

const writeText = (path: string, content: string) => Effect.promise(() => writeFile(path, content))
const makeDirectory = (path: string) => Effect.promise(() => mkdir(path, { recursive: true }))

const makeTempRoot = () => Effect.promise(() => mkdtemp(join(tmpdir(), 'yolk-skillset-')))

describe('loadProjectSkillset', () => {
  it.effect('loads project skills and commands from standard folders', () =>
    Effect.gen(function* () {
      const root = yield* makeTempRoot()
      const skillDirectory = join(root, '.opencode', 'skills', 'review-code')
      const commandDirectory = join(root, '.opencode', 'commands')

      yield* makeDirectory(skillDirectory)
      yield* makeDirectory(commandDirectory)
      yield* writeText(
        join(skillDirectory, 'SKILL.md'),
        `---
name: review-code
description: Review code carefully
---

Check types and tests.
`
      )
      yield* writeText(
        join(commandDirectory, 'review.md'),
        `---
description: Review changes
---

Review $ARGUMENTS.
`
      )

      const skillset = yield* loadProjectSkillset(root)

      expect(skillset.skills.map(skill => skill.name)).toEqual(['review-code'])
      expect(skillset.commands.map(command => command.name)).toEqual(['review'])
    })
  )

  it.effect('uses .yolk entries before .opencode entries with same name', () =>
    Effect.gen(function* () {
      const root = yield* makeTempRoot()
      const yolkSkillDirectory = join(root, '.yolk', 'skills', 'review-code')
      const opencodeSkillDirectory = join(root, '.opencode', 'skills', 'review-code')

      yield* makeDirectory(yolkSkillDirectory)
      yield* makeDirectory(opencodeSkillDirectory)
      yield* writeText(
        join(opencodeSkillDirectory, 'SKILL.md'),
        `---
name: review-code
description: OpenCode review
---

OpenCode content.
`
      )
      yield* writeText(
        join(yolkSkillDirectory, 'SKILL.md'),
        `---
name: review-code
description: Yolk review
---

Yolk content.
`
      )

      const skillset = yield* loadProjectSkillset(root)

      expect(skillset.skills).toMatchObject([
        { name: 'review-code', description: 'Yolk review', content: 'Yolk content.' }
      ])
    })
  )
})
