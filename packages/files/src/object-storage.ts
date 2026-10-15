import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { FileDescriptor } from '@yolk-sdk/agent/protocol'
import { FileStoreError, type FileStoreApi } from '@yolk-sdk/agent/tools'

/** Object storage failures: `not_found` (no such key), `too_large`, or `unavailable`. */
export class ObjectStorageError extends Schema.TaggedError<ObjectStorageError>()(
  'ObjectStorageError',
  {
    reason: Schema.Literals(['not_found', 'too_large', 'unavailable']),
    message: Schema.String
  }
) {}

/** What `head` reports about one object. Metadata keys are lower case. */
export type ObjectStorageHead = {
  readonly size: number
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Private object storage the host implements (for example R2 or S3 over its own client). Keys are
 * built by the package from the host scope; the model never supplies them. Metadata values are
 * ASCII (the package URI-encodes names). `signGet` returns a read link that downloads as
 * `filename`.
 */
export type ObjectStorageApi = {
  readonly put: (input: {
    readonly key: string
    readonly bytes: Uint8Array
    readonly contentType: string
    readonly metadata: Readonly<Record<string, string>>
  }) => Effect.Effect<void, ObjectStorageError>
  readonly head: (
    key: string
  ) => Effect.Effect<Option.Option<ObjectStorageHead>, ObjectStorageError>
  readonly get: (input: {
    readonly key: string
    readonly maxBytes: number
  }) => Effect.Effect<Uint8Array, ObjectStorageError>
  readonly signGet: (input: {
    readonly key: string
    readonly ttlSeconds: number
    readonly filename: string
    readonly contentType: string
  }) => Effect.Effect<string, ObjectStorageError>
  readonly deletePrefix: (prefix: string) => Effect.Effect<void, ObjectStorageError>
}

export type ObjectStorageFileStoreOptions = {
  readonly storage: ObjectStorageApi
  /** Host-derived owner of the files, for example `<workspaceId>/<sessionId>`. */
  readonly scope: string
  /** Key prefix. Default `files`. */
  readonly prefix?: string
}

const scopeSegment = /^[A-Za-z0-9._-]+$/u

const fileIdLength = 26

const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'

const base32 = (bytes: Uint8Array) => {
  let output = ''
  let buffer = 0
  let bits = 0

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8

    while (bits >= 5) {
      output += base32Alphabet[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }

    buffer &= (1 << bits) - 1
  }

  return bits > 0 ? output + base32Alphabet[(buffer << (5 - bits)) & 31] : output
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const sha256 = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    catch: () => new FileStoreError({ reason: 'unavailable', message: 'Could not hash the file' })
  }).pipe(Effect.map(digest => new Uint8Array(digest)))

/** Whether `scope` is safe to use as key segments: `/`-separated, no empty, `.` or `..` part. */
export const isValidFileScope = (scope: string) =>
  scope
    .split('/')
    .every(segment => scopeSegment.test(segment) && segment !== '.' && segment !== '..')

/** The `fileId` of `sha256Hex` content in `scope`: equal bytes in one scope share one id. */
export const fileIdFor = (input: { readonly scope: string; readonly sha256Hex: string }) =>
  sha256(new TextEncoder().encode(`${input.scope}\n${input.sha256Hex}`)).pipe(
    Effect.map(digest => `file_${base32(digest).slice(0, fileIdLength)}`)
  )

const toFileStoreError = (error: ObjectStorageError) =>
  new FileStoreError({ reason: error.reason, message: error.message })

const decodeName = (value: string | undefined) => {
  if (value === undefined) return 'file'

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * A `FileStoreApi` over host object storage (ADR 0009): key `<prefix>/<scope>/<fileId>`, name and
 * sha256 in object metadata, no database. `put` is idempotent: the same bytes in the same scope
 * resolve to the existing object. A `fileId` from another scope never resolves, because keys are
 * always built from this store's scope. Fails with a defect for an invalid scope.
 */
export const makeObjectStorageFileStore = (
  options: ObjectStorageFileStoreOptions
): FileStoreApi => {
  if (!isValidFileScope(options.scope)) {
    throw new Error(`Invalid file scope: ${JSON.stringify(options.scope)}`)
  }

  const prefix = options.prefix ?? 'files'
  const keyOf = (fileId: string) => `${prefix}/${options.scope}/${fileId}`
  const storage = options.storage

  const head = (fileId: string) =>
    storage.head(keyOf(fileId)).pipe(
      Effect.mapError(toFileStoreError),
      Effect.map(
        Option.map(object =>
          FileDescriptor.make({
            fileId,
            name: decodeName(object.metadata['name']),
            mimeType: object.contentType,
            size: object.size
          })
        )
      )
    )

  const existing = (fileId: string) =>
    head(fileId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new FileStoreError({ reason: 'not_found', message: `No file ${fileId}` })),
          onSome: Effect.succeed
        })
      )
    )

  return {
    put: ({ bytes, name, mimeType }) =>
      Effect.gen(function* () {
        const digest = hex(yield* sha256(bytes))
        const fileId = yield* fileIdFor({ scope: options.scope, sha256Hex: digest })
        const stored = yield* head(fileId)

        if (Option.isNone(stored)) {
          yield* storage
            .put({
              key: keyOf(fileId),
              bytes,
              contentType: mimeType,
              metadata: { name: encodeURIComponent(name), sha256: digest }
            })
            .pipe(Effect.mapError(toFileStoreError))
        }

        return FileDescriptor.make({ fileId, name, mimeType, size: bytes.byteLength })
      }),
    head,
    read: ({ fileId, maxBytes }) =>
      existing(fileId).pipe(
        Effect.flatMap(file =>
          file.size > maxBytes
            ? Effect.fail(
                new FileStoreError({
                  reason: 'too_large',
                  message: `File ${fileId} is larger than ${maxBytes} bytes`
                })
              )
            : storage.get({ key: keyOf(fileId), maxBytes }).pipe(Effect.mapError(toFileStoreError))
        )
      ),
    signRead: ({ fileId, ttlSeconds }) =>
      existing(fileId).pipe(
        Effect.flatMap(file =>
          storage
            .signGet({
              key: keyOf(fileId),
              ttlSeconds,
              filename: file.name,
              contentType: file.mimeType
            })
            .pipe(Effect.mapError(toFileStoreError))
        )
      )
  }
}

/** Delete every file of `scope` (for example when its session is deleted). */
export const deleteScopeFiles = (input: {
  readonly storage: ObjectStorageApi
  readonly scope: string
  readonly prefix?: string
}) =>
  isValidFileScope(input.scope)
    ? input.storage.deletePrefix(`${input.prefix ?? 'files'}/${input.scope}/`)
    : Effect.die(new Error(`Invalid file scope: ${JSON.stringify(input.scope)}`))
