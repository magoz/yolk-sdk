import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { loadProjectSkillset } from './project-source'

const writeText = (path: string, content: string) => Effect.promise(() => writeFile(path, content))
const makeDirectory = (path: string) => Effect.promise(() => mkdir(path, { recursive: true }))
const makeTempRoot = () => Effect.promise(() => mkdtemp(join(tmpdir(), 'yolk-skillset-')))

const withConfigEnv = <A, E>(effect: Effect.Effect<A, E>, env: Readonly<Record<string, string>>) =>
  Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe('loadProjectSkillset', () => {
  it.effect('lets config skills override filesystem skills', () =>
    Effect.gen(function* () {
      const root = yield* makeTempRoot()
      const skillDirectory = join(root, '.opencode', 'skills', 'review-code')

      yield* makeDirectory(skillDirectory)
      yield* writeText(
        join(skillDirectory, 'SKILL.md'),
        `---
name: review-code
description: Filesystem review
---

Filesystem content.
`
      )

      const skillset = yield* withConfigEnv(
        loadProjectSkillset(root),
        {
          YOLK_SKILLSET: JSON.stringify({
            version: 1,
            skills: [
              {
                name: 'review-code',
                description: 'Config review',
                location: 'config:review-code',
                content: 'Config content.'
              }
            ],
            commands: []
          })
        }
      )

      expect(skillset.skills).toMatchObject([
        { name: 'review-code', description: 'Config review', content: 'Config content.' }
      ])
    })
  )
})
