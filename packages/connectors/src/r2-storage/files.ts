import { Context, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorIntegration } from '../integration.ts'
import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  ByteLimit,
  SafeText,
  isBytes,
  decodeInput,
  failTransfer,
  fileBytes,
  validateTransfer,
  validateUpload
} from '../transfer-internal.ts'

export type R2ObjectCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'etag'; readonly etag: string }
export interface R2ObjectTarget {
  readonly integration: ConnectorIntegration
  readonly bucket: string
  readonly key: string
}
export interface R2ObjectMetadata {
  readonly etag: string
  readonly size: number
}
export interface R2ObjectClientApi {
  /** Host owns binding/signing/credentials. Enforce actual streamed bytes, cancellation and no logging. Missing objects fail not_found; failed conditions fail conflict, NOT empty success. */
  readonly get: (
    request: R2ObjectTarget & { readonly expectedEtag?: string; readonly maxBytes: number }
  ) => Effect.Effect<R2ObjectMetadata & { readonly bytes: Uint8Array }, ConnectorFileTransferError>
  /** MUST atomically enforce absent (If-None-Match:*) or concrete If-Match at PUT. Never HEAD-then-PUT, unconditional fallback, multipart or automatic retry. */
  readonly put: (
    request: R2ObjectTarget & {
      readonly condition: R2ObjectCondition
      readonly bytes: Uint8Array
      readonly maxUploadBytes: number
    }
  ) => Effect.Effect<R2ObjectMetadata, ConnectorFileTransferError>
}
export class R2ObjectClient extends Context.Service<R2ObjectClient, R2ObjectClientApi>()(
  '@yolk-sdk/connectors/R2ObjectClient'
) {}
/** Conservative memory-bound single PUT cap; no multipart conditional-commit claim. */
export const r2SingleUploadMaxBytes = 100_000_000
export interface R2GetObjectInput {
  readonly bucket: string
  readonly key: string
  readonly expectedEtag?: string
}
export interface R2CreateObjectInput {
  readonly bucket: string
  readonly key: string
  readonly bytes: Uint8Array
}
export interface R2UpdateObjectInput extends R2CreateObjectInput {
  readonly expectedEtag: string
}
// ETags are opaque: preserve quotes for HTTP adapters; binding adapters translate representation.
const Etag = SafeText.check(
  Schema.makeFilter(
    s =>
      !s.includes('*') &&
      !s.includes(',') &&
      !s.startsWith('W/') &&
      /^(?:[\x21\x23-\x7e]+|"[\x21\x23-\x7e]+")$/.test(s)
  )
)
const Target = {
  bucket: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)),
  key: SafeText.check(
    Schema.makeFilter(
      s =>
        s.length <= 1024 &&
        new TextEncoder().encode(s).length <= 1024 &&
        !s.includes('\\') &&
        s.split('/').every(p => p !== '.' && p !== '..')
    )
  )
}
const Metadata = Schema.Struct({ etag: Etag, size: ByteLimit })
const hostError = (e: ConnectorFileTransferError) =>
  new ConnectorFileTransferError({ code: e.code })
export const getR2Object = (
  integration: ConnectorIntegration,
  input: R2GetObjectInput,
  budget: ConnectorFileTransferBudget
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'r2-storage', budget)
    const target = yield* decodeInput(
      Schema.Struct({ ...Target, expectedEtag: Schema.optional(Etag) }),
      input
    )
    const host = yield* R2ObjectClient
    const result = yield* host
      .get({ integration, ...target, maxBytes: limits.maxBytes })
      .pipe(Effect.mapError(hostError))
    const metadata = yield* Schema.decodeUnknownEffect(Metadata)(result).pipe(
      Effect.catch(() => failTransfer('invalid_metadata'))
    )
    if (!isBytes(result.bytes) || result.bytes.byteLength > limits.maxBytes)
      return yield* failTransfer('response_too_large')
    if (
      result.bytes.byteLength !== metadata.size ||
      (target.expectedEtag !== undefined && target.expectedEtag !== metadata.etag)
    )
      return yield* failTransfer('invalid_metadata')
    return { ...fileBytes(result.bytes), ...metadata }
  })
const put = (
  integration: ConnectorIntegration,
  input: R2CreateObjectInput | R2UpdateObjectInput,
  budget: ConnectorFileTransferBudget,
  updating: boolean
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'r2-storage', budget)
    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)
    yield* validateUpload(input.bytes, limits, r2SingleUploadMaxBytes)
    const target = updating
      ? yield* decodeInput(Schema.Struct({ ...Target, expectedEtag: Etag }), input)
      : yield* decodeInput(Schema.Struct(Target), input)
    const condition: R2ObjectCondition =
      'expectedEtag' in target && typeof target.expectedEtag === 'string'
        ? { kind: 'etag', etag: target.expectedEtag }
        : { kind: 'absent' }
    const host = yield* R2ObjectClient
    const result = yield* host
      .put({
        integration,
        bucket: target.bucket,
        key: target.key,
        bytes: input.bytes,
        condition,
        maxUploadBytes: Math.min(limits.maxBytes, r2SingleUploadMaxBytes)
      })
      .pipe(Effect.mapError(hostError))
    const metadata = yield* Schema.decodeUnknownEffect(Metadata)(result).pipe(
      Effect.catch(() => failTransfer('invalid_metadata'))
    )
    if (metadata.size !== input.bytes.byteLength) return yield* failTransfer('invalid_metadata')
    return metadata
  })
export const createR2Object = (
  integration: ConnectorIntegration,
  input: R2CreateObjectInput,
  budget: ConnectorFileTransferBudget
) => put(integration, input, budget, false)
export const updateR2Object = (
  integration: ConnectorIntegration,
  input: R2UpdateObjectInput,
  budget: ConnectorFileTransferBudget
) => put(integration, input, budget, true)
