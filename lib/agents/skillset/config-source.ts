import { Config, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { emptySkillsetManifest, SkillsetManifest, type SkillsetManifest as SkillsetManifestType } from '@yolk/skillset'

class ConfigSkillsetError extends Schema.TaggedErrorClass<ConfigSkillsetError>()(
  'ConfigSkillsetError',
  {
    message: Schema.String
  }
) {}

const configSourceId = 'config'

const decodeSkillsetManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillsetManifest))

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const withConfigSource = (manifest: SkillsetManifestType): SkillsetManifestType => ({
  version: 1,
  skills: manifest.skills.map(skill => ({
    ...skill,
    source: skill.source ?? configSourceId
  })),
  commands: manifest.commands.map(command => ({
    ...command,
    source: command.source ?? configSourceId
  }))
})

export const loadConfigSkillsetManifest = (): Effect.Effect<
  SkillsetManifestType,
  ConfigSkillsetError
> =>
  Effect.gen(function* () {
    const raw = yield* Config.option(Config.string('YOLK_SKILLSET'))

    if (Option.isNone(raw)) {
      return emptySkillsetManifest
    }

    return yield* decodeSkillsetManifest(raw.value).pipe(
      Effect.map(withConfigSource),
      Effect.mapError(
        error =>
          new ConfigSkillsetError({ message: `Invalid YOLK_SKILLSET: ${unknownToMessage(error)}` })
      )
    )
  }).pipe(
    Effect.catch(error =>
      Effect.fail(
        new ConfigSkillsetError({ message: `Could not load skillset config: ${unknownToMessage(error)}` })
      )
    )
  )
