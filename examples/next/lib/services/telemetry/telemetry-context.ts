import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { Mutable } from 'effect/Types'

/**
 * Searchable telemetry context admitted into structured logs.
 *
 * Unknown, inherited, symbol, accessor, and non-allowlisted keys are dropped.
 * This does not sanitize `error.message` / `warning.message`; callers own
 * message privacy.
 */
export const TelemetryLogContext = Schema.Struct({
  operation: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Finite),
  runId: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  cause_type: Schema.optionalKey(Schema.String),
  entityId: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(Schema.String),
  retries: Schema.optionalKey(Schema.Finite)
})

export type TelemetryLogContext = typeof TelemetryLogContext.Type

const isOwnDataDescriptor = (
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor =>
  descriptor !== undefined && Object.hasOwn(descriptor, 'value')

const admitStringValue = (descriptor: PropertyDescriptor) =>
  Schema.decodeUnknownEffect(Schema.String)(descriptor.value).pipe(Effect.option)

const admitFiniteValue = (descriptor: PropertyDescriptor) =>
  Schema.decodeUnknownEffect(Schema.Finite)(descriptor.value).pipe(Effect.option)

export const admitTelemetryLogContext = (context: unknown): Effect.Effect<TelemetryLogContext> =>
  Effect.gen(function* () {
    const admitted: Mutable<TelemetryLogContext> = {}

    if (!Predicate.isObject(context)) return admitted

    const readOwnDataDescriptor = (key: keyof TelemetryLogContext) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(context, key)

        if (!isOwnDataDescriptor(descriptor)) {
          return Option.none<PropertyDescriptor>()
        }

        return Option.some(descriptor)
      } catch {
        return Option.none<PropertyDescriptor>()
      }
    }

    const admitStringField = (key: keyof TelemetryLogContext) =>
      Option.match(readOwnDataDescriptor(key), {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: admitStringValue
      })

    const admitFiniteField = (key: keyof TelemetryLogContext) =>
      Option.match(readOwnDataDescriptor(key), {
        onNone: () => Effect.succeed(Option.none<number>()),
        onSome: admitFiniteValue
      })

    const operation = yield* admitStringField('operation')

    if (Option.isSome(operation)) {
      admitted.operation = operation.value
    }

    const status = yield* admitFiniteField('status')

    if (Option.isSome(status)) {
      admitted.status = status.value
    }

    const runId = yield* admitStringField('runId')

    if (Option.isSome(runId)) {
      admitted.runId = runId.value
    }

    const toolCallId = yield* admitStringField('toolCallId')

    if (Option.isSome(toolCallId)) {
      admitted.toolCallId = toolCallId.value
    }

    const causeType = yield* admitStringField('cause_type')

    if (Option.isSome(causeType)) {
      admitted.cause_type = causeType.value
    }

    const entityId = yield* admitStringField('entityId')

    if (Option.isSome(entityId)) {
      admitted.entityId = entityId.value
    }

    const userId = yield* admitStringField('userId')

    if (Option.isSome(userId)) {
      admitted.userId = userId.value
    }

    const retries = yield* admitFiniteField('retries')

    if (Option.isSome(retries)) {
      admitted.retries = retries.value
    }

    return admitted
  })
