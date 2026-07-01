import { S3Service } from '@effect-aws/client-s3'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Config, Context, DateTime, Effect, Layer, Option, Redacted } from 'effect'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { KnowledgeStore } from '@yolk-sdk/knowledge/store'
import { KnowledgeFileError, KnowledgeStoreError } from '@yolk-sdk/knowledge/errors'
import type {
  KnowledgeDocument,
  KnowledgeFile,
  KnowledgeScope,
  UpdateKnowledgeDocumentInput
} from '@yolk-sdk/knowledge/documents'
import { Db } from '@/lib/services/db/live-layer'
import * as dbSchema from '@/lib/services/db/schema'

type R2KnowledgeFileStoreConfigShape = {
  readonly endpoint: string
  readonly bucketName: string
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly region: string
}

type KnowledgeFileKind = 'original' | 'extracted_text' | 'thumbnail' | 'transcript' | 'caption' | 'structured'

export type CreateR2PresignedUploadInput = {
  readonly storageKey: string
  readonly mediaType?: string
  readonly expiresIn?: number
}

export type R2PresignedUpload = {
  readonly uploadUrl: string
  readonly storageKey: string
}

class R2KnowledgeFileStoreConfig extends Context.Service<
  R2KnowledgeFileStoreConfig,
  R2KnowledgeFileStoreConfigShape
>()('@app/R2KnowledgeFileStoreConfig') {}

export class R2KnowledgeUploadStore extends Context.Service<
  R2KnowledgeUploadStore,
  {
    readonly createUploadUrl: (input: CreateR2PresignedUploadInput) => Effect.Effect<R2PresignedUpload, KnowledgeFileError>
  }
>()('@app/R2KnowledgeUploadStore') {}

const optionString = (option: Option.Option<string>) =>
  Option.isSome(option) && option.value.trim().length > 0 ? option.value.trim() : undefined

const R2KnowledgeFileStoreConfigLayer = Layer.effect(
  R2KnowledgeFileStoreConfig,
  Effect.gen(function* () {
    const endpoint = yield* Config.string('R2_ENDPOINT')
    const bucketName = yield* Config.string('R2_BUCKET_NAME')
    const accessKeyId = yield* Config.redacted('R2_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.redacted('R2_SECRET_ACCESS_KEY')
    const region = optionString(yield* Config.option(Config.string('R2_REGION'))) ?? 'auto'

    return { endpoint, bucketName, accessKeyId, secretAccessKey, region }
  }).pipe(
    Effect.mapError(() =>
      new KnowledgeFileError({
        message: 'R2 file store config missing: R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
      })
    )
  )
)

const R2S3ClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* R2KnowledgeFileStoreConfig

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
).pipe(Layer.provide(R2KnowledgeFileStoreConfigLayer))

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

const fileIntegrationError = (message: string, cause: unknown) => {
  const details = externalErrorMessage(cause)
  return new KnowledgeFileError({ message: details === undefined ? message : `${message}: ${details}`, cause })
}

const storeError = (message: string, cause?: unknown) => new KnowledgeStoreError({ message, cause })
const fileError = (message: string, cause?: unknown) => new KnowledgeFileError({ message, cause })

const mapStoreError = (error: unknown) =>
  error instanceof KnowledgeStoreError ? error : storeError(unknownToMessage(error), error)

export const knowledgeFileStorageKey = (input: {
  readonly documentId: string
  readonly fileId: string
  readonly kind: KnowledgeFileKind
  readonly extension?: string
}) => {
  switch (input.kind) {
    case 'original':
      return `knowledge/${input.documentId}/original/${input.fileId}`
    case 'extracted_text':
      return `knowledge/${input.documentId}/derived/text/${input.fileId}${input.extension ?? '.txt'}`
    case 'thumbnail':
      return `knowledge/${input.documentId}/derived/thumb/${input.fileId}${input.extension ?? '.png'}`
    case 'transcript':
      return `knowledge/${input.documentId}/derived/transcript/${input.fileId}${input.extension ?? '.json'}`
    case 'caption':
    case 'structured':
      return `knowledge/${input.documentId}/derived/structured/${input.fileId}${input.extension ?? '.json'}`
  }
}

const rowToDocument = (input: {
  readonly document: typeof dbSchema.userKnowledgeDocument.$inferSelect
}): KnowledgeDocument => ({
  id: input.document.id,
  slug: input.document.slug,
  title: input.document.title,
  purpose: input.document.purpose,
  origin: input.document.origin,
  content: input.document.content,
  status: input.document.status,
  availability: input.document.availability,
  summary: input.document.summary ?? undefined,
  errorMessage: input.document.errorMessage ?? undefined,
  reviewedAt: input.document.reviewedAt === null ? undefined : toDateTime(input.document.reviewedAt),
  metadata: input.document.metadata,
  createdAt: toDateTime(input.document.createdAt),
  updatedAt: toDateTime(input.document.updatedAt)
})

const rowToFile = (row: typeof dbSchema.userKnowledgeFile.$inferSelect): KnowledgeFile => ({
  id: row.id,
  documentId: row.documentId,
  storageKey: row.storageKey,
  mediaType: row.mediaType ?? undefined,
  byteSize: row.byteSize ?? undefined,
  checksum: row.checksum ?? undefined,
  metadata: row.metadata,
  createdAt: toDateTime(row.createdAt)
})

const updateSet = (input: {
  readonly existing: typeof dbSchema.userKnowledgeDocument.$inferSelect
  readonly update: UpdateKnowledgeDocumentInput
}) => ({
  slug: input.update.slug ?? input.existing.slug,
  title: input.update.title ?? input.existing.title,
  purpose: input.update.purpose ?? input.existing.purpose,
  origin: input.update.origin ?? input.existing.origin,
  content: input.update.content ?? input.existing.content,
  status: input.update.status ?? input.existing.status,
  availability: input.update.availability ?? input.existing.availability,
  summary: input.update.summary ?? input.existing.summary,
  errorMessage: input.update.errorMessage ?? input.existing.errorMessage,
  reviewedAt: input.update.reviewedAt === undefined
    ? input.existing.reviewedAt
    : DateTime.toDateUtc(input.update.reviewedAt),
  metadata: input.update.metadata ?? input.existing.metadata,
  updatedAt: sql`CURRENT_TIMESTAMP`
})

export const DrizzleKnowledgeStoreLayer = Layer.effect(
  KnowledgeStore,
  Effect.gen(function* () {
    const db = yield* Db
    const getScopedDocument = (input: { readonly scope: KnowledgeScope; readonly id: string }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(dbSchema.userKnowledgeDocument)
          .where(
            and(
              eq(dbSchema.userKnowledgeDocument.id, input.id),
              eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope))
            )
          )

        if (row === undefined) {
          return yield* Effect.fail(storeError('Knowledge document not found'))
        }

        return row
      })

    return {
      createDocument: input =>
        Effect.gen(function* () {
          const [created] = yield* db
            .insert(dbSchema.userKnowledgeDocument)
            .values({
              userId: scopeUserId(input.scope),
              slug: input.slug,
              title: input.title,
              purpose: input.purpose,
              origin: input.origin,
              content: input.content,
              status: 'ready',
              availability: input.availability,
              summary: input.summary,
              metadata: input.metadata ?? {}
            })
            .returning()

          if (created === undefined) {
            return yield* Effect.fail(storeError('Could not create knowledge document'))
          }

          return rowToDocument({ document: created })
        }).pipe(Effect.withSpan('KnowledgeStore.createDocument'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      updateDocument: input =>
        Effect.gen(function* () {
          const existing = yield* getScopedDocument({ scope: input.scope, id: input.id })
          const [updated] = yield* db
            .update(dbSchema.userKnowledgeDocument)
            .set(updateSet({ existing, update: input }))
            .where(
              and(
                eq(dbSchema.userKnowledgeDocument.id, input.id),
                eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope))
              )
            )
            .returning()

          if (updated === undefined) {
            return yield* Effect.fail(storeError('Could not update knowledge document'))
          }

          return rowToDocument({ document: updated })
        }).pipe(Effect.withSpan('KnowledgeStore.updateDocument'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      getDocument: input =>
        getScopedDocument(input).pipe(
          Effect.map(document => rowToDocument({ document })),
          Effect.withSpan('KnowledgeStore.getDocument'),
          Effect.catch(error => Effect.fail(mapStoreError(error)))
        ),

      getDocumentBySlug: input =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select()
            .from(dbSchema.userKnowledgeDocument)
            .where(
              and(
                eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope)),
                eq(dbSchema.userKnowledgeDocument.slug, input.slug)
              )
            )

          if (row === undefined) {
            return yield* Effect.fail(storeError('Knowledge document not found'))
          }

          return rowToDocument({ document: row })
        }).pipe(Effect.withSpan('KnowledgeStore.getDocumentBySlug'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listDocuments: input =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(dbSchema.userKnowledgeDocument)
            .where(
              and(
                eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope)),
                input.availability === undefined
                  ? undefined
                  : eq(dbSchema.userKnowledgeDocument.availability, input.availability)
              )
            )
            .orderBy(desc(dbSchema.userKnowledgeDocument.createdAt))
            .limit(input.limit)

          return { documents: rows.map(document => rowToDocument({ document })) }
        }).pipe(Effect.withSpan('KnowledgeStore.listDocuments'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listPinned: input =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(dbSchema.userKnowledgeDocument)
            .where(
              and(
                eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope)),
                eq(dbSchema.userKnowledgeDocument.availability, 'pinned')
              )
            )
            .orderBy(desc(dbSchema.userKnowledgeDocument.updatedAt))
            .limit(input.limit)

          return { documents: rows.map(document => rowToDocument({ document })) }
        }).pipe(Effect.withSpan('KnowledgeStore.listPinned'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      deleteDocument: input =>
        Effect.gen(function* () {
          yield* db
            .delete(dbSchema.userKnowledgeDocument)
            .where(
              and(
                eq(dbSchema.userKnowledgeDocument.id, input.id),
                eq(dbSchema.userKnowledgeDocument.userId, scopeUserId(input.scope))
              )
            )
        }).pipe(Effect.withSpan('KnowledgeStore.deleteDocument'), Effect.catch(error => Effect.fail(mapStoreError(error)))),

      listFiles: input =>
        Effect.gen(function* () {
          yield* getScopedDocument(input)
          const rows = yield* db
            .select()
            .from(dbSchema.userKnowledgeFile)
            .where(eq(dbSchema.userKnowledgeFile.documentId, input.id))

          return rows.map(rowToFile)
        }).pipe(Effect.withSpan('KnowledgeStore.listFiles'), Effect.catch(error => Effect.fail(mapStoreError(error))))
    }
  })
)

export const R2KnowledgeFileBlobStoreLayer = Layer.effect(
  KnowledgeFileBlobStore,
  Effect.gen(function* () {
    const config = yield* R2KnowledgeFileStoreConfig
    const client = yield* S3Service

    return {
      putFile: input =>
        client.putObject({
          Bucket: config.bucketName,
          Key: input.storageKey,
          Body: input.bytes,
          ContentType: input.mediaType
        }).pipe(
          Effect.asVoid,
          Effect.withSpan('KnowledgeFileBlobStore.putFile'),
          Effect.catch(error => Effect.fail(fileIntegrationError('Could not upload knowledge file', error)))
        ),

      getFile: input =>
        Effect.gen(function* () {
          const response = yield* client.getObject({ Bucket: config.bucketName, Key: input.storageKey })
          const body = response.Body
          if (body === undefined) {
            return yield* Effect.fail(fileError('R2 object body missing'))
          }

          return yield* Effect.tryPromise({
            try: () => body.transformToByteArray(),
            catch: error => fileIntegrationError('Could not read knowledge file body', error)
          })
        }).pipe(
          Effect.withSpan('KnowledgeFileBlobStore.getFile'),
          Effect.catch(error => Effect.fail(fileIntegrationError('Could not download knowledge file', error)))
        ),

      deleteFile: input =>
        client.deleteObject({ Bucket: config.bucketName, Key: input.storageKey }).pipe(
          Effect.asVoid,
          Effect.withSpan('KnowledgeFileBlobStore.deleteFile'),
          Effect.catch(error => Effect.fail(fileIntegrationError('Could not delete knowledge file', error)))
        )
    }
  })
).pipe(Layer.provide(R2S3ClientLayer), Layer.provide(R2KnowledgeFileStoreConfigLayer))

export const R2KnowledgeUploadStoreLayer = Layer.effect(
  R2KnowledgeUploadStore,
  Effect.gen(function* () {
    const config = yield* R2KnowledgeFileStoreConfig
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
          Effect.catch(error => Effect.fail(fileIntegrationError('Could not create knowledge upload URL', error)))
        )
    }
  })
).pipe(Layer.provide(R2S3ClientLayer), Layer.provide(R2KnowledgeFileStoreConfigLayer))

export const KnowledgeLayer = DrizzleKnowledgeStoreLayer.pipe(Layer.provide(Db.layer))
