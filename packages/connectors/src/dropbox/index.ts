import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import type { CredentialSlot as CredentialSlotType } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorHttpResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult, ProviderFailure } from '../result.ts'

export const dropboxConnectorId = 'dropbox'
export const dropboxOAuthSlotId = 'dropbox.oauth'
export const dropboxOAuthAuthorizeUrl = 'https://www.dropbox.com/oauth2/authorize'
export const dropboxOAuthTokenUrl = 'https://api.dropboxapi.com/oauth2/token'
export const dropboxApiBaseUrl = 'https://api.dropboxapi.com/2'

export const dropboxFilesMetadataReadScope = 'files.metadata.read'
export const dropboxFilesContentWriteScope = 'files.content.write'
export const dropboxMetadataReadScopes = Object.freeze([dropboxFilesMetadataReadScope])
export const dropboxContentWriteScopes = Object.freeze([dropboxFilesContentWriteScope])
export const dropboxCombinedScopes = Object.freeze([
  dropboxFilesMetadataReadScope,
  dropboxFilesContentWriteScope
])

export const DropboxOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth'
})

export const DropboxMetadataReadOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxMetadataReadScopes]
})

export const DropboxContentWriteOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxContentWriteScopes]
})

export const DropboxCombinedOAuthCredentialSlot = CredentialSlot.make({
  id: dropboxOAuthSlotId,
  kind: 'oauth',
  requiredScopes: [...dropboxCombinedScopes]
})

export const dropboxAuthorizationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`
})

const NonEmptyString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const DropboxSearchQuery = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1000)))
const DropboxRevision = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{9,}$/)))
const DropboxListLimit = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.check(Schema.isLessThanOrEqualTo(2000))
)
const DropboxSearchLimit = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.check(Schema.isLessThanOrEqualTo(1000))
)

export class DropboxFileMetadata extends Schema.Class<DropboxFileMetadata>('DropboxFileMetadata')({
  type: Schema.Literal('file'),
  id: Schema.String,
  name: Schema.String,
  pathLower: Schema.optional(Schema.NullOr(Schema.String)),
  pathDisplay: Schema.optional(Schema.NullOr(Schema.String)),
  clientModified: Schema.String,
  serverModified: Schema.String,
  rev: Schema.String,
  size: Schema.Number,
  isDownloadable: Schema.optional(Schema.Boolean),
  contentHash: Schema.optional(Schema.String)
}) {}

export class DropboxFolderMetadata extends Schema.Class<DropboxFolderMetadata>(
  'DropboxFolderMetadata'
)({
  type: Schema.Literal('folder'),
  id: Schema.String,
  name: Schema.String,
  pathLower: Schema.optional(Schema.NullOr(Schema.String)),
  pathDisplay: Schema.optional(Schema.NullOr(Schema.String))
}) {}

export class DropboxDeletedMetadata extends Schema.Class<DropboxDeletedMetadata>(
  'DropboxDeletedMetadata'
)({
  type: Schema.Literal('deleted'),
  name: Schema.String,
  pathLower: Schema.optional(Schema.NullOr(Schema.String)),
  pathDisplay: Schema.optional(Schema.NullOr(Schema.String)),
  isRestorable: Schema.optional(Schema.Boolean)
}) {}

export const DropboxMetadata = Schema.Union([
  DropboxFileMetadata,
  DropboxFolderMetadata,
  DropboxDeletedMetadata
])
export type DropboxMetadata = typeof DropboxMetadata.Type

export class DropboxListFolderInput extends Schema.Class<DropboxListFolderInput>(
  'DropboxListFolderInput'
)({
  path: Schema.optional(Schema.String),
  recursive: Schema.optional(Schema.Boolean),
  includeDeleted: Schema.optional(Schema.Boolean),
  limit: Schema.optional(DropboxListLimit)
}) {}

export class DropboxCursorInput extends Schema.Class<DropboxCursorInput>('DropboxCursorInput')({
  cursor: NonEmptyString
}) {}

export class DropboxListFolderOutput extends Schema.Class<DropboxListFolderOutput>(
  'DropboxListFolderOutput'
)({
  entries: Schema.Array(DropboxMetadata),
  cursor: Schema.String,
  hasMore: Schema.Boolean
}) {}

export class DropboxSearchInput extends Schema.Class<DropboxSearchInput>('DropboxSearchInput')({
  query: DropboxSearchQuery,
  path: Schema.optional(Schema.String),
  maxResults: Schema.optional(DropboxSearchLimit),
  filenameOnly: Schema.optional(Schema.Boolean),
  fileExtensions: Schema.optional(Schema.Array(NonEmptyString))
}) {}

export class DropboxHighlightSpan extends Schema.Class<DropboxHighlightSpan>(
  'DropboxHighlightSpan'
)({
  text: Schema.String,
  isHighlighted: Schema.Boolean
}) {}

export class DropboxSearchMatch extends Schema.Class<DropboxSearchMatch>('DropboxSearchMatch')({
  metadata: DropboxMetadata,
  matchType: Schema.optional(Schema.String),
  highlightSpans: Schema.optional(Schema.Array(DropboxHighlightSpan))
}) {}

export class DropboxSearchOutput extends Schema.Class<DropboxSearchOutput>('DropboxSearchOutput')({
  matches: Schema.Array(DropboxSearchMatch),
  cursor: Schema.optional(Schema.String),
  hasMore: Schema.Boolean
}) {}

export class DropboxGetMetadataInput extends Schema.Class<DropboxGetMetadataInput>(
  'DropboxGetMetadataInput'
)({
  path: NonEmptyString,
  includeDeleted: Schema.optional(Schema.Boolean)
}) {}

export class DropboxCreateFolderInput extends Schema.Class<DropboxCreateFolderInput>(
  'DropboxCreateFolderInput'
)({
  path: NonEmptyString,
  autorename: Schema.optional(Schema.Boolean)
}) {}

export class DropboxMoveInput extends Schema.Class<DropboxMoveInput>('DropboxMoveInput')({
  fromPath: NonEmptyString,
  toPath: NonEmptyString,
  autorename: Schema.optional(Schema.Boolean),
  allowOwnershipTransfer: Schema.optional(Schema.Boolean)
}) {}

export class DropboxCopyInput extends Schema.Class<DropboxCopyInput>('DropboxCopyInput')({
  fromPath: NonEmptyString,
  toPath: NonEmptyString,
  autorename: Schema.optional(Schema.Boolean)
}) {}

export class DropboxDeleteInput extends Schema.Class<DropboxDeleteInput>('DropboxDeleteInput')({
  path: NonEmptyString,
  parentRev: Schema.optional(DropboxRevision)
}) {}

const DropboxFileMetadataApi = Schema.Struct({
  '.tag': Schema.Literal('file'),
  id: Schema.String,
  name: Schema.String,
  path_lower: Schema.optional(Schema.NullOr(Schema.String)),
  path_display: Schema.optional(Schema.NullOr(Schema.String)),
  client_modified: Schema.String,
  server_modified: Schema.String,
  rev: Schema.String,
  size: Schema.Number,
  is_downloadable: Schema.optional(Schema.Boolean),
  content_hash: Schema.optional(Schema.String)
})

const DropboxFolderMetadataApi = Schema.Struct({
  '.tag': Schema.Literal('folder'),
  id: Schema.String,
  name: Schema.String,
  path_lower: Schema.optional(Schema.NullOr(Schema.String)),
  path_display: Schema.optional(Schema.NullOr(Schema.String))
})

const DropboxDeletedMetadataApi = Schema.Struct({
  '.tag': Schema.Literal('deleted'),
  name: Schema.String,
  path_lower: Schema.optional(Schema.NullOr(Schema.String)),
  path_display: Schema.optional(Schema.NullOr(Schema.String)),
  is_restorable: Schema.optional(Schema.Boolean)
})

const DropboxMetadataApi = Schema.Union([
  DropboxFileMetadataApi,
  DropboxFolderMetadataApi,
  DropboxDeletedMetadataApi
])
type DropboxMetadataApi = typeof DropboxMetadataApi.Type

const DropboxListFolderApiOutput = Schema.Struct({
  entries: Schema.Array(DropboxMetadataApi),
  cursor: Schema.String,
  has_more: Schema.Boolean
})

const DropboxSearchApiOutput = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      metadata: Schema.Struct({
        '.tag': Schema.Literal('metadata'),
        metadata: DropboxMetadataApi
      }),
      match_type: Schema.optional(
        Schema.Struct({
          '.tag': Schema.String
        })
      ),
      highlight_spans: Schema.optional(
        Schema.Array(
          Schema.Struct({
            highlight_str: Schema.String,
            is_highlighted: Schema.Boolean
          })
        )
      )
    })
  ),
  cursor: Schema.optional(Schema.String),
  has_more: Schema.Boolean
})

const DropboxCreateFolderApiOutput = Schema.Struct({
  metadata: DropboxFolderMetadataApi
})

const DropboxRelocationApiOutput = Schema.Struct({
  metadata: DropboxMetadataApi
})

const DropboxDeleteApiOutput = Schema.Struct({
  metadata: DropboxMetadataApi
})

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const isJsonObject = Schema.is(JsonObject)

const resolveDropboxAccessToken = (integration: ConnectorIntegration, slot: CredentialSlotType) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    switch (credential._tag) {
      case 'OAuthCredential':
        return credential.accessToken
      case 'BearerTokenCredential':
        return credential.token
      case 'ApiKeyCredential':
      case 'UsernamePasswordCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Dropbox connector requires an OAuth or bearer token credential',
            connectorId: integration.connectorId,
            slotId: slot.id
          })
        )
    }
  })

const decodeJsonObject = (body: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(body).pipe(
    Effect.result,
    Effect.map(result => {
      if (Result.isFailure(result) || !isJsonObject(result.success)) return undefined
      return result.success
    })
  )

const dropboxErrorDetail = (body: string) =>
  decodeJsonObject(body).pipe(
    Effect.map(parsed => {
      if (parsed === undefined) return undefined
      const summary = parsed.error_summary
      if (typeof summary === 'string' && summary.trim() !== '') return summary
      const description = parsed.error_description
      if (typeof description === 'string' && description.trim() !== '') return description
      const userMessage = parsed.user_message
      if (!isJsonObject(userMessage)) return undefined
      const text = userMessage.text
      return typeof text === 'string' && text.trim() !== '' ? text : undefined
    })
  )

const providerCode = (fallback: string, status: number, detail: string | undefined) => {
  switch (status) {
    case 401:
    case 403:
      return 'dropbox_unauthorized'
    case 404:
      return 'dropbox_not_found'
    case 409:
      if (detail?.includes('not_found') === true) return 'dropbox_not_found'
      if (detail?.includes('conflict') === true) return 'dropbox_conflict'
      return fallback
    case 429:
      return 'dropbox_rate_limited'
    default:
      return fallback
  }
}

const retryAfterMs = (response: ConnectorHttpResponse) => {
  const retryAfter = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === 'retry-after'
  )?.[1]
  if (retryAfter === undefined) return undefined
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

const dropboxProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly response: ConnectorHttpResponse
}) =>
  dropboxErrorDetail(input.response.body).pipe(
    Effect.map(detail => {
      const retry = retryAfterMs(input.response)
      return ActionResult.failure(
        new ProviderFailure({
          code: providerCode(input.code, input.response.status, detail),
          message: detail === undefined ? input.message : `${input.message}: ${detail}`,
          status: input.response.status,
          underlying: input.response.body,
          ...(retry === undefined ? {} : { retryAfterMs: retry })
        })
      )
    })
  )

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const dropboxRequest = (input: {
  readonly token: string
  readonly path: string
  readonly body: unknown
}) =>
  ConnectorHttpRequest.make({
    method: 'POST',
    url: `${dropboxApiBaseUrl}${input.path}`,
    headers: {
      ...dropboxAuthorizationHeaders(input.token),
      'content-type': 'application/json'
    },
    body: JSON.stringify(input.body)
  })

const dropboxJsonAction = <A>(input: {
  readonly integration: ConnectorIntegration
  readonly slot: CredentialSlotType
  readonly path: string
  readonly body: unknown
  readonly outputSchema: Schema.Schema<A> & { readonly DecodingServices: never }
  readonly errorCode: string
  readonly errorMessage: string
}) =>
  Effect.gen(function* () {
    const token = yield* resolveDropboxAccessToken(input.integration, input.slot)
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(
      dropboxRequest({ token, path: input.path, body: input.body })
    )

    if (!isSuccessStatus(response.status)) {
      return yield* dropboxProviderFailure({
        code: input.errorCode,
        message: input.errorMessage,
        response
      })
    }

    const output = yield* decodeJsonResponse(input.outputSchema, response)
    return ActionResult.success(output)
  }).pipe(
    Effect.withSpan('connector.dropbox.request', {
      attributes: {
        'connector.id': dropboxConnectorId,
        'connector.route': input.path
      }
    })
  )

const metadataFromApi = (metadata: DropboxMetadataApi): DropboxMetadata => {
  switch (metadata['.tag']) {
    case 'file':
      return DropboxFileMetadata.make({
        type: 'file',
        id: metadata.id,
        name: metadata.name,
        pathLower: metadata.path_lower,
        pathDisplay: metadata.path_display,
        clientModified: metadata.client_modified,
        serverModified: metadata.server_modified,
        rev: metadata.rev,
        size: metadata.size,
        isDownloadable: metadata.is_downloadable,
        contentHash: metadata.content_hash
      })
    case 'folder':
      return DropboxFolderMetadata.make({
        type: 'folder',
        id: metadata.id,
        name: metadata.name,
        pathLower: metadata.path_lower,
        pathDisplay: metadata.path_display
      })
    case 'deleted':
      return DropboxDeletedMetadata.make({
        type: 'deleted',
        name: metadata.name,
        pathLower: metadata.path_lower,
        pathDisplay: metadata.path_display,
        isRestorable: metadata.is_restorable
      })
  }
}

const listFolderOutputFromApi = (
  output: typeof DropboxListFolderApiOutput.Type
): DropboxListFolderOutput =>
  DropboxListFolderOutput.make({
    entries: output.entries.map(metadataFromApi),
    cursor: output.cursor,
    hasMore: output.has_more
  })

const searchOutputFromApi = (output: typeof DropboxSearchApiOutput.Type): DropboxSearchOutput =>
  DropboxSearchOutput.make({
    matches: output.matches.map(match =>
      DropboxSearchMatch.make({
        metadata: metadataFromApi(match.metadata.metadata),
        matchType: match.match_type?.['.tag'],
        highlightSpans: match.highlight_spans?.map(span =>
          DropboxHighlightSpan.make({
            text: span.highlight_str,
            isHighlighted: span.is_highlighted
          })
        )
      })
    ),
    cursor: output.cursor,
    hasMore: output.has_more
  })

export const dropboxListFolderAction = defineAction({
  id: 'dropbox.list_folder',
  description: 'List Dropbox folder entries. Use an empty or omitted path for the root.',
  inputSchema: DropboxListFolderInput,
  outputSchema: DropboxListFolderOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxMetadataReadOAuthCredentialSlot,
        path: '/files/list_folder',
        body: {
          path: input.path ?? '',
          recursive: input.recursive,
          include_deleted: input.includeDeleted,
          limit: input.limit
        },
        outputSchema: DropboxListFolderApiOutput,
        errorCode: 'dropbox_list_folder_failed',
        errorMessage: 'Dropbox list folder failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(listFolderOutputFromApi(result.value))
    })
})

export const dropboxListFolderContinueAction = defineAction({
  id: 'dropbox.list_folder_continue',
  description: 'Continue a Dropbox folder listing from a cursor.',
  inputSchema: DropboxCursorInput,
  outputSchema: DropboxListFolderOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxMetadataReadOAuthCredentialSlot,
        path: '/files/list_folder/continue',
        body: { cursor: input.cursor },
        outputSchema: DropboxListFolderApiOutput,
        errorCode: 'dropbox_list_folder_continue_failed',
        errorMessage: 'Dropbox list folder continuation failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(listFolderOutputFromApi(result.value))
    })
})

export const dropboxSearchAction = defineAction({
  id: 'dropbox.search',
  description: 'Search Dropbox file and folder metadata.',
  inputSchema: DropboxSearchInput,
  outputSchema: DropboxSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxMetadataReadOAuthCredentialSlot,
        path: '/files/search_v2',
        body: {
          query: input.query,
          options: {
            path: input.path,
            max_results: input.maxResults,
            filename_only: input.filenameOnly,
            file_extensions: input.fileExtensions
          }
        },
        outputSchema: DropboxSearchApiOutput,
        errorCode: 'dropbox_search_failed',
        errorMessage: 'Dropbox search failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(searchOutputFromApi(result.value))
    })
})

export const dropboxSearchContinueAction = defineAction({
  id: 'dropbox.search_continue',
  description: 'Continue a Dropbox search from a cursor.',
  inputSchema: DropboxCursorInput,
  outputSchema: DropboxSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxMetadataReadOAuthCredentialSlot,
        path: '/files/search/continue_v2',
        body: { cursor: input.cursor },
        outputSchema: DropboxSearchApiOutput,
        errorCode: 'dropbox_search_continue_failed',
        errorMessage: 'Dropbox search continuation failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(searchOutputFromApi(result.value))
    })
})

export const dropboxGetMetadataAction = defineAction({
  id: 'dropbox.get_metadata',
  description: 'Get Dropbox metadata for a path or id.',
  inputSchema: DropboxGetMetadataInput,
  outputSchema: DropboxMetadata,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxMetadataReadOAuthCredentialSlot,
        path: '/files/get_metadata',
        body: {
          path: input.path,
          include_deleted: input.includeDeleted
        },
        outputSchema: DropboxMetadataApi,
        errorCode: 'dropbox_get_metadata_failed',
        errorMessage: 'Dropbox get metadata failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(metadataFromApi(result.value))
    })
})

export const dropboxCreateFolderAction = defineAction({
  id: 'dropbox.create_folder',
  description: 'Create a Dropbox folder.',
  access: 'write',
  inputSchema: DropboxCreateFolderInput,
  outputSchema: DropboxFolderMetadata,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxContentWriteOAuthCredentialSlot,
        path: '/files/create_folder_v2',
        body: { path: input.path, autorename: input.autorename },
        outputSchema: DropboxCreateFolderApiOutput,
        errorCode: 'dropbox_create_folder_failed',
        errorMessage: 'Dropbox create folder failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(metadataFromApi(result.value.metadata))
    })
})

export const dropboxMoveAction = defineAction({
  id: 'dropbox.move',
  description: 'Move a Dropbox file or folder.',
  access: 'write',
  inputSchema: DropboxMoveInput,
  outputSchema: DropboxMetadata,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxContentWriteOAuthCredentialSlot,
        path: '/files/move_v2',
        body: {
          from_path: input.fromPath,
          to_path: input.toPath,
          autorename: input.autorename,
          allow_ownership_transfer: input.allowOwnershipTransfer
        },
        outputSchema: DropboxRelocationApiOutput,
        errorCode: 'dropbox_move_failed',
        errorMessage: 'Dropbox move failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(metadataFromApi(result.value.metadata))
    })
})

export const dropboxCopyAction = defineAction({
  id: 'dropbox.copy',
  description: 'Copy a Dropbox file or folder.',
  access: 'write',
  inputSchema: DropboxCopyInput,
  outputSchema: DropboxMetadata,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxContentWriteOAuthCredentialSlot,
        path: '/files/copy_v2',
        body: {
          from_path: input.fromPath,
          to_path: input.toPath,
          autorename: input.autorename
        },
        outputSchema: DropboxRelocationApiOutput,
        errorCode: 'dropbox_copy_failed',
        errorMessage: 'Dropbox copy failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(metadataFromApi(result.value.metadata))
    })
})

export const dropboxDeleteAction = defineAction({
  id: 'dropbox.delete',
  description: 'Delete a Dropbox file or folder.',
  access: 'destructive',
  inputSchema: DropboxDeleteInput,
  outputSchema: DropboxMetadata,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* dropboxJsonAction({
        integration,
        slot: DropboxContentWriteOAuthCredentialSlot,
        path: '/files/delete_v2',
        body: { path: input.path, parent_rev: input.parentRev },
        outputSchema: DropboxDeleteApiOutput,
        errorCode: 'dropbox_delete_failed',
        errorMessage: 'Dropbox delete failed'
      })
      if (result._tag === 'Failure') return result
      return ActionResult.success(metadataFromApi(result.value.metadata))
    })
})

export const dropboxActions = [
  dropboxListFolderAction,
  dropboxListFolderContinueAction,
  dropboxSearchAction,
  dropboxSearchContinueAction,
  dropboxGetMetadataAction,
  dropboxCreateFolderAction,
  dropboxMoveAction,
  dropboxCopyAction,
  dropboxDeleteAction
]

export const DropboxConnector = defineConnector({
  id: dropboxConnectorId,
  description: 'Dropbox file metadata and file-management connector actions.',
  actions: dropboxActions
})
