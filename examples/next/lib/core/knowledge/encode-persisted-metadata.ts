import { Effect } from 'effect'
import type * as Schema from 'effect/Schema'
import { PersistenceError } from '@/lib/core/errors'
import {
  encodePersistedJsonObject,
  persistedJsonObjectErrorMessage,
  type PersistedJsonObject
} from '@/lib/services/db/persisted-json-object'

export const encodePersistedMetadata = (input: {
  readonly value: unknown
  readonly entity: string
}): Effect.Effect<PersistedJsonObject, PersistenceError> =>
  encodePersistedJsonObject(input.value).pipe(
    Effect.mapError(
      (error: Schema.SchemaError) =>
        new PersistenceError({
          message: persistedJsonObjectErrorMessage(error),
          entity: input.entity,
          cause: error
        })
    )
  )
