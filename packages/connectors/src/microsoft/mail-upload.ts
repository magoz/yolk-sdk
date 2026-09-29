import { Effect, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorBinaryHttpError, ConnectorBinaryHttpResponse } from '../binary-http.ts'
import { ConnectorBinaryWriteHttpClient } from '../binary-write-http.ts'
import type { ConnectorBinaryUploadSessionRequest } from '../binary-write-http.ts'
import type { CredentialResolver } from '../credential.ts'
import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import { ConnectorHttpClient, ConnectorHttpRequest } from '../http.ts'
import type { ConnectorHttpClientApi } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  SafeText,
  checkResponse,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  headerSafeJson,
  isBytes,
  safeHttpsUrl,
  safeToken,
  singleHeader,
  validateTransfer
} from '../transfer-internal.ts'
import { GraphId } from './mail-download.ts'
import { outlookWriteSlot } from './mail.ts'
import { microsoftGraphApiBaseUrl, resolveMicrosoftAccessToken } from './shared.ts'

/** Files strictly smaller than this use one Graph POST; larger files need an upload session. */
export const outlookAttachmentSingleRequestMaxBytes = 3 * 1024 * 1024

/** Largest file accepted through an Outlook attachment upload session. */
export const outlookAttachmentUploadSessionMaxBytes = 150 * 1024 * 1024

/** Upload-session range size: 12 x 320 KiB, below Graph's 4 MiB per-request guidance. */
export const outlookAttachmentUploadChunkBytes = 12 * 320 * 1024

export interface OutlookAddAttachmentInput {
  /** Existing draft message ID. Adding the file never sends the draft. */
  readonly messageId: string
  readonly name: string
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly mailbox?: string
}

export interface OutlookAddAttachmentResult {
  /** Graph attachment ID when the provider reported one; the file was attached either way. */
  readonly attachmentId?: string
  readonly name: string
  /** Uploaded file bytes, not Graph's metadata-inclusive attachment size. */
  readonly size: number
}

const ContentType = SafeText.check(
  Schema.isPattern(/^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:\s*;[\x20-\x7e]*)?$/)
)

const Input = Schema.Struct({
  messageId: GraphId,
  name: SafeText,
  contentType: ContentType,
  mailbox: Schema.optional(GraphId)
})

const CreatedAttachment = Schema.Struct({ id: GraphId })

// Decode the capability URL alone first, so cancellation covers every later metadata failure.
const UploadSessionUrl = Schema.Struct({ uploadUrl: Schema.String })

const UploadSessionRanges = Schema.Struct({
  nextExpectedRanges: Schema.optional(Schema.Array(Schema.String))
})

// Outlook's session endpoint has used both property casings in documented responses.
const UploadProgress = Schema.Struct({
  nextExpectedRanges: Schema.optional(Schema.Array(Schema.String)),
  NextExpectedRanges: Schema.optional(Schema.Array(Schema.String))
})

// Graph has documented v1.0, v2.0, gv1.0 and beta session paths on outlook.office.com.
const uploadSessionPath =
  /^\/api\/(?:v1\.0|v2\.0|gv1\.0|beta)\/[^?#]+\/AttachmentSessions\('[^'/?#]+'\)$/i

const encoder = new TextEncoder()

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return btoa(binary)
}

// Pre-authenticated capability URL: validate before first use, never echo it anywhere.
const outlookUploadSessionUrl = (raw: string) =>
  safeHttpsUrl(raw).pipe(
    Effect.flatMap(url =>
      url.hostname === 'outlook.office.com' &&
      url.port === '' &&
      uploadSessionPath.test(url.pathname)
        ? Effect.succeed(raw)
        : failTransfer('network_policy_rejected')
    ),
    Effect.mapError(() => new ConnectorFileTransferError({ code: 'network_policy_rejected' }))
  )

/** Exactly one remaining range that starts at `start` and runs to the end of the file. */
const expectsRangeFrom = (
  ranges: ReadonlyArray<string> | undefined,
  start: number,
  total: number
) => {
  if (ranges?.length !== 1) return false
  const match = /^(\d+)-?(\d*)$/.exec(ranges[0] ?? '')

  return (
    match !== null &&
    Number(match[1]) === start &&
    (match[2] === '' || Number(match[2]) === total - 1)
  )
}

const attachmentIdFromLocation = (location: string | undefined) => {
  const encoded =
    location === undefined
      ? undefined
      : /\/Attachments\('([^'/?#]+)'\)(?:\?[^#]*)?$/i.exec(location)?.[1]

  if (encoded === undefined) return undefined
  const decoded = Result.try(() => decodeURIComponent(encoded))

  return Result.isSuccess(decoded) && Schema.is(GraphId)(decoded.success)
    ? decoded.success
    : undefined
}

const result = (
  name: string,
  size: number,
  attachmentId: string | undefined
): OutlookAddAttachmentResult =>
  attachmentId === undefined ? { name, size } : { attachmentId, name, size }

const portFailure = (error: ConnectorBinaryHttpError) =>
  new ConnectorFileTransferError({ code: error.code })

/**
 * One authenticated Graph JSON POST through the regular string `ConnectorHttpClient`. The body is
 * ASCII-only JSON (non-ASCII escaped), so its string length equals its byte length on any host.
 * Responses get the same bounds, status mapping and code-only errors as the binary write port;
 * transport failures never expose their cause.
 */
const graphJsonPost = (input: {
  readonly http: ConnectorHttpClientApi
  readonly url: string
  readonly token: string
  readonly body: string
  readonly maxBytes: number
  readonly maxErrorBodyBytes: number
}) =>
  input.http
    .request(
      ConnectorHttpRequest.make({
        method: 'POST',
        url: input.url,
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: 'IdType="ImmutableId"'
        },
        body: input.body,
        redirect: 'manual',
        credentials: 'omit'
      })
    )
    .pipe(
      Effect.mapError(() => new ConnectorFileTransferError({ code: 'transport_failed' })),
      Effect.flatMap(response => {
        const body: unknown = response.body

        // UTF-8 is never shorter than UTF-16 code units: reject oversized bodies before encoding.
        if (
          !Predicate.isString(body) ||
          body.length > Math.max(input.maxBytes, input.maxErrorBodyBytes)
        )
          return failTransfer('response_too_large')

        return checkResponse(
          {
            status: response.status,
            headers: response.headers,
            bytes: encoder.encode(body),
            bodyComplete: true
          },
          input.maxBytes,
          input.maxErrorBodyBytes,
          true
        )
      })
    )

type UploadSessionPort = (
  request: ConnectorBinaryUploadSessionRequest
) => Effect.Effect<ConnectorBinaryHttpResponse, ConnectorBinaryHttpError>

const uploadRanges = (input: {
  readonly session: UploadSessionPort
  readonly url: string
  readonly bytes: Uint8Array
  readonly created: Uint8Array
  readonly budget: ConnectorFileTransferBudget
}) =>
  Effect.gen(function* () {
    const total = input.bytes.byteLength
    const initial = yield* decodeMetadata(UploadSessionRanges, input.created)

    if (
      initial.nextExpectedRanges !== undefined &&
      !expectsRangeFrom(initial.nextExpectedRanges, 0, total)
    )
      return yield* failTransfer('invalid_metadata')

    let start = 0

    // Sequential ranges only; every response must confirm the next expected offset.
    while (start < total) {
      const end = Math.min(start + outlookAttachmentUploadChunkBytes, total)
      const chunk = input.bytes.subarray(start, end)

      const response = yield* input
        .session({
          method: 'PUT',
          url: input.url,
          headers: {
            'content-range': `bytes ${start}-${end - 1}/${total}`,
            'content-type': 'application/octet-stream'
          },
          bytes: chunk,
          maxUploadBytes: chunk.byteLength,
          successStatuses: [200, 201],
          maxBytes: input.budget.maxMetadataBytes,
          maxErrorBodyBytes: input.budget.maxErrorBodyBytes,
          redirect: 'manual',
          credentials: 'omit'
        })
        .pipe(Effect.mapError(portFailure))

      const checked = yield* checkResponse(
        response,
        input.budget.maxMetadataBytes,
        input.budget.maxErrorBodyBytes,
        true
      )

      if (end === total) {
        if (checked.status !== 201) return yield* failTransfer('invalid_metadata', checked.status)

        return attachmentIdFromLocation(singleHeader(checked.headers, 'location'))
      }

      if (checked.status !== 200) return yield* failTransfer('invalid_metadata', checked.status)
      const progress = yield* decodeMetadata(UploadProgress, checked.bytes)

      if (!expectsRangeFrom(progress.nextExpectedRanges ?? progress.NextExpectedRanges, end, total))
        return yield* failTransfer('invalid_metadata')

      start = end
    }

    return yield* failTransfer('invalid_metadata')
  })

/**
 * Host-only: attach one file to an existing Outlook draft. Files under 3 MiB use one Graph JSON
 * POST through `ConnectorHttpClient`. 3 MiB-150 MiB files POST `createUploadSession` through the
 * same port, then send byte ranges through `ConnectorBinaryWriteHttpClient.uploadSession`; only
 * that path needs the binary write port, which stays optional in the environment.
 * Never sends the draft and never retries. Every failure leaves the draft unsent; a failure after
 * a request was dispatched may still have attached the file, so reconcile before trying again.
 */
export const addOutlookAttachment = (
  integration: ConnectorIntegration,
  input: OutlookAddAttachmentInput,
  budget: ConnectorFileTransferBudget
): Effect.Effect<
  OutlookAddAttachmentResult,
  ConnectorFileTransferError,
  CredentialResolver | ConnectorHttpClient
> =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'microsoft', budget)
    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)

    if (!isBytes(input.bytes)) return yield* failTransfer('invalid_input')
    const target = yield* decodeInput(Input, input)
    const bytes = input.bytes
    const size = bytes.byteLength

    if (size > outlookAttachmentUploadSessionMaxBytes || size > limits.maxBytes)
      return yield* failTransfer('response_too_large')

    const needsSession = size >= outlookAttachmentSingleRequestMaxBytes

    // Only upload sessions need the binary write port; small files work without one.
    const binary = needsSession
      ? Option.getOrUndefined(yield* Effect.serviceOption(ConnectorBinaryWriteHttpClient))
      : undefined

    const uploadSessionMethod = binary?.uploadSession

    // Call as a method so class-based host ports keep their receiver.
    const session: UploadSessionPort | undefined =
      binary === undefined || uploadSessionMethod === undefined
        ? undefined
        : request => uploadSessionMethod.call(binary, request)

    // Hosts without the session capability fail definitively before credentials or network.
    if (needsSession && session === undefined) return yield* failTransfer('upload_session_required')

    const slot = yield* outlookWriteSlot(integration, target.mailbox).pipe(
      Effect.catch(error =>
        error.cause === 'validation_failed' && error.slotId === undefined
          ? failTransfer('invalid_input')
          : Effect.fail(credentialFailure())
      )
    )

    const token = yield* resolveMicrosoftAccessToken(integration, slot).pipe(
      Effect.mapError(credentialFailure),
      Effect.flatMap(safeToken)
    )

    const mailbox =
      target.mailbox === undefined ? '/me' : `/users/${encodeURIComponent(target.mailbox)}`

    const attachments = `${microsoftGraphApiBaseUrl}${mailbox}/messages/${encodeURIComponent(target.messageId)}/attachments`

    const http = yield* ConnectorHttpClient

    const graphRequest = (url: string, body: Schema.Json, maxBytes: number) =>
      graphJsonPost({
        http,
        url,
        token,
        body: headerSafeJson(body),
        maxBytes,
        maxErrorBodyBytes: limits.maxErrorBodyBytes
      })

    if (session === undefined) {
      const contentBytes = toBase64(bytes)

      const body = {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: target.name,
        contentType: target.contentType,
        contentBytes
      }

      // Graph echoes contentBytes in the created attachment: allow exactly that expansion.
      const response = yield* graphRequest(
        attachments,
        body,
        limits.maxMetadataBytes + contentBytes.length
      )

      // Success status means attached; a missing or malformed ID must not invite a re-upload.
      const created = yield* decodeMetadata(CreatedAttachment, response.bytes).pipe(Effect.result)

      return result(target.name, size, Result.isSuccess(created) ? created.success.id : undefined)
    }

    const created = yield* graphRequest(
      `${attachments}/createUploadSession`,
      {
        AttachmentItem: {
          attachmentType: 'file',
          name: target.name,
          size,
          contentType: target.contentType
        }
      },
      limits.maxMetadataBytes
    )

    const { uploadUrl } = yield* decodeMetadata(UploadSessionUrl, created.bytes)
    const url = yield* outlookUploadSessionUrl(uploadUrl)

    // Best-effort, time-bounded cancellation: lazily built; its outcome never masks the failure.
    const cancel = Effect.suspend(() =>
      session({
        method: 'DELETE',
        url,
        headers: {},
        bytes: new Uint8Array(0),
        maxUploadBytes: 0,
        successStatuses: [204],
        maxBytes: 0,
        maxErrorBodyBytes: limits.maxErrorBodyBytes,
        redirect: 'manual',
        credentials: 'omit'
      })
    ).pipe(Effect.timeout('10 seconds'), Effect.exit, Effect.asVoid)

    const attachmentId = yield* uploadRanges({
      session,
      url,
      bytes,
      created: created.bytes,
      budget: limits
    }).pipe(Effect.onError(() => cancel))

    return result(target.name, size, attachmentId)
  })
