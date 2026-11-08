import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  microsoftAuthorizationHeaders,
  microsoftConnectorId,
  MicrosoftSharePointSitesReadOAuthCredentialSlot
} from './oauth.ts'
import {
  isMicrosoftSuccessStatus,
  microsoftGraphApiBaseUrl,
  microsoftProviderFailure,
  resolveMicrosoftAccessToken
} from './shared.ts'

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())

const SharePointPageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 }))

// A site id is `{hostname},{site-collection-id},{web-id}`; a dot-only id would be normalized away.
const SharePointSiteId = NonEmptyString.check(
  Schema.makeFilter(value => !/^\.+$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value))
)

// Graph sends null for some unset site and drive properties; the public shapes omit them.
const OptionalWireString = Schema.optional(Schema.NullOr(Schema.String))

const present = (value: string | null | undefined) => (value === null ? undefined : value)

export class SharePointSite extends Schema.Class<SharePointSite>('SharePointSite')({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String)
}) {}

const SharePointSiteApi = Schema.Struct({
  id: Schema.String,
  name: OptionalWireString,
  displayName: OptionalWireString,
  description: OptionalWireString,
  webUrl: OptionalWireString,
  createdDateTime: OptionalWireString,
  lastModifiedDateTime: OptionalWireString
})

export class SharePointDrive extends Schema.Class<SharePointDrive>('SharePointDrive')({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  driveType: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String)
}) {}

const SharePointDriveApi = Schema.Struct({
  id: Schema.String,
  name: OptionalWireString,
  description: OptionalWireString,
  driveType: OptionalWireString,
  webUrl: OptionalWireString,
  createdDateTime: OptionalWireString,
  lastModifiedDateTime: OptionalWireString
})

type SiteFields = { -readonly [K in keyof SharePointSite]: SharePointSite[K] }

type DriveFields = { -readonly [K in keyof SharePointDrive]: SharePointDrive[K] }

const sharePointSite = (wire: typeof SharePointSiteApi.Type) => {
  const fields: SiteFields = { id: wire.id }

  for (const key of [
    'name',
    'displayName',
    'description',
    'webUrl',
    'createdDateTime',
    'lastModifiedDateTime'
  ] as const) {
    const value = present(wire[key])

    if (value !== undefined) fields[key] = value
  }

  return SharePointSite.make(fields)
}

const sharePointDrive = (wire: typeof SharePointDriveApi.Type) => {
  const fields: DriveFields = { id: wire.id }

  for (const key of [
    'name',
    'description',
    'driveType',
    'webUrl',
    'createdDateTime',
    'lastModifiedDateTime'
  ] as const) {
    const value = present(wire[key])

    if (value !== undefined) fields[key] = value
  }

  return SharePointDrive.make(fields)
}

const sharePointDriveSelect = [
  'id',
  'name',
  'description',
  'driveType',
  'webUrl',
  'createdDateTime',
  'lastModifiedDateTime'
].join(',')

export class SharePointSearchSitesInput extends Schema.Class<SharePointSearchSitesInput>(
  'SharePointSearchSitesInput'
)({
  query: NonEmptyString,
  top: Schema.optional(SharePointPageSize),
  nextLink: Schema.optional(Schema.String)
}) {}

export class SharePointSearchSitesOutput extends Schema.Class<SharePointSearchSitesOutput>(
  'SharePointSearchSitesOutput'
)({
  sites: Schema.Array(SharePointSite),
  nextLink: Schema.optional(Schema.String)
}) {}

export class SharePointListSiteDrivesInput extends Schema.Class<SharePointListSiteDrivesInput>(
  'SharePointListSiteDrivesInput'
)({
  siteId: SharePointSiteId,
  nextLink: Schema.optional(Schema.String)
}) {}

export class SharePointListSiteDrivesOutput extends Schema.Class<SharePointListSiteDrivesOutput>(
  'SharePointListSiteDrivesOutput'
)({
  drives: Schema.Array(SharePointDrive),
  nextLink: Schema.optional(Schema.String)
}) {}

const SharePointSitesApiOutput = Schema.Struct({
  value: Schema.Array(SharePointSiteApi),
  '@odata.nextLink': Schema.optional(Schema.String)
})

const SharePointDrivesApiOutput = Schema.Struct({
  value: Schema.Array(SharePointDriveApi),
  '@odata.nextLink': Schema.optional(Schema.String)
})

const invalidNextLink = (actionId: string) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: 'Microsoft Graph nextLink must target the selected SharePoint collection',
    connectorId: microsoftConnectorId,
    actionId
  })

const trustedGraphPathname = (nextLink: string) => {
  if (!URL.canParse(nextLink)) return undefined

  const parsed = new URL(nextLink)

  return parsed.protocol === 'https:' &&
    parsed.hostname === 'graph.microsoft.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''
    ? parsed.pathname
    : undefined
}

// Commas separate the parts of a site id and are valid in a path segment, so they stay literal.
const encodedSiteId = (siteId: string) => encodeURIComponent(siteId).replaceAll('%2C', ',')

const siteDrivesPathnames = (siteId: string) =>
  new Set([encodedSiteId(siteId), encodeURIComponent(siteId)].map(id => `/v1.0/sites/${id}/drives`))

const searchSitesUrl = (input: SharePointSearchSitesInput) => {
  if (input.nextLink !== undefined) {
    return trustedGraphPathname(input.nextLink) === '/v1.0/sites'
      ? Effect.succeed(input.nextLink)
      : Effect.fail(invalidNextLink('sharepoint.search_sites'))
  }

  const params = new URLSearchParams({ search: input.query })

  if (input.top !== undefined) params.set('$top', String(input.top))

  return Effect.succeed(`${microsoftGraphApiBaseUrl}/sites?${params.toString()}`)
}

const listSiteDrivesUrl = (input: SharePointListSiteDrivesInput) => {
  if (input.nextLink !== undefined) {
    const pathname = trustedGraphPathname(input.nextLink)

    return pathname !== undefined && siteDrivesPathnames(input.siteId).has(pathname)
      ? Effect.succeed(input.nextLink)
      : Effect.fail(invalidNextLink('sharepoint.list_site_drives'))
  }

  const params = new URLSearchParams({ $select: sharePointDriveSelect })

  return Effect.succeed(
    `${microsoftGraphApiBaseUrl}/sites/${encodedSiteId(input.siteId)}/drives?${params.toString()}`
  )
}

const getSharePointCollection = <Wire, Output>(input: {
  readonly integration: ConnectorIntegration
  readonly url: Effect.Effect<string, ConnectorError>
  readonly schema: Schema.Schema<Wire> & { readonly DecodingServices: never }
  readonly project: (decoded: Wire) => Output
  readonly code: string
  readonly message: string
}) =>
  Effect.gen(function* () {
    const token = yield* resolveMicrosoftAccessToken(
      input.integration,
      MicrosoftSharePointSitesReadOAuthCredentialSlot
    )

    const url = yield* input.url
    const http = yield* ConnectorHttpClient

    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url,
        headers: { ...microsoftAuthorizationHeaders(token), accept: 'application/json' }
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

    const decoded = yield* decodeJsonResponse(input.schema, response)

    return ActionResult.success(input.project(decoded))
  })

const nextLinkField = (nextLink: string | undefined) => (nextLink === undefined ? {} : { nextLink })

export const sharePointSearchSitesAction = defineAction({
  id: 'sharepoint.search_sites',
  description:
    'Search the SharePoint sites the signed-in user can access by keyword. Pass a returned site id to sharepoint.list_site_drives to find its document libraries.',
  inputSchema: SharePointSearchSitesInput,
  outputSchema: SharePointSearchSitesOutput,
  execute: ({ integration, input }) =>
    getSharePointCollection({
      integration,
      url: searchSitesUrl(input),
      schema: SharePointSitesApiOutput,
      project: output =>
        SharePointSearchSitesOutput.make({
          sites: output.value.map(sharePointSite),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      code: 'sharepoint_search_sites_failed',
      message: 'Microsoft SharePoint search sites failed'
    })
})

export const sharePointListSiteDrivesAction = defineAction({
  id: 'sharepoint.list_site_drives',
  description:
    'List the document libraries (drives) of one SharePoint site. Pass a returned drive id as driveId to the OneDrive list, search, and get actions.',
  inputSchema: SharePointListSiteDrivesInput,
  outputSchema: SharePointListSiteDrivesOutput,
  execute: ({ integration, input }) =>
    getSharePointCollection({
      integration,
      url: listSiteDrivesUrl(input),
      schema: SharePointDrivesApiOutput,
      project: output =>
        SharePointListSiteDrivesOutput.make({
          drives: output.value.map(sharePointDrive),
          ...nextLinkField(output['@odata.nextLink'])
        }),
      code: 'sharepoint_list_site_drives_failed',
      message: 'Microsoft SharePoint list site drives failed'
    })
})

export const sharePointActions = [sharePointSearchSitesAction, sharePointListSiteDrivesAction]
