import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { loadConfigSkillsetManifest } from './config-source'

const withConfigEnv = <A, E>(effect: Effect.Effect<A, E>, env: Readonly<Record<string, string>>) =>
  Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe('loadConfigSkillsetManifest', () => {
  it.effect('returns an empty manifest without config', () =>
    withConfigEnv(
      Effect.gen(function* () {
        const manifest = yield* loadConfigSkillsetManifest()

        expect(manifest).toEqual({ version: 1, skills: [], commands: [] })
      }),
      {}
    )
  )

  it.effect('loads user-provided skills and commands from config', () =>
    withConfigEnv(
      Effect.gen(function* () {
        const manifest = yield* loadConfigSkillsetManifest()

        expect(manifest.skills).toMatchObject([{ name: 'user-skill', source: 'config' }])
        expect(manifest.commands).toMatchObject([{ name: 'user-command', source: 'config' }])
      }),
      {
        YOLK_SKILLSET: JSON.stringify({
          version: 1,
          skills: [
            {
              name: 'user-skill',
              description: 'User skill',
              location: 'config:user-skill',
              content: 'Use the user preference.'
            }
          ],
          commands: [
            {
              name: 'user-command',
              description: 'User command',
              template: 'Do $ARGUMENTS.',
              hints: ['$ARGUMENTS']
            }
          ]
        })
      }
    )
  )

  it.effect('rejects invalid config', () =>
    withConfigEnv(
      Effect.gen(function* () {
        const result = yield* loadConfigSkillsetManifest().pipe(Effect.result)

        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'ConfigSkillsetError' }
        })
      }),
      { YOLK_SKILLSET: '{' }
    )
  )
})
