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
  microsoftSanitizedProviderFailure,
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

type OneDriveListItemsOutputFields = {
  readonly items: ReadonlyArray<OneDriveItem>
  nextLink?: string
}

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

const OneDriveOperationText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    value =>
      value.trim() === value &&
      !/[\ud800-\udfff]/u.test(value) &&
      !/[\u0000-\u001f\u007f]/.test(value)
  )
)

const OneDriveOperationId = OneDriveOperationText.check(
  Schema.makeFilter(value => !/^\.+$/.test(value))
)

const OneDriveConcreteItemId = OneDriveOperationId.check(
  Schema.makeFilter(value => value.toLowerCase() !== 'root')
)

const OneDriveItemName = OneDriveOperationText.check(
  Schema.makeFilter(
    value => !/["*:<>?\/\\|]/.test(value) && value !== '.' && value !== '..' && !value.endsWith('.')
  )
)

export class OneDriveMoveItemInput extends Schema.Class<OneDriveMoveItemInput>(
  'OneDriveMoveItemInput'
)({
  itemId: OneDriveConcreteItemId,
  driveId: Schema.optional(OneDriveOperationId),
  destinationParentItemId: OneDriveConcreteItemId,
  name: Schema.optional(OneDriveItemName),
  ifMatch: Schema.optional(OneDriveOperationText)
}) {}

export class OneDriveCopyItemInput extends Schema.Class<OneDriveCopyItemInput>(
  'OneDriveCopyItemInput'
)({
  itemId: OneDriveConcreteItemId,
  driveId: Schema.optional(OneDriveOperationId),
  destinationDriveId: OneDriveOperationId,
  destinationParentItemId: OneDriveConcreteItemId,
  name: Schema.optional(OneDriveItemName),
  conflictBehavior: Schema.optional(Schema.Literals(['fail', 'rename']))
}) {}

const OneDriveCopyMonitorId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const OneDriveCopyMonitorRawUnsafe = /[\u0000-\u0020\u007f\\,]/

const OneDriveCopyMonitorMalformedPercent = /%(?![0-9a-f]{2})/i

const OneDriveCopyMonitorEncodedUnsafe = /%(?:0[0-9a-f]|1[0-9a-f]|2c|2f|5c|7f)/i

const OneDriveApiMonitorPath = new RegExp(`^/monitor/${OneDriveCopyMonitorId}$`, 'i')

const OneDriveSharePointMonitorPath = new RegExp(
  `^/(?:[^/]+/)*_api/v2\\.[01]/monitor/${OneDriveCopyMonitorId}$`,
  'i'
)

const isOneDriveCopyMonitorUrl = (value: string) => {
  if (
    OneDriveCopyMonitorRawUnsafe.test(value) ||
    OneDriveCopyMonitorMalformedPercent.test(value) ||
    OneDriveCopyMonitorEncodedUnsafe.test(value) ||
    !URL.canParse(value)
  ) {
    return false
  }

  const parsed = new URL(value)

  if (
    parsed.toString() !== value ||
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return false
  }

  if (parsed.hostname === 'api.onedrive.com') {
    return OneDriveApiMonitorPath.test(parsed.pathname)
  }

  return (
    parsed.hostname.endsWith('.sharepoint.com') &&
    OneDriveSharePointMonitorPath.test(parsed.pathname)
  )
}

export const OneDriveCopyMonitorUrl = Schema.String.check(
  Schema.makeFilter(isOneDriveCopyMonitorUrl)
)

export type OneDriveCopyMonitorUrl = typeof OneDriveCopyMonitorUrl.Type

export class OneDriveCopyAcceptedOutput extends Schema.Class<OneDriveCopyAcceptedOutput>(
  'OneDriveCopyAcceptedOutput'
)({
  status: Schema.Literal('accepted'),
  monitorUrl: OneDriveCopyMonitorUrl
}) {}

export const OneDriveCopyStatus = Schema.Literals([
  'notStarted',
  'inProgress',
  'completed',
  'updating',
  'failed',
  'deletePending',
  'deleteFailed',
  'waiting'
])

export type OneDriveCopyStatus = typeof OneDriveCopyStatus.Type

export class OneDriveCopyStatusInput extends Schema.Class<OneDriveCopyStatusInput>(
  'OneDriveCopyStatusInput'
)({
  monitorUrl: OneDriveCopyMonitorUrl,
  driveId: Schema.optional(OneDriveOperationId)
}) {}

export class OneDriveCopyStatusError extends Schema.Class<OneDriveCopyStatusError>(
  'OneDriveCopyStatusError'
)({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
}) {}

export class OneDriveCopyStatusOutput extends Schema.Class<OneDriveCopyStatusOutput>(
  'OneDriveCopyStatusOutput'
)({
  status: OneDriveCopyStatus,
  percentageComplete: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  ),
  itemId: Schema.optional(OneDriveOperationId),
  error: Schema.optional(OneDriveCopyStatusError)
}) {}

const OneDriveCopyStatusErrorApi = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  details: Schema.optional(
    Schema.Array(
      Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
        target: Schema.optional(Schema.String)
      })
    )
  )
})

const OneDriveCopyStatusApi = Schema.Struct({
  status: OneDriveCopyStatus,
  percentageComplete: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  ),
  percentComplete: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  ),
  resourceId: Schema.optional(OneDriveOperationId),
  error: Schema.optional(OneDriveCopyStatusErrorApi)
})

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

// Internal shared permission selection for metadata actions and host-only downloads.
export const oneDriveReadSlot = (integration: ConnectorIntegration, driveId: string | undefined) =>
  Effect.gen(function* () {
    const accessMode = yield* oneDriveAccessMode(integration)
    yield* requireDriveForApplicationAccess(integration, driveId, accessMode)

    return accessMode === 'delegated'
      ? MicrosoftOneDriveReadOAuthCredentialSlot
      : MicrosoftOneDriveReadAllOAuthCredentialSlot
  })

export const oneDriveWriteSlot = (integration: ConnectorIntegration, driveId: string | undefined) =>
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

const invalidOneDriveResponse = (actionId: string, message: string, underlying?: unknown) =>
  new ConnectorError({
    cause: 'validation_failed',
    message,
    connectorId: microsoftConnectorId,
    actionId,
    underlying
  })

const singleHeader = (headers: Readonly<Record<string, string>>, name: string) => {
  const matches = Object.entries(headers).filter(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase()
  )

  return matches.length === 1 ? matches[0]?.[1] : undefined
}

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
      OneDriveListItemsOutput.make(
        (() => {
          const fields: OneDriveListItemsOutputFields = {
            items: output.value
          }

          if (output['@odata.nextLink'] !== undefined) {
            fields.nextLink = output['@odata.nextLink']
          }

          return fields
        })()
      )
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
  access: 'write',
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

export const oneDriveMoveItemAction = defineAction({
  id: 'onedrive.move_item',
  description:
    'Move a Microsoft OneDrive file or folder within its current drive. Cross-drive moves are not supported. The returned item confirms the synchronous move.',
  access: 'write',
  inputSchema: OneDriveMoveItemInput,
  outputSchema: OneDriveItem,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveWriteSlot(integration, input.driveId)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      type OneDriveMoveHeaders = {
        readonly authorization: string
        readonly accept: string
        readonly 'content-type': string
        'if-match'?: string
      }

      const headers: OneDriveMoveHeaders = oneDriveWriteHeaders(token)

      if (input.ifMatch !== undefined) {
        headers['if-match'] = input.ifMatch
      }

      type OneDriveMoveBody = {
        readonly parentReference: { readonly id: string }
        name?: string
      }

      const body: OneDriveMoveBody = {
        parentReference: { id: input.destinationParentItemId }
      }

      if (input.name !== undefined) {
        body.name = input.name
      }

      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'PATCH',
          url: `${microsoftGraphApiBaseUrl}${oneDriveTargetPath(input.driveId)}/items/${encodeURIComponent(input.itemId)}`,
          headers,
          body: JSON.stringify(body),
          redirect: 'manual',
          credentials: 'omit'
        })
      )

      if (!isMicrosoftSuccessStatus(response.status)) {
        return yield* microsoftProviderFailure({
          code: 'onedrive_move_item_failed',
          message: 'Microsoft OneDrive move item failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(OneDriveItem, response)

      return ActionResult.success(output)
    })
})

export const oneDriveCopyItemAction = defineAction({
  id: 'onedrive.copy_item',
  description:
    "Queue an asynchronous Microsoft OneDrive copy, including folder children. Returns accepted with a short-lived monitor URL; acceptance does not mean the copy completed. Omission of conflictBehavior uses Graph's documented fail default. Destructive replace mode is intentionally unsupported.",
  access: 'write',
  inputSchema: OneDriveCopyItemInput,
  outputSchema: OneDriveCopyAcceptedOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveWriteSlot(integration, input.driveId)
      const token = yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      const url = new URL(
        `${microsoftGraphApiBaseUrl}${oneDriveTargetPath(input.driveId)}/items/${encodeURIComponent(input.itemId)}/copy`
      )

      if (input.conflictBehavior !== undefined) {
        url.searchParams.set('@microsoft.graph.conflictBehavior', input.conflictBehavior)
      }

      type OneDriveCopyBody = {
        readonly parentReference: {
          readonly driveId: string
          readonly id: string
        }
        name?: string
      }

      const body: OneDriveCopyBody = {
        parentReference: {
          driveId: input.destinationDriveId,
          id: input.destinationParentItemId
        }
      }

      if (input.name !== undefined) {
        body.name = input.name
      }

      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: url.toString(),
          headers: oneDriveWriteHeaders(token),
          body: JSON.stringify(body),
          redirect: 'manual',
          credentials: 'omit'
        })
      )

      if (response.status !== 202) {
        if (!isMicrosoftSuccessStatus(response.status)) {
          return yield* microsoftProviderFailure({
            code: 'onedrive_copy_item_failed',
            message: 'Microsoft OneDrive copy item failed',
            status: response.status,
            headers: response.headers,
            body: response.body
          })
        }

        return yield* Effect.fail(
          invalidOneDriveResponse(
            'onedrive.copy_item',
            'Microsoft OneDrive copy item returned an unexpected success status'
          )
        )
      }

      const location = singleHeader(response.headers, 'location')

      if (location === undefined) {
        return yield* Effect.fail(
          invalidOneDriveResponse(
            'onedrive.copy_item',
            'Microsoft OneDrive copy item did not return one monitor location'
          )
        )
      }

      const monitorUrl = yield* Schema.decodeUnknownEffect(OneDriveCopyMonitorUrl)(location).pipe(
        Effect.mapError(error =>
          invalidOneDriveResponse(
            'onedrive.copy_item',
            'Microsoft OneDrive copy item returned an untrusted monitor location',
            error
          )
        )
      )

      return ActionResult.success(
        OneDriveCopyAcceptedOutput.make({ status: 'accepted', monitorUrl })
      )
    })
})

export const oneDriveGetCopyStatusAction = defineAction({
  id: 'onedrive.get_copy_status',
  description:
    'Poll one previously accepted OneDrive copy once. The short-lived monitor URL is requested without credentials and redirects are not followed. Callers must inspect status because a successful poll can report a failed copy.',
  inputSchema: OneDriveCopyStatusInput,
  outputSchema: OneDriveCopyStatusOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const slot = yield* oneDriveWriteSlot(integration, input.driveId)
      yield* resolveMicrosoftAccessToken(integration, slot)
      const http = yield* ConnectorHttpClient

      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: input.monitorUrl,
          headers: { accept: 'application/json' },
          redirect: 'manual',
          credentials: 'omit'
        })
      )

      if (response.status === 303) {
        return ActionResult.success(OneDriveCopyStatusOutput.make({ status: 'completed' }))
      }

      if (response.status !== 200 && response.status !== 202) {
        return microsoftSanitizedProviderFailure({
          code: 'onedrive_get_copy_status_failed',
          message: 'Microsoft OneDrive get copy status failed',
          status: response.status,
          headers: response.headers
        })
      }

      const providerStatus = yield* decodeJsonResponse(OneDriveCopyStatusApi, response)
      const firstDetail = providerStatus.error?.details?.[0]
      const errorCode = providerStatus.error?.code ?? firstDetail?.code
      const errorMessage = providerStatus.error?.message ?? firstDetail?.message

      type OneDriveCopyStatusErrorFields = {
        code?: string
        message?: string
      }

      const errorFields: OneDriveCopyStatusErrorFields = {}

      if (errorCode !== undefined) errorFields.code = errorCode

      if (errorMessage !== undefined) errorFields.message = errorMessage

      type OneDriveCopyStatusOutputFields = {
        readonly status: OneDriveCopyStatus
        percentageComplete?: number
        itemId?: string
        error?: OneDriveCopyStatusError
      }

      const output: OneDriveCopyStatusOutputFields = { status: providerStatus.status }
      const percentageComplete = providerStatus.percentageComplete ?? providerStatus.percentComplete

      if (percentageComplete !== undefined) output.percentageComplete = percentageComplete

      if (providerStatus.resourceId !== undefined) output.itemId = providerStatus.resourceId

      if (errorCode !== undefined || errorMessage !== undefined) {
        output.error = OneDriveCopyStatusError.make(errorFields)
      }

      return ActionResult.success(OneDriveCopyStatusOutput.make(output))
    })
})

export const oneDriveDeleteItemAction = defineAction({
  id: 'onedrive.delete_item',
  description: 'Move a Microsoft OneDrive file or folder to the recycle bin.',
  access: 'destructive',
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
          headers: (() => {
            type OneDriveDeleteHeaders = {
              authorization: string
              accept: string
              'if-match'?: string
            }

            const headers: OneDriveDeleteHeaders = { ...oneDriveReadHeaders(token) }

            if (input.ifMatch !== undefined) {
              headers['if-match'] = input.ifMatch
            }

            return headers
          })()
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
  oneDriveMoveItemAction,
  oneDriveCopyItemAction,
  oneDriveGetCopyStatusAction,
  oneDriveDeleteItemAction
]
