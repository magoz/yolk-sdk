import { Effect, Match } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  KnowledgeFileSource,
  KnowledgeTextSource,
  KnowledgeUrlSource,
  type KnowledgeSource
} from '@yolk-sdk/knowledge/documents'
import { SearchIndexStoreError } from '@yolk-sdk/knowledge/errors'
import type { StorageObject } from '@/lib/services/db/schema'

type StorageSourceRow = Pick<
  StorageObject,
  'id' | 'sourceType' | 'r2Key' | 'url' | 'filename' | 'mediaType'
>

const optionalSourceText = (value: string | null) => {
  if (value === null) {
    return undefined
  }

  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : undefined
}

const sourceSchemaError = (label: string) => (error: Schema.SchemaError) =>
  new SearchIndexStoreError({
    message: `Invalid ${label}: ${error.message}`,
    cause: error
  })

const presentOpaqueLocator = (input: {
  readonly value: string | null
  readonly field: string
}): Effect.Effect<string, SearchIndexStoreError> => {
  if (input.value === null || input.value.length === 0) {
    return Effect.fail(
      new SearchIndexStoreError({
        message: `Storage ${input.field} is missing`
      })
    )
  }

  if (input.value.trim() !== input.value) {
    return Effect.fail(
      new SearchIndexStoreError({
        message: `Storage ${input.field} has surrounding whitespace`
      })
    )
  }

  return Effect.succeed(input.value)
}

export const knowledgeSourceFromStorageRow = (
  row: StorageSourceRow
): Effect.Effect<KnowledgeSource, SearchIndexStoreError> =>
  Match.value(row.sourceType).pipe(
    Match.when('file', () =>
      presentOpaqueLocator({ value: row.id, field: 'file source id' }).pipe(
        Effect.flatMap(ref =>
          KnowledgeFileSource.makeEffect({
            ref,
            name: optionalSourceText(row.filename),
            mediaType: optionalSourceText(row.mediaType)
          }).pipe(Effect.mapError(sourceSchemaError('storage file source')))
        )
      )
    ),
    Match.when('url', () =>
      presentOpaqueLocator({ value: row.url, field: 'url source url' }).pipe(
        Effect.flatMap(url =>
          KnowledgeUrlSource.makeEffect({ url }).pipe(
            Effect.mapError(sourceSchemaError('storage url source'))
          )
        )
      )
    ),
    Match.when('text', () => {
      const label = optionalSourceText(row.filename)

      return KnowledgeTextSource.makeEffect(label === undefined ? {} : { label }).pipe(
        Effect.mapError(sourceSchemaError('storage text source'))
      )
    }),
    Match.exhaustive
  )
