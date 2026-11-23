// Internal host-only Fortnox byte transfer core shared by the archive, preview, and inbox helpers.
// Not re-exported from the `@yolk-sdk/connectors/fortnox` barrel.
import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { CredentialSlot } from '../credential.ts'
import { resolveCredential } from '../credential.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  OpaqueId,
  SafeText,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  isBytes,
  readBytes,
  safeToken,
  validateTransfer,
  validateUpload,
  writeBytes
} from '../transfer-internal.ts'
import { fortnoxApiBaseUrl } from './shared.ts'

/** Resolve a Fortnox OAuth access token for a byte transfer, failing with transfer codes only. */
export const resolveFortnoxTransferToken = (
  integration: ConnectorIntegration,
  slot: CredentialSlot
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot).pipe(
      Effect.mapError(credentialFailure)
    )

    if (!Predicate.isTagged(credential, 'OAuthCredential') || credential.provider !== 'fortnox')
      return yield* failTransfer('credential_failed')

    return yield* safeToken(credential.accessToken)
  })

const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d

/**
 * One authenticated GET of `path` (already URL-encoded, relative to `fortnoxApiBaseUrl`) through
 * the binary port. `kind: 'pdf'` accepts any content type and verifies the PDF magic bytes instead,
 * since Fortnox may serve generated PDFs as `application/octet-stream` or with a charset suffix.
 */
export const downloadFortnoxBytes = (
  integration: ConnectorIntegration,
  slot: CredentialSlot,
  path: string,
  budget: ConnectorFileTransferBudget,
  kind: 'pdf' | 'binary'
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'fortnox', budget)
    const token = yield* resolveFortnoxTransferToken(integration, slot)

    const response = yield* readBytes(
      `${fortnoxApiBaseUrl}/${path}`,
      kind === 'pdf'
        ? { authorization: `Bearer ${token}` }
        : { authorization: `Bearer ${token}`, accept: 'application/octet-stream' },
      limits
    )

    if (kind === 'pdf' && !isPdf(response.bytes)) return yield* failTransfer('invalid_metadata')

    return response
  })

// The name is sent as raw UTF-8 inside a quoted Content-Disposition parameter (as the official
// Fortnox SDK does), so quotes, backslashes and path separators are rejected, not escaped.
const UploadFields = {
  fileName: SafeText.check(
    Schema.isMaxLength(255),
    Schema.makeFilter(name => !/["\\/]/.test(name) && !/^\.+$/.test(name) && name.trim() === name)
  ),
  contentType: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(255),
      Schema.isPattern(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
    )
  )
}

const FolderUploadTarget = Schema.Struct({ folderId: OpaqueId, ...UploadFields })

const OptionalFolderUploadTarget = Schema.Struct({
  folderId: Schema.optional(OpaqueId),
  ...UploadFields
})

const encoder = new TextEncoder()

const boundarySuffixLength = 8

// Collect every 8-character suffix following the boundary prefix in `data`. A boundary built from
// the prefix and an unseen suffix therefore cannot occur anywhere in `data`.
const collectSuffixes = (boundaryPrefix: Uint8Array, data: Uint8Array, seen: Set<string>) => {
  const first = boundaryPrefix[0] ?? 0
  const last = data.length - boundaryPrefix.length - boundarySuffixLength

  for (let i = data.indexOf(first); i !== -1 && i <= last; i = data.indexOf(first, i + 1)) {
    if (boundaryPrefix.every((byte, offset) => data[i + offset] === byte)) {
      const start = i + boundaryPrefix.length

      seen.add(String.fromCharCode(...data.subarray(start, start + boundarySuffixLength)))
    }
  }
}

/**
 * Deterministic multipart boundary absent from every given byte sequence: the first counter
 * value whose 8-hex-digit suffix was not seen. At most `length / prefix length` suffixes can be
 * seen, so a free one always exists below the 2^32 hex range for any upload under the cap.
 */
const multipartBoundary = (prefix: string, parts: ReadonlyArray<Uint8Array>) => {
  const boundaryPrefix = encoder.encode(prefix)
  const seen = new Set<string>()

  for (const part of parts) collectSuffixes(boundaryPrefix, part, seen)

  for (let n = 0; n <= 0xffffffff; n++) {
    const suffix = n.toString(16).padStart(boundarySuffixLength, '0')

    if (!seen.has(suffix)) return Effect.succeed(`${prefix}${suffix}`)
  }

  return failTransfer('invalid_input')
}

const multipartBody = (
  boundary: string,
  fileName: Uint8Array,
  contentType: string,
  bytes: Uint8Array
) => {
  const head = [
    encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),
    fileName,
    encoder.encode(`"\r\nContent-Type: ${contentType}\r\n\r\n`)
  ]

  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const chunks = [...head, bytes, tail]
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}

type UploadedFile = { readonly File: { readonly Size?: number | null | undefined } }

export interface FortnoxMultipartUpload<A extends UploadedFile> {
  /** Upload endpoint relative to `fortnoxApiBaseUrl` (`inbox` or `archive`). */
  readonly path: string
  /** Whether the caller must name a folder; without one Fortnox stores the file in the root. */
  readonly folderRequired: boolean
  readonly boundaryPrefix: string
  readonly maxBytes: number
  /** Decodes the `{ File }` answer; its `Size`, when present, must equal the uploaded bytes. */
  readonly response: Schema.Schema<A> & { readonly DecodingServices: never }
}

/**
 * One never-retried multipart/form-data POST (form field `file`, `folderid` query when a folder is
 * given) of the caller's `{ folderId, fileName, contentType?, bytes }` through the binary write
 * port, returning the decoded `{ File }` answer. A transport failure or an undecodable answer may
 * still mean the file was stored.
 */
export const uploadFortnoxMultipart = <A extends UploadedFile>(
  integration: ConnectorIntegration,
  slot: CredentialSlot,
  budget: ConnectorFileTransferBudget,
  input: unknown,
  upload: FortnoxMultipartUpload<A>
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'fortnox', budget)
    const record = yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)
    const bytes = record['bytes']

    if (!isBytes(bytes)) return yield* failTransfer('invalid_input')

    yield* validateUpload(bytes, limits, upload.maxBytes)

    const target = upload.folderRequired
      ? yield* decodeInput(FolderUploadTarget, record)
      : yield* decodeInput(OptionalFolderUploadTarget, record)

    const fileName = encoder.encode(target.fileName)
    const boundary = yield* multipartBoundary(upload.boundaryPrefix, [bytes, fileName])

    const body = multipartBody(
      boundary,
      fileName,
      target.contentType ?? 'application/octet-stream',
      bytes
    )

    const token = yield* resolveFortnoxTransferToken(integration, slot)

    const query =
      target.folderId === undefined ? '' : `?folderid=${encodeURIComponent(target.folderId)}`

    const response = yield* writeBytes({
      method: 'POST',
      url: `${fortnoxApiBaseUrl}/${upload.path}${query}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      bytes: body,
      // The file bytes are already within budget and cap; this is the exact multipart body size.
      maxUploadBytes: body.byteLength,
      maxBytes: limits.maxMetadataBytes,
      maxErrorBodyBytes: limits.maxErrorBodyBytes,
      successStatuses: [200, 201],
      redirect: 'manual',
      credentials: 'omit'
    })

    const metadata = yield* decodeMetadata(upload.response, response.bytes)
    const size = metadata.File.Size

    if (size !== undefined && size !== null && size !== bytes.byteLength)
      return yield* failTransfer('invalid_metadata')

    return metadata
  })
