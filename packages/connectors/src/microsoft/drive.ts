import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { optionalStringConfig } from '../config.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  MicrosoftOneDriveReadAllOAuthCredentialSlot,
  MicrosoftOneDriveReadOAuthCredentialSlot,
  MicrosoftOneDriveWriteAllOAuthCredentialSlot,
  MicrosoftOneDriveWriteOAuthCredentialSlot
} from './oauth.ts'
import {
  isMicrosoftSuccessStatus,
  microsoftGraphApiBaseUrl,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from './shared.ts'

export const microsoftOneDriveAccessModeConfigKey = 'oneDriveAccessMode'
export const MicrosoftOneDriveAccessMode = Schema.Literals([
  'delegated',
  'delegated_all',
  'application'
])
export type MicrosoftOneDriveAccessMode = typeof MicrosoftOneDriveAccessMode.Type

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())
const OneDrivePageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 }))

const oneDriveItemSelect = [
  'id',
  'name',
  'size',
  'webUrl',
  'createdDateTime',
  'lastModifiedDateTime',
  'eTag',
  'cTag',
  'parentReference',
  'file',
  'folder',
  'package',
  'remoteItem',
  'shared',
  'deleted'
].join(',')

export class OneDriveHashes extends Schema.Class<OneDriveHashes>('OneDriveHashes')({
  crc32Hash: Schema.optional(Schema.String),
  quickXorHash: Schema.optional(Schema.String),
  sha1Hash: Schema.optional(Schema.String),
  sha256Hash: Schema.optional(Schema.String)
}) {}

export class OneDriveFileFacet extends Schema.Class<OneDriveFileFacet>('OneDriveFileFacet')({
  mimeType: Schema.optional(Schema.String),
  hashes: Schema.optional(OneDriveHashes)
}) {}

export class OneDriveFolderFacet extends Schema.Class<OneDriveFolderFacet>('OneDriveFolderFacet')({
  childCount: Schema.optional(Schema.Number)
}) {}

export class OneDrivePackageFacet extends Schema.Class<OneDrivePackageFacet>(
  'OneDrivePackageFacet'
)({
  type: Schema.optional(Schema.String)
}) {}

export class OneDriveParentReference extends Schema.Class<OneDriveParentReference>(
  'OneDriveParentReference'
)({
  driveId: Schema.optional(Schema.String),
  driveType: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  shareId: Schema.optional(Schema.String),
  siteId: Schema.optional(Schema.String)
}) {}

export class OneDriveItem extends Schema.Class<OneDriveItem>('OneDriveItem')({
  id: Schema.String,
  name: Schema.String,
  size: Schema.optional(Schema.Number),
  webUrl: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String),
  eTag: Schema.optional(Schema.String),
  cTag: Schema.optional(Schema.String),
  parentReference: Schema.optional(OneDriveParentReference),
  file: Schema.optional(OneDriveFileFacet),
  folder: Schema.optional(OneDriveFolderFacet),
  package: Schema.optional(OneDrivePackageFacet),
  remoteItem: Schema.optional(Schema.Unknown),
  shared: Schema.optional(Schema.Unknown),
  deleted: Schema.optional(Schema.Unknown)
}) {}

export class OneDriveListItemsInput extends Schema.Class<OneDriveListItemsInput>(
  'OneDriveListItemsInput'
)({
  driveId: Schema.optional(NonEmptyString),
  parentItemId: Schema.optional(NonEmptyString),
  top: Schema.optional(OneDrivePageSize),
  orderBy: Schema.optional(NonEmptyString),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OneDriveSearchItemsInput extends Schema.Class<OneDriveSearchItemsInput>(
  'OneDriveSearchItemsInput'
)({
  query: NonEmptyString,
  driveId: Schema.optional(NonEmptyString),
  top: Schema.optional(OneDrivePageSize),
  nextLink: Schema.optional(Schema.String)
}) {}

export class OneDriveListItemsOutput extends Schema.Class<OneDriveListItemsOutput>(
  'OneDriveListItemsOutput'
)({
  items: Schema.Array(OneDriveItem),
  nextLink: Schema.optional(Schema.String)
}) {}

const OneDriveItemsApiOutput = Schema.Struct({
  value: Schema.Array(OneDriveItem),
  '@odata.nextLink': Schema.optional(Schema.String)
})

export class OneDriveItemIdInput extends Schema.Class<OneDriveItemIdInput>('OneDriveItemIdInput')({
  itemId: NonEmptyString,
  driveId: Schema.optional(NonEmptyString)
}) {}

export class OneDriveCreateFolderInput extends Schema.Class<OneDriveCreateFolderInput>(
  'OneDriveCreateFolderInput'
)({
  name: NonEmptyString,
  driveId: Schema.optional(NonEmptyString),
  parentItemId: Schema.optional(NonEmptyString),
  conflictBehavior: Schema.optional(Schema.Literals(['fail', 'replace', 'rename']))
}) {}

export class OneDriveDeleteItemInput extends Schema.Class<OneDriveDeleteItemInput>(
  'OneDriveDeleteItemInput'
)({
  itemId: NonEmptyString,
  driveId: Schema.optional(NonEmptyString),
  ifMatch: Schema.optional(NonEmptyString)
}) {}

export class OneDriveDeleteItemOutput extends Schema.Class<OneDriveDeleteItemOutput>(
  'OneDriveDeleteItemOutput'
)({
  deleted: Schema.Boolean
}) {}

const oneDriveTargetPath = (driveId: string | undefined) =>
  driveId === undefined ? '/me/drive' : `/drives/${encodeURIComponent(driveId)}`

const oneDriveAccessMode = (integration: ConnectorIntegration) => {
  const configured = optionalStringConfig(integration, microsoftOneDriveAccessModeConfigKey)
  if (configured === undefined) return Effect.succeed<MicrosoftOneDriveAccessMode>('delegated')

  return Schema.decodeUnknownEffect(MicrosoftOneDriveAccessMode)(configured).pipe(
    Effect.mapError(
      error =>
        new ConnectorError({
          cause: 'validation_failed',
          message: `Invalid integration config: ${microsoftOneDriveAccessModeConfigKey}`,
          connectorId: integration.connectorId,
          underlying: error
        })
    )
  )
}

const requireDriveForApplicationAccess = (
  integration: ConnectorIntegration,
  driveId: string | undefined,
  accessMode: MicrosoftOneDriveAccessMode
) =>
  accessMode !== 'application' || driveId !== undefined
    ? Effect.void
    : Effect.fail(
        new ConnectorError({
          cause: 'validation_failed',
          message: 'Microsoft application OneDrive access requires an explicit driveId',
          connectorId: integration.connectorId
        })
      )

const oneDriveReadSlot = (integration: ConnectorIntegration, driveId: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* oneDriveAccessMode(integration)
    yield* requireDriveForApplicationAccess(integration, driveId, accessMode)
    return accessMode === 'delegated'
      ? MicrosoftOneDriveReadOAuthCredentialSlot
      : MicrosoftOneDriveReadAllOAuthCredentialSlot
  })

const oneDriveWriteSlot = (integration: ConnectorIntegration, driveId: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* oneDriveAccessMode(integration)
    yield* requireDriveForApplicationAccess(integration, driveId, accessMode)
    return accessMode === 'delegated'
      ? MicrosoftOneDriveWriteOAuthCredentialSlot
      : MicrosoftOneDriveWriteAllOAuthCredentialSlot
  })

const invalidNextLink = (actionId: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Microsoft Graph nextLink must target the selected OneDrive collection',
    connectorId: microsoftConnectorId,
    actionId
  })

const isTrustedGraphUrl = (parsed: URL) =>
  parsed.protocol === 'https:' &&
  parsed.hostname === 'graph.microsoft.com' &&
  parsed.port === '' &&
  parsed.username === '' &&
  parsed.password === '' &&
  parsed.hash === ''

const requireOneDriveListNextLink = (
  nextLink: string,
  driveId: string | undefined,
  parentItemId: string | undefined
) => {
  if (!URL.canParse(nextLink)) return Effect.fail(invalidNextLink('onedrive.list_items'))

  const parsed = new URL(nextLink)
  const targetRoot = `/v1.0${oneDriveTargetPath(driveId)}`
  const selectedCollection =
    parentItemId === undefined
      ? `${targetRoot}/root/children`
      : `${targetRoot}/items/${encodeURIComponent(parentItemId)}/children`

  return isTrustedGraphUrl(parsed) && parsed.pathname === selectedCollection
    ? Effect.succeed(nextLink)
    : Effect.fail(invalidNextLink('onedrive.list_items'))
}

const requireOneDriveSearchNextLink = (nextLink: string, driveId: string | undefined) => {
  if (!URL.canParse(nextLink)) return Effect.fail(invalidNextLink('onedrive.search_items'))

  const parsed = new URL(nextLink)
  const searchPrefix = `/v1.0${oneDriveTargetPath(driveId)}/root/search(`
  return isTrustedGraphUrl(parsed) &&
    parsed.pathname.startsWith(searchPrefix) &&
    parsed.pathname.endsWith(')')
    ? Effect.succeed(nextLink)
    : Effect.fail(invalidNextLink('onedrive.search_items'))
}

const oneDriveReadHeaders = (token: string) => ({
  ...microsoftAuthorizationHeaders(token),
  accept: 'application/json'
})

const oneDriveWriteHeaders = (token: string) => ({
  ...oneDriveReadHeaders(token),
  'content-type': 'application/json'
})

const oneDriveListUrl = (input: OneDriveListItemsInput) => {
  if (input.nextLink !== undefined) {
    return requireOneDriveListNextLink(input.nextLink, input.driveId, input.parentItemId)
  }

  const targetRoot = oneDriveTargetPath(input.driveId)
  const collectionPath =
    input.parentItemId === undefined
      ? `${targetRoot}/root/children`
      : `${targetRoot}/items/${encodeURIComponent(input.parentItemId)}/children`
  const params = new URLSearchParams({ $select: oneDriveItemSelect })
  if (input.top !== undefined) params.set('$top', String(input.top))
  if (input.orderBy !== undefined) params.set('$orderby', input.orderBy)
  return Effect.succeed(`${microsoftGraphApiBaseUrl}${collectionPath}?${params.toString()}`)
}

const encodedOneDriveSearchQuery = (query: string) =>
  encodeURIComponent(query.replaceAll("'", "''")).replaceAll("'", '%27')

const oneDriveSearchUrl = (input: OneDriveSearchItemsInput) => {
  if (input.nextLink !== undefined) {
    return requireOneDriveSearchNextLink(input.nextLink, input.driveId)
  }

  const params = new URLSearchParams({ $select: oneDriveItemSelect })
  if (input.top !== undefined) params.set('$top', String(input.top))
  const searchPath = `${oneDriveTargetPath(input.driveId)}/root/search(q='${encodedOneDriveSearchQuery(input.query)}')`
  return Effect.succeed(`${microsoftGraphApiBaseUrl}${searchPath}?${params.toString()}`)
}

const oneDriveItemsAction = (input: {
  readonly integration: ConnectorIntegration
  readonly driveId: string | undefined
  readonly url: Effect.Effect<string, ConnectorError>
  readonly code: string
  readonly message: string
}) =>
  Effect.gen(function* () {
    const slot = yield* oneDriveReadSlot(input.integration, input.driveId)
    const token = yield* resolveMicrosoftAccessToken(input.integration, slot)
    const url = yield* input.url
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url,
        headers: oneDriveReadHeaders(token)
      })
    )

    if (!isMicrosoftSuccessStatus(response.status)) {
      return yield* microsoftProviderFailure({
        code: input.code,
        message: input.message,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(OneDriveItemsApiOutput, response)
    return ActionResult.success(
      OneDriveListItemsOutput.make({
        items: output.value,
        ...(output['@odata.nextLink'] === undefined ? {} : { nextLink: output['@odata.nextLink'] })
      })
    )
  })

export const oneDriveListItemsAction = defineAction({
  id: 'onedrive.list_items',
  description: 'List items in the signed-in OneDrive root or a selected drive folder.',
  inputSchema: OneDriveListItemsInput,
  outputSchema: OneDriveListItemsOutput,
  execute: ({ integration, input }) =>
    oneDriveItemsAction({
      integration,
      driveId: input.driveId,
      url: oneDriveListUrl(input),
      code: 'onedrive_list_items_failed',
      message: 'Microsoft OneDrive list items failed'
    })
})

export const oneDriveSearchItemsAction = defineAction({
  id: 'onedrive.search_items',
  description: 'Search item names, metadata, and indexed content in a Microsoft OneDrive.',
  inputSchema: OneDriveSearchItemsInput,
  outputSchema: OneDriveListItemsOutput,
  execute: ({ integration, input }) =>
    oneDriveItemsAction({
      integration,
      driveId: input.driveId,
      url: oneDriveSearchUrl(input),
      code: 'onedrive_search_items_failed',
      message: 'Microsoft OneDrive search items failed'
    })
})

export const oneDriveGetItemAction = defineAction({
  id: 'onedrive.get_item',
  description: 'Get metadata for one Microsoft OneDrive file or folder by stable item id.',
  inputSchema: OneDriveItemIdInput,
  outputSchema: OneDriveItem,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveReadSlot(integration, input.driveId)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({ $select: oneDriveItemSelect })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${microsoftGraphApiBaseUrl}${oneDriveTargetPath(input.driveId)}/items/${encodeURIComponent(input.itemId)}?${params.toString()}`,
          headers: oneDriveReadHeaders(token)
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'onedrive_get_item_failed',
          message: 'Microsoft OneDrive get item failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OneDriveItem, response)
      return ActionResult.success(output)
    })
})

export const oneDriveCreateFolderAction = defineAction({
  id: 'onedrive.create_folder',
  description: 'Create a folder in a Microsoft OneDrive root or selected parent folder.',
  inputSchema: OneDriveCreateFolderInput,
  outputSchema: OneDriveItem,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveWriteSlot(integration, input.driveId)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const targetRoot = oneDriveTargetPath(input.driveId)
      const collectionPath =
        input.parentItemId === undefined
          ? `${targetRoot}/root/children`
          : `${targetRoot}/items/${encodeURIComponent(input.parentItemId)}/children`
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${microsoftGraphApiBaseUrl}${collectionPath}`,
          headers: oneDriveWriteHeaders(token),
          body: JSON.stringify({
            name: input.name,
            folder: {},
            '@microsoft.graph.conflictBehavior': input.conflictBehavior ?? 'fail'
          })
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'onedrive_create_folder_failed',
          message: 'Microsoft OneDrive create folder failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OneDriveItem, response)
      return ActionResult.success(output)
    })
})

export const oneDriveDeleteItemAction = defineAction({
  id: 'onedrive.delete_item',
  description: 'Move a Microsoft OneDrive file or folder to the recycle bin.',
  inputSchema: OneDriveDeleteItemInput,
  outputSchema: OneDriveDeleteItemOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveWriteSlot(integration, input.driveId)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'DELETE',
          url: `${microsoftGraphApiBaseUrl}${oneDriveTargetPath(input.driveId)}/items/${encodeURIComponent(input.itemId)}`,
          headers: {
            ...oneDriveReadHeaders(token),
            ...(input.ifMatch === undefined ? {} : { 'if-match': input.ifMatch })
          }
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'onedrive_delete_item_failed',
          message: 'Microsoft OneDrive delete item failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      return ActionResult.success(OneDriveDeleteItemOutput.make({ deleted: true }))
    })
})

export const oneDriveActions = [
  oneDriveListItemsAction,
  oneDriveSearchItemsAction,
  oneDriveGetItemAction,
  oneDriveCreateFolderAction,
  oneDriveDeleteItemAction
]
