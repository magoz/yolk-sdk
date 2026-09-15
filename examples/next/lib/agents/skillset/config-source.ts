import { Config, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  emptySkillsetManifest,
  SkillsetManifest,
  type SkillsetManifest as SkillsetManifestType
} from '@yolk-sdk/agent/skillset'

class ConfigSkillsetError extends Schema.TaggedError<ConfigSkillsetError>()('ConfigSkillsetError', {
  message: Schema.String
}) {}

const configSourceId = 'config'

const decodeSkillsetManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillsetManifest))

const schemaErrorToMessage = (error: Schema.SchemaError) => String(error)

const configErrorToMessage = (error: Config.ConfigError) => String(error)

const configLoadFailureMessage = (error: Config.ConfigError | ConfigSkillsetError) =>
  error instanceof ConfigSkillsetError ? error.message : configErrorToMessage(error)

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
    const raw = yield* Config.option(Config.String('YOLK_SKILLSET'))

    if (Option.isNone(raw)) {
      return emptySkillsetManifest
    }

    return yield* decodeSkillsetManifest(raw.value).pipe(
      Effect.map(withConfigSource),
      Effect.mapError(
        error =>
          new ConfigSkillsetError({
            message: `Invalid YOLK_SKILLSET: ${schemaErrorToMessage(error)}`
          })
      )
    )
  }).pipe(
    Effect.catch((error: Config.ConfigError | ConfigSkillsetError) =>
      Effect.fail(
        new ConfigSkillsetError({
          message: `Could not load skillset config: ${configLoadFailureMessage(error)}`
        })
      )
    )
  )
