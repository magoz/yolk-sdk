import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorBinaryWriteHttpClient } from '../binary-write-http.ts'
import type { ConnectorHttpClient } from '../http.ts'
import { ConnectorFileTransferError } from '../file-transfer.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { CredentialResolver } from '../credential.ts'
import type { ConnectorIntegration } from '../integration.ts'
import type { GithubRepoRef } from './shared.ts'
import {
  checkResponse,
  credentialFailure,
  decodeInput,
  decodeMetadata,
  failTransfer,
  isBytes,
  safeToken,
  validateTransfer
} from '../transfer-internal.ts'
import { decodeJsonResponse } from '../http.ts'
import {
  githubRepoPath,
  githubRequest,
  githubUploadsBaseUrl,
  githubUserAgent,
  isGithubSuccess,
  resolveGithubRepo,
  resolveGithubUploadToken
} from './shared.ts'

/**
 * Native GitHub user-attachment upload (host-only, NOT an action).
 *
 * UNDOCUMENTED/UNSTABLE endpoint: `POST https://uploads.github.com/user-attachments/assets`.
 * GitHub refuses App installation (`ghs_`) tokens here and answers 404 when the token has
 * no push access to the repository (evidence: cli/cli#14309, mlflow/mlflow#25141); both
 * surface as code-only transfer errors, never with token, bytes, or URL details.
 */
export const githubAttachmentMaxImageBytes = 10 * 1024 * 1024

export const githubAttachmentMaxVideoBytes = 100 * 1024 * 1024

/** Required prefix for every attachment URL GitHub returns. */
export const githubAttachmentUrlPrefix = 'https://github.com/user-attachments/'

export interface GithubAttachmentUploadInput {
  readonly name: string
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly repositoryId?: number
  readonly alt?: string
}

export interface GithubAttachmentUploadOptions {
  readonly maxImageBytes?: number
  readonly maxVideoBytes?: number
}

export interface GithubAttachmentUploadOutput {
  readonly url: string
  readonly markdown: string
}

const githubAttachmentAllowlist = [
  { contentType: 'image/png', extensions: ['png'], kind: 'image' },
  { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'], kind: 'image' },
  { contentType: 'image/gif', extensions: ['gif'], kind: 'image' },
  { contentType: 'image/webp', extensions: ['webp'], kind: 'image' },
  { contentType: 'image/svg+xml', extensions: ['svg'], kind: 'image' },
  { contentType: 'video/mp4', extensions: ['mp4'], kind: 'video' },
  { contentType: 'video/quicktime', extensions: ['mov'], kind: 'video' },
  { contentType: 'video/webm', extensions: ['webm'], kind: 'video' }
] as const

const GithubAttachmentRepo = Schema.Struct({ id: Schema.Number })

const GithubAttachmentMetadata = Schema.Struct({
  url: Schema.optional(Schema.String),
  href: Schema.optional(Schema.String)
})

const invalidAttachmentName = /[\u0000-\u001f\u007f\ud800-\udfff]/

const lookupGithubRepoId = (
  ref: GithubRepoRef,
  uploadToken: string
): Effect.Effect<number, ConnectorFileTransferError, ConnectorHttpClient> =>
  Effect.gen(function* () {
    const response = yield* githubRequest(uploadToken, {
      method: 'GET',
      path: `${githubRepoPath(ref)}`
    }).pipe(Effect.mapError(() => new ConnectorFileTransferError({ code: 'transport_failed' })))

    if (!isGithubSuccess(response.status)) {
      if (response.status === 401) return yield* failTransfer('unauthorized')

      if (response.status === 403) return yield* failTransfer('forbidden')

      if (response.status === 404) return yield* failTransfer('not_found')

      return yield* failTransfer('upstream_failed')
    }

    const repo = yield* decodeJsonResponse(GithubAttachmentRepo, response).pipe(
      Effect.mapError(() => new ConnectorFileTransferError({ code: 'invalid_metadata' }))
    )

    return repo.id
  })

const escapeMarkdownAlt = (alt: string) =>
  alt.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/([[\]\\])/g, '\\$1')

/** Opaque attachment path only: no whitespace, parentheses, or markdown metacharacters. */
const attachmentUrlPattern = /^https:\/\/github\.com\/user-attachments\/[A-Za-z0-9._~/-]+$/

/**
 * Upload bytes as a GitHub user attachment and return its URL plus ready-to-paste
 * markdown (image embed for images, bare URL for videos which GitHub renders inline).
 */
export const uploadGithubAttachment = (
  integration: ConnectorIntegration,
  input: GithubAttachmentUploadInput,
  budget: ConnectorFileTransferBudget,
  options: GithubAttachmentUploadOptions = {}
): Effect.Effect<
  GithubAttachmentUploadOutput,
  ConnectorFileTransferError,
  ConnectorBinaryWriteHttpClient | ConnectorHttpClient | CredentialResolver
> =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'github', budget)

    yield* decodeInput(Schema.Record(Schema.String, Schema.Unknown), input)

    const entry = githubAttachmentAllowlist.find(item => item.contentType === input.contentType)

    if (entry === undefined) return yield* failTransfer('invalid_input')

    if (
      !Predicate.isString(input.name) ||
      input.name.length === 0 ||
      input.name.includes('/') ||
      input.name.includes('\\') ||
      invalidAttachmentName.test(input.name)
    ) {
      return yield* failTransfer('invalid_input')
    }

    const dot = input.name.lastIndexOf('.')

    const extension =
      dot <= 0 || dot === input.name.length - 1
        ? undefined
        : input.name.slice(dot + 1).toLowerCase()

    const allowedExtensions: ReadonlyArray<string> = entry.extensions

    if (extension === undefined || !allowedExtensions.includes(extension)) {
      return yield* failTransfer('invalid_input')
    }

    if (!isBytes(input.bytes) || input.bytes.byteLength === 0) {
      return yield* failTransfer('invalid_input')
    }

    if (input.repositoryId !== undefined) {
      if (
        !Predicate.isNumber(input.repositoryId) ||
        !Number.isInteger(input.repositoryId) ||
        input.repositoryId <= 0
      ) {
        return yield* failTransfer('invalid_input')
      }
    }

    if (input.alt !== undefined && !Predicate.isString(input.alt)) {
      return yield* failTransfer('invalid_input')
    }

    const hostLimit = entry.kind === 'video' ? options.maxVideoBytes : options.maxImageBytes

    if (
      hostLimit !== undefined &&
      (!Predicate.isNumber(hostLimit) || !Number.isInteger(hostLimit) || hostLimit < 0)
    ) {
      return yield* failTransfer('invalid_input')
    }

    const providerLimit =
      entry.kind === 'video' ? githubAttachmentMaxVideoBytes : githubAttachmentMaxImageBytes

    const effectiveLimit = Math.min(providerLimit, hostLimit ?? providerLimit, limits.maxBytes)

    if (input.bytes.byteLength > effectiveLimit) {
      return yield* failTransfer('invalid_input')
    }

    const ref = yield* resolveGithubRepo(integration).pipe(
      Effect.mapError(() => new ConnectorFileTransferError({ code: 'invalid_input' }))
    )

    const uploadToken = yield* resolveGithubUploadToken(integration).pipe(
      Effect.mapError(credentialFailure),
      Effect.flatMap(safeToken)
    )

    const repositoryId =
      input.repositoryId === undefined
        ? yield* lookupGithubRepoId(ref, uploadToken)
        : input.repositoryId

    const params = new URLSearchParams({
      name: input.name,
      content_type: input.contentType,
      repository_id: String(repositoryId)
    })

    const binary = yield* ConnectorBinaryWriteHttpClient

    const response = yield* binary
      .request({
        method: 'POST',
        url: `${githubUploadsBaseUrl}/user-attachments/assets?${params}`,
        headers: {
          authorization: `Bearer ${uploadToken}`,
          'content-type': input.contentType,
          accept: 'application/json',
          'user-agent': githubUserAgent
        },
        bytes: input.bytes,
        redirect: 'manual',
        credentials: 'omit',
        maxUploadBytes: effectiveLimit,
        successStatuses: [200, 201],
        maxBytes: limits.maxMetadataBytes,
        maxErrorBodyBytes: limits.maxErrorBodyBytes
      })
      .pipe(Effect.mapError(error => new ConnectorFileTransferError({ code: error.code })))

    if (response.status === 422) {
      return yield* failTransfer('invalid_input')
    }

    const checked = yield* checkResponse(
      response,
      limits.maxMetadataBytes,
      limits.maxErrorBodyBytes,
      true
    )

    const metadata = yield* decodeMetadata(GithubAttachmentMetadata, checked.bytes)

    const url = metadata.url ?? metadata.href ?? null

    if (
      url === null ||
      !url.startsWith(githubAttachmentUrlPrefix) ||
      !attachmentUrlPattern.test(url)
    ) {
      return yield* failTransfer('invalid_metadata')
    }

    if (entry.kind === 'video') {
      return { url, markdown: url }
    }

    const stem = input.name.slice(0, dot)

    return { url, markdown: `![${escapeMarkdownAlt(input.alt ?? stem)}](${url})` }
  })
