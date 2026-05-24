import { S3Service } from '@effect-aws/client-s3'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { Config, Context, DateTime, Effect, Layer, Option, Redacted } from 'effect'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'
import { KnowledgeArtifactError, KnowledgeStoreError } from '@yolk-sdk/knowledge/errors'
import type { KnowledgeArtifact } from '@yolk-sdk/knowledge/artifacts'
import type { KnowledgeLink } from '@yolk-sdk/knowledge/links'
import type {
  KnowledgeRecord,
  KnowledgeScope,
  UpdateKnowledgeRecordInput
} from '@yolk-sdk/knowledge/records'
import type { KnowledgeProvenance } from '@yolk-sdk/knowledge/provenance'
import type { KnowledgeRepresentation } from '@yolk-sdk/knowledge/representations'
import { Db } from '@/lib/services/db/live-layer'
import * as dbSchema from '@/lib/services/db/schema'

type R2KnowledgeArtifactStoreConfigShape = {
  readonly endpoint: string
  readonly bucketName: string
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly region: string
}

export type CreateR2PresignedUploadInput = {
  readonly storageKey: string
  readonly mediaType?: string
  readonly expiresIn?: number
}

export type R2PresignedUpload = {
  readonly uploadUrl: string
  readonly storageKey: string
}

class R2KnowledgeArtifactStoreConfig extends Context.Service<
  R2KnowledgeArtifactStoreConfig,
  R2KnowledgeArtifactStoreConfigShape
>()('@app/R2KnowledgeArtifactStoreConfig') {}

export class R2KnowledgeUploadStore extends Context.Service<
  R2KnowledgeUploadStore,
  {
    readonly createUploadUrl: (input: CreateR2PresignedUploadInput) => Effect.Effect<R2PresignedUpload, KnowledgeArtifactError>
  }
>()('@app/R2KnowledgeUploadStore') {}

const optionString = (option: Option.Option<string>) =>
  Option.isSome(option) && option.value.trim().length > 0 ? option.value.trim() : undefined

const R2KnowledgeArtifactStoreConfigLayer = Layer.effect(
  R2KnowledgeArtifactStoreConfig,
  Effect.gen(function* () {
    const endpoint = yield* Config.string('R2_ENDPOINT')
    const bucketName = yield* Config.string('R2_BUCKET_NAME')
    const accessKeyId = yield* Config.redacted('R2_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.redacted('R2_SECRET_ACCESS_KEY')
    const region = optionString(yield* Config.option(Config.string('R2_REGION'))) ?? 'auto'

    return { endpoint, bucketName, accessKeyId, secretAccessKey, region }
  }).pipe(
    Effect.mapError(() =>
      new KnowledgeArtifactError({
        message: 'R2 artifact store config missing: R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
      })
    )
  )
)

const R2S3ClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* R2KnowledgeArtifactStoreConfig

    return S3Service.layer({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: Redacted.value(config.accessKeyId),
        secretAccessKey: Redacted.value(config.secretAccessKey)
      }
    })
  })
).pipe(Layer.provide(R2KnowledgeArtifactStoreConfigLayer))

const scopeUserId = (scope: KnowledgeScope) => scope.id

const toDateTime = (date: Date) => DateTime.fromDateUnsafe(date)

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const propertyValue = (input: unknown, key: string) => {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  return Object.getOwnPropertyDescriptor(input, key)?.value
}

const stringProperty = (input: unknown, key: string) => {
  const value = propertyValue(input, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const numberProperty = (input: unknown, key: string) => {
  const value = propertyValue(input, key)
  return typeof value === 'number' ? value : undefined
}

const externalErrorMessage = (error: unknown) => {
  const name = error instanceof Error && error.name.length > 0
    ? error.name
    : stringProperty(error, 'name')
  const message = error instanceof Error
    ? error.message
    : stringProperty(error, 'message')
  const metadata = propertyValue(error, '$metadata')
  const status = numberProperty(metadata, 'httpStatusCode')
  const details = [name, status === undefined ? undefined : `HTTP ${status}`, message]
    .filter(detail => detail !== undefined && detail.length > 0)
    .join(' · ')

  return details.length > 0 ? details : undefined
}

const artifactIntegrationError = (message: string, cause: unknown) => {
  const details = externalErrorMessage(cause)
  return new KnowledgeArtifactError({ message: details === undefined ? message : `${message}: ${details}`, cause })
}

const storeError = (message: string, cause?: unknown) => new KnowledgeStoreError({ message, cause })
const artifactError = (message: string, cause?: unknown) => new KnowledgeArtifactError({ message, cause })

const mapStoreError = (error: unknown) =>
  error instanceof KnowledgeStoreError ? error : storeError(unknownToMessage(error), error)

export const knowledgeArtifactStorageKey = (input: {
  readonly recordId: string
  readonly artifactId: string
  readonly kind: KnowledgeArtifact['kind']
  readonly extension?: string
}) => {
  switch (input.kind) {
    case 'original':
      return `knowledge/${input.recordId}/original/${input.artifactId}`
    case 'extracted_text':
      return `knowledge/${input.recordId}/derived/text/${input.artifactId}${input.extension ?? '.txt'}`
    case 'thumbnail':
      return `knowledge/${input.recordId}/derived/thumb/${input.artifactId}${input.extension ?? '.png'}`
    case 'transcript':
      return `knowledge/${input.recordId}/derived/transcript/${input.artifactId}${input.extension ?? '.json'}`
    case 'caption':
    case 'structured':
      return `knowledge/${input.recordId}/derived/structured/${input.artifactId}${input.extension ?? '.json'}`
  }
}

const toObject = (row: typeof dbSchema.knowledgeRecord.$inferSelect): KnowledgeRecord => ({
  id: row.id,
  role: row.role,
  title: row.title,
  status: row.status,
  contextPolicy: row.contextPolicy,
  summary: row.summary ?? undefined,
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt),
  updatedAt: toDateTime(row.updatedAt)
})

const toArtifact = (row: typeof dbSchema.knowledgeArtifact.$inferSelect): KnowledgeArtifact => ({
  id: row.id,
  recordId: row.recordId,
  kind: row.kind,
  storageKey: row.storageKey,
  mediaType: row.mediaType ?? undefined,
  byteSize: row.byteSize ?? undefined,
  checksum: row.checksum ?? undefined,
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt)
})

const toRepresentation = (
  row: typeof dbSchema.knowledgeRepresentation.$inferSelect
): KnowledgeRepresentation => ({
  id: row.id,
  recordId: row.recordId,
  artifactId: row.artifactId ?? undefined,
  modality: row.modality,
  status: row.status,
  contentText: row.contentText ?? undefined,
  summary: row.summary ?? undefined,
  model: row.model ?? undefined,
  errorMessage: row.errorMessage ?? undefined,
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt),
  updatedAt: toDateTime(row.updatedAt)
})

const toProvenance = (row: typeof dbSchema.knowledgeProvenance.$inferSelect): KnowledgeProvenance => ({
  id: row.id,
  recordId: row.recordId,
  artifactId: row.artifactId ?? undefined,
  sourceKind: row.sourceKind,
  sourceLabel: row.sourceLabel,
  sourceUrl: row.sourceUrl ?? undefined,
  observedAt: row.observedAt === null ? undefined : toDateTime(row.observedAt),
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt)
})

const toLink = (row: typeof dbSchema.knowledgeLink.$inferSelect): KnowledgeLink => ({
  id: row.id,
  fromRecordId: row.fromRecordId,
  toRecordId: row.toRecordId,
  type: row.type,
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt)
})

const updateSet = (input: {
  readonly existing: typeof dbSchema.knowledgeRecord.$inferSelect
  readonly update: UpdateKnowledgeRecordInput
}) => ({
  title: input.update.title ?? input.existing.title,
  status: input.update.status ?? input.existing.status,
  contextPolicy: input.update.contextPolicy ?? input.existing.contextPolicy,
  summary: input.update.summary ?? input.existing.summary,
  metadata: input.update.metadata ?? input.existing.metadata,
  updatedAt: sql`CURRENT_TIMESTAMP`
})

export const DrizzleKnowledgeStoreLayer = Layer.effect(
  KnowledgeStore,
  Effect.gen(function* () {
    const db = yield* Db
    const getScopedObject = (input: { readonly scope: KnowledgeScope; readonly id: string }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(dbSchema.knowledgeRecord)
          .where(
            and(
              eq(dbSchema.knowledgeRecord.id, input.id),
              eq(dbSchema.knowledgeRecord.userId, scopeUserId(input.scope))
            )
          )

        if (row === undefined) {
          return yield* Effect.fail(storeError('Knowledge record not found'))
        }

        return row
      })

    return {
      createRecord: input =>
        Effect.gen(function* () {
          const [created] = yield* db
            .insert(dbSchema.knowledgeRecord)
            .values({
              userId: scopeUserId(input.scope),
              role: input.role,
              title: input.title,
              contextPolicy: input.contextPolicy,
              summary: input.summary,
              metadata: input.metadata ?? {}
            })
            .returning()

          if (created === undefined) {
            return yield* Effect.fail(storeError('Could not create knowledge record'))
          }

          return toObject(created)
        }).pipe(Effect.withSpan('KnowledgeStore.createRecord'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      updateRecord: input =>
        Effect.gen(function* () {
          const existing = yield* getScopedObject({ scope: input.scope, id: input.id })
          const [updated] = yield* db
            .update(dbSchema.knowledgeRecord)
            .set(updateSet({ existing, update: input }))
            .where(
              and(
                eq(dbSchema.knowledgeRecord.id, input.id),
                eq(dbSchema.knowledgeRecord.userId, scopeUserId(input.scope))
              )
            )
            .returning()

          if (updated === undefined) {
            return yield* Effect.fail(storeError('Could not update knowledge record'))
          }

          return toObject(updated)
        }).pipe(Effect.withSpan('KnowledgeStore.updateRecord'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      getRecord: input =>
        getScopedObject(input).pipe(
          Effect.map(toObject),
          Effect.withSpan('KnowledgeStore.getRecord'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      listRecords: input =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(dbSchema.knowledgeRecord)
            .where(eq(dbSchema.knowledgeRecord.userId, scopeUserId(input.scope)))
            .orderBy(desc(dbSchema.knowledgeRecord.createdAt))
            .limit(input.limit)

          return { records: rows.map(toObject) }
        }).pipe(Effect.withSpan('KnowledgeStore.listRecords'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listPinned: input =>
        Effect.gen(function* () {
          const objects = yield* db
            .select()
            .from(dbSchema.knowledgeRecord)
            .where(
              and(
                eq(dbSchema.knowledgeRecord.userId, scopeUserId(input.scope)),
                eq(dbSchema.knowledgeRecord.contextPolicy, 'pinned')
              )
            )
            .orderBy(desc(dbSchema.knowledgeRecord.updatedAt))
            .limit(input.limit)

          const recordIds = objects.map(object => object.id)
          const representations = recordIds.length === 0
            ? []
            : yield* db
                .select()
                .from(dbSchema.knowledgeRepresentation)
                .where(
                  and(
                    eq(dbSchema.knowledgeRepresentation.status, 'ready'),
                    inArray(dbSchema.knowledgeRepresentation.recordId, recordIds)
                  )
                )

          return {
            records: objects.map(toObject),
            representations: representations.map(toRepresentation)
          }
        }).pipe(Effect.withSpan('KnowledgeStore.listPinned'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      deleteRecord: input =>
        Effect.gen(function* () {
          yield* db
            .delete(dbSchema.knowledgeRecord)
            .where(
              and(
                eq(dbSchema.knowledgeRecord.id, input.id),
                eq(dbSchema.knowledgeRecord.userId, scopeUserId(input.scope))
              )
            )
        }).pipe(Effect.withSpan('KnowledgeStore.deleteRecord'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listArtifacts: input =>
        Effect.gen(function* () {
          yield* getScopedObject(input)
          const rows = yield* db
            .select()
            .from(dbSchema.knowledgeArtifact)
            .where(eq(dbSchema.knowledgeArtifact.recordId, input.id))

          return rows.map(toArtifact)
        }).pipe(Effect.withSpan('KnowledgeStore.listArtifacts'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listProvenance: input =>
        Effect.gen(function* () {
          yield* getScopedObject(input)
          const rows = yield* db
            .select()
            .from(dbSchema.knowledgeProvenance)
            .where(eq(dbSchema.knowledgeProvenance.recordId, input.id))

          return rows.map(toProvenance)
        }).pipe(Effect.withSpan('KnowledgeStore.listProvenance'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listLinks: input =>
        Effect.gen(function* () {
          yield* getScopedObject(input)
          const rows = yield* db
            .select()
            .from(dbSchema.knowledgeLink)
            .where(eq(dbSchema.knowledgeLink.fromRecordId, input.id))

          return rows.map(toLink)
        }).pipe(Effect.withSpan('KnowledgeStore.listLinks'), Effect.catch(error => Effect.fail(mapStoreError(error))))
    }
  })
)

export const R2KnowledgeArtifactStoreLayer = Layer.effect(
  KnowledgeArtifactStore,
  Effect.gen(function* () {
    const config = yield* R2KnowledgeArtifactStoreConfig
    const client = yield* S3Service

    return {
      putArtifact: input =>
        client.putObject({
          Bucket: config.bucketName,
          Key: input.storageKey,
          Body: input.bytes,
          ContentType: input.mediaType
        }).pipe(
          Effect.asVoid,
          Effect.withSpan('KnowledgeArtifactStore.putArtifact'),
          Effect.catch(error => Effect.fail(artifactIntegrationError('Could not upload knowledge artifact', error)))
        ),

      getArtifact: input =>
        Effect.gen(function* () {
          const response = yield* client.getObject({ Bucket: config.bucketName, Key: input.storageKey })
          const body = response.Body
          if (body === undefined) {
            return yield* Effect.fail(artifactError('R2 object body missing'))
          }

          return yield* Effect.tryPromise({
            try: () => body.transformToByteArray(),
            catch: error => artifactIntegrationError('Could not read knowledge artifact body', error)
          })
        }).pipe(
          Effect.withSpan('KnowledgeArtifactStore.getArtifact'),
          Effect.catch(error => Effect.fail(artifactIntegrationError('Could not download knowledge artifact', error)))
        ),

      deleteArtifact: input =>
        client.deleteObject({ Bucket: config.bucketName, Key: input.storageKey }).pipe(
          Effect.asVoid,
          Effect.withSpan('KnowledgeArtifactStore.deleteArtifact'),
          Effect.catch(error => Effect.fail(artifactIntegrationError('Could not delete knowledge artifact', error)))
        )
    }
  })
).pipe(Layer.provide(R2S3ClientLayer), Layer.provide(R2KnowledgeArtifactStoreConfigLayer))

export const R2KnowledgeUploadStoreLayer = Layer.effect(
  R2KnowledgeUploadStore,
  Effect.gen(function* () {
    const config = yield* R2KnowledgeArtifactStoreConfig
    const client = yield* S3Service

    return {
      createUploadUrl: input =>
        client.putObject(
          {
            Bucket: config.bucketName,
            Key: input.storageKey,
            ContentType: input.mediaType
          },
          { presigned: true, expiresIn: input.expiresIn ?? 900 }
        ).pipe(
          Effect.map(uploadUrl => ({ uploadUrl, storageKey: input.storageKey })),
          Effect.withSpan('R2KnowledgeUploadStore.createUploadUrl'),
          Effect.catch(error => Effect.fail(artifactIntegrationError('Could not create knowledge upload URL', error)))
        )
    }
  })
).pipe(Layer.provide(R2S3ClientLayer), Layer.provide(R2KnowledgeArtifactStoreConfigLayer))

export const KnowledgeLayer = DrizzleKnowledgeStoreLayer.pipe(Layer.provide(Db.layer))
