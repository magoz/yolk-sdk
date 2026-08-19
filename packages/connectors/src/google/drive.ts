import { Chunk, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import {
  GoogleDriveFileOAuthCredentialSlot,
  GoogleDriveMetadataReadonlyOAuthCredentialSlot,
  googleAuthorizationHeaders
} from './oauth.ts'
import {
  appendNumberSearchParam,
  appendSearchParam,
  isSuccessStatus,
  providerFailureFromResponse,
  resolveGoogleAccessToken
} from './shared.ts'

export const googleDriveApiBaseUrl = 'https://www.googleapis.com/drive/v3'
export const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())
const GoogleDriveHeaderValue = NonEmptyString.check(Schema.isPattern(/^[^\r\n]+$/))
const GoogleDrivePageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))

const parentResourceKeyRequiresParentId = Schema.makeFilter<{
  readonly parentId?: string
  readonly parentResourceKey?: string
}>(input =>
  input.parentResourceKey === undefined || input.parentId !== undefined
    ? undefined
    : { path: ['parentResourceKey'], issue: 'parentResourceKey requires parentId' }
)

export class GoogleDriveUser extends Schema.Class<GoogleDriveUser>('GoogleDriveUser')({
  displayName: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  me: Schema.optional(Schema.Boolean),
  permissionId: Schema.optional(Schema.String),
  emailAddress: Schema.optional(Schema.String),
  photoLink: Schema.optional(Schema.String)
}) {}

export class GoogleDriveCapabilities extends Schema.Class<GoogleDriveCapabilities>(
  'GoogleDriveCapabilities'
)({
  canAddChildren: Schema.optional(Schema.Boolean),
  canDelete: Schema.optional(Schema.Boolean),
  canDeleteChildren: Schema.optional(Schema.Boolean),
  canDownload: Schema.optional(Schema.Boolean),
  canEdit: Schema.optional(Schema.Boolean),
  canMoveItemOutOfDrive: Schema.optional(Schema.Boolean),
  canMoveItemWithinDrive: Schema.optional(Schema.Boolean),
  canRename: Schema.optional(Schema.Boolean),
  canTrash: Schema.optional(Schema.Boolean),
  canTrashChildren: Schema.optional(Schema.Boolean),
  canUntrash: Schema.optional(Schema.Boolean)
}) {}

export class GoogleDriveShortcutDetails extends Schema.Class<GoogleDriveShortcutDetails>(
  'GoogleDriveShortcutDetails'
)({
  targetId: Schema.optional(Schema.String),
  targetMimeType: Schema.optional(Schema.String),
  targetResourceKey: Schema.optional(Schema.String)
}) {}

export class GoogleDriveContentRestriction extends Schema.Class<GoogleDriveContentRestriction>(
  'GoogleDriveContentRestriction'
)({
  readOnly: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  restrictingUser: Schema.optional(GoogleDriveUser),
  restrictionTime: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String)
}) {}

export class GoogleDriveLinkShareMetadata extends Schema.Class<GoogleDriveLinkShareMetadata>(
  'GoogleDriveLinkShareMetadata'
)({
  securityUpdateEligible: Schema.optional(Schema.Boolean),
  securityUpdateEnabled: Schema.optional(Schema.Boolean)
}) {}

export class GoogleDriveFile extends Schema.Class<GoogleDriveFile>('GoogleDriveFile')({
  kind: Schema.optional(Schema.String),
  driveId: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  description: Schema.optional(Schema.String),
  starred: Schema.optional(Schema.Boolean),
  trashed: Schema.optional(Schema.Boolean),
  explicitlyTrashed: Schema.optional(Schema.Boolean),
  trashedTime: Schema.optional(Schema.String),
  trashingUser: Schema.optional(GoogleDriveUser),
  parents: Schema.optional(Schema.Chunk(Schema.String)),
  spaces: Schema.optional(Schema.Chunk(Schema.String)),
  version: Schema.optional(Schema.String),
  webContentLink: Schema.optional(Schema.String),
  webViewLink: Schema.optional(Schema.String),
  iconLink: Schema.optional(Schema.String),
  hasThumbnail: Schema.optional(Schema.Boolean),
  thumbnailLink: Schema.optional(Schema.String),
  thumbnailVersion: Schema.optional(Schema.String),
  viewedByMe: Schema.optional(Schema.Boolean),
  viewedByMeTime: Schema.optional(Schema.String),
  createdTime: Schema.optional(Schema.String),
  modifiedTime: Schema.optional(Schema.String),
  modifiedByMeTime: Schema.optional(Schema.String),
  sharedWithMeTime: Schema.optional(Schema.String),
  ownedByMe: Schema.optional(Schema.Boolean),
  shared: Schema.optional(Schema.Boolean),
  owners: Schema.optional(Schema.Chunk(GoogleDriveUser)),
  permissionIds: Schema.optional(Schema.Chunk(Schema.String)),
  lastModifyingUser: Schema.optional(GoogleDriveUser),
  sharingUser: Schema.optional(GoogleDriveUser),
  size: Schema.optional(Schema.String),
  quotaBytesUsed: Schema.optional(Schema.String),
  md5Checksum: Schema.optional(Schema.String),
  sha1Checksum: Schema.optional(Schema.String),
  sha256Checksum: Schema.optional(Schema.String),
  fileExtension: Schema.optional(Schema.String),
  fullFileExtension: Schema.optional(Schema.String),
  originalFilename: Schema.optional(Schema.String),
  headRevisionId: Schema.optional(Schema.String),
  folderColorRgb: Schema.optional(Schema.String),
  resourceKey: Schema.optional(Schema.String),
  copyRequiresWriterPermission: Schema.optional(Schema.Boolean),
  writersCanShare: Schema.optional(Schema.Boolean),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  appProperties: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  capabilities: Schema.optional(GoogleDriveCapabilities),
  shortcutDetails: Schema.optional(GoogleDriveShortcutDetails),
  contentRestrictions: Schema.optional(Schema.Chunk(GoogleDriveContentRestriction)),
  linkShareMetadata: Schema.optional(GoogleDriveLinkShareMetadata)
}) {}

const GoogleDriveFileApi = Schema.Struct({
  kind: Schema.optional(Schema.String),
  driveId: Schema.optional(Schema.String),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  description: Schema.optional(Schema.String),
  starred: Schema.optional(Schema.Boolean),
  trashed: Schema.optional(Schema.Boolean),
  explicitlyTrashed: Schema.optional(Schema.Boolean),
  trashedTime: Schema.optional(Schema.String),
  trashingUser: Schema.optional(GoogleDriveUser),
  parents: Schema.optional(Schema.Array(Schema.String)),
  spaces: Schema.optional(Schema.Array(Schema.String)),
  version: Schema.optional(Schema.String),
  webContentLink: Schema.optional(Schema.String),
  webViewLink: Schema.optional(Schema.String),
  iconLink: Schema.optional(Schema.String),
  hasThumbnail: Schema.optional(Schema.Boolean),
  thumbnailLink: Schema.optional(Schema.String),
  thumbnailVersion: Schema.optional(Schema.String),
  viewedByMe: Schema.optional(Schema.Boolean),
  viewedByMeTime: Schema.optional(Schema.String),
  createdTime: Schema.optional(Schema.String),
  modifiedTime: Schema.optional(Schema.String),
  modifiedByMeTime: Schema.optional(Schema.String),
  sharedWithMeTime: Schema.optional(Schema.String),
  ownedByMe: Schema.optional(Schema.Boolean),
  shared: Schema.optional(Schema.Boolean),
  owners: Schema.optional(Schema.Array(GoogleDriveUser)),
  permissionIds: Schema.optional(Schema.Array(Schema.String)),
  lastModifyingUser: Schema.optional(GoogleDriveUser),
  sharingUser: Schema.optional(GoogleDriveUser),
  size: Schema.optional(Schema.String),
  quotaBytesUsed: Schema.optional(Schema.String),
  md5Checksum: Schema.optional(Schema.String),
  sha1Checksum: Schema.optional(Schema.String),
  sha256Checksum: Schema.optional(Schema.String),
  fileExtension: Schema.optional(Schema.String),
  fullFileExtension: Schema.optional(Schema.String),
  originalFilename: Schema.optional(Schema.String),
  headRevisionId: Schema.optional(Schema.String),
  folderColorRgb: Schema.optional(Schema.String),
  resourceKey: Schema.optional(Schema.String),
  copyRequiresWriterPermission: Schema.optional(Schema.Boolean),
  writersCanShare: Schema.optional(Schema.Boolean),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  appProperties: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  capabilities: Schema.optional(GoogleDriveCapabilities),
  shortcutDetails: Schema.optional(GoogleDriveShortcutDetails),
  contentRestrictions: Schema.optional(Schema.Array(GoogleDriveContentRestriction)),
  linkShareMetadata: Schema.optional(GoogleDriveLinkShareMetadata)
})
type GoogleDriveFileApi = typeof GoogleDriveFileApi.Type

const googleDriveFileFromApi = (file: GoogleDriveFileApi): GoogleDriveFile => {
  const { parents, spaces, owners, permissionIds, contentRestrictions, ...metadata } = file
  return GoogleDriveFile.make({
    ...metadata,
    ...(parents === undefined ? {} : { parents: Chunk.fromIterable(parents) }),
    ...(spaces === undefined ? {} : { spaces: Chunk.fromIterable(spaces) }),
    ...(owners === undefined ? {} : { owners: Chunk.fromIterable(owners) }),
    ...(permissionIds === undefined ? {} : { permissionIds: Chunk.fromIterable(permissionIds) }),
    ...(contentRestrictions === undefined
      ? {}
      : { contentRestrictions: Chunk.fromIterable(contentRestrictions) })
  })
}

export class GoogleDriveListFilesInput extends Schema.Class<GoogleDriveListFilesInput>(
  'GoogleDriveListFilesInput'
)({
  parentId: Schema.optional(GoogleDriveHeaderValue),
  parentResourceKey: Schema.optional(GoogleDriveHeaderValue),
  driveId: Schema.optional(NonEmptyString),
  pageSize: Schema.optional(GoogleDrivePageSize),
  pageToken: Schema.optional(NonEmptyString),
  orderBy: Schema.optional(NonEmptyString),
  includeTrashed: Schema.optional(Schema.Boolean)
}) {}

const GoogleDriveListFilesActionInput = GoogleDriveListFilesInput.check(
  parentResourceKeyRequiresParentId
)

export class GoogleDriveSearchFilesInput extends Schema.Class<GoogleDriveSearchFilesInput>(
  'GoogleDriveSearchFilesInput'
)({
  query: NonEmptyString,
  parentId: Schema.optional(GoogleDriveHeaderValue),
  parentResourceKey: Schema.optional(GoogleDriveHeaderValue),
  driveId: Schema.optional(NonEmptyString),
  pageSize: Schema.optional(GoogleDrivePageSize),
  pageToken: Schema.optional(NonEmptyString),
  orderBy: Schema.optional(NonEmptyString),
  includeTrashed: Schema.optional(Schema.Boolean)
}) {}

const GoogleDriveSearchFilesActionInput = GoogleDriveSearchFilesInput.check(
  parentResourceKeyRequiresParentId
)

export class GoogleDriveListFilesOutput extends Schema.Class<GoogleDriveListFilesOutput>(
  'GoogleDriveListFilesOutput'
)({
  files: Schema.Chunk(GoogleDriveFile),
  nextPageToken: Schema.optional(Schema.String),
  incompleteSearch: Schema.optional(Schema.Boolean),
  kind: Schema.optional(Schema.String)
}) {}

const GoogleDriveListFilesApiOutput = Schema.Struct({
  files: Schema.optional(Schema.Array(GoogleDriveFileApi)),
  nextPageToken: Schema.optional(Schema.String),
  incompleteSearch: Schema.optional(Schema.Boolean),
  kind: Schema.optional(Schema.String)
})

const googleDriveListFilesOutputFromApi = (
  output: typeof GoogleDriveListFilesApiOutput.Type
): GoogleDriveListFilesOutput =>
  GoogleDriveListFilesOutput.make({
    files: Chunk.fromIterable((output.files ?? []).map(googleDriveFileFromApi)),
    ...(output.nextPageToken === undefined ? {} : { nextPageToken: output.nextPageToken }),
    ...(output.incompleteSearch === undefined ? {} : { incompleteSearch: output.incompleteSearch }),
    ...(output.kind === undefined ? {} : { kind: output.kind })
  })

export class GoogleDriveFileIdInput extends Schema.Class<GoogleDriveFileIdInput>(
  'GoogleDriveFileIdInput'
)({
  fileId: GoogleDriveHeaderValue,
  resourceKey: Schema.optional(GoogleDriveHeaderValue)
}) {}

export class GoogleDriveCreateFolderInput extends Schema.Class<GoogleDriveCreateFolderInput>(
  'GoogleDriveCreateFolderInput'
)({
  name: NonEmptyString,
  parentId: Schema.optional(GoogleDriveHeaderValue),
  parentResourceKey: Schema.optional(GoogleDriveHeaderValue)
}) {}

const GoogleDriveCreateFolderActionInput = GoogleDriveCreateFolderInput.check(
  parentResourceKeyRequiresParentId
)

export class GoogleDriveDeleteFileOutput extends Schema.Class<GoogleDriveDeleteFileOutput>(
  'GoogleDriveDeleteFileOutput'
)({
  deleted: Schema.Boolean,
  fileId: Schema.String
}) {}

export const googleDriveFileFields = [
  'kind',
  'driveId',
  'id',
  'name',
  'mimeType',
  'description',
  'starred',
  'trashed',
  'explicitlyTrashed',
  'trashedTime',
  'trashingUser',
  'parents',
  'spaces',
  'version',
  'webContentLink',
  'webViewLink',
  'iconLink',
  'hasThumbnail',
  'thumbnailLink',
  'thumbnailVersion',
  'viewedByMe',
  'viewedByMeTime',
  'createdTime',
  'modifiedTime',
  'modifiedByMeTime',
  'sharedWithMeTime',
  'ownedByMe',
  'shared',
  'owners',
  'permissionIds',
  'lastModifyingUser',
  'sharingUser',
  'size',
  'quotaBytesUsed',
  'md5Checksum',
  'sha1Checksum',
  'sha256Checksum',
  'fileExtension',
  'fullFileExtension',
  'originalFilename',
  'headRevisionId',
  'folderColorRgb',
  'resourceKey',
  'copyRequiresWriterPermission',
  'writersCanShare',
  'properties',
  'appProperties',
  'capabilities',
  'shortcutDetails',
  'contentRestrictions',
  'linkShareMetadata'
].join(',')

const googleDriveListFields = `kind,nextPageToken,incompleteSearch,files(${googleDriveFileFields})`

const googleDriveReadHeaders = (token: string) => ({
  ...googleAuthorizationHeaders(token),
  accept: 'application/json'
})

const googleDriveResourceKeyHeaders = (
  fileId: string | undefined,
  resourceKey: string | undefined
): Readonly<Record<string, string>> =>
  fileId === undefined || resourceKey === undefined
    ? {}
    : { 'x-goog-drive-resource-keys': `${fileId}/${resourceKey}` }

const googleDriveWriteHeaders = (token: string) => ({
  ...googleDriveReadHeaders(token),
  'content-type': 'application/json'
})

const escapeDriveQueryValue = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

const driveQueryClauses = (input: {
  readonly parentId?: string
  readonly includeTrashed?: boolean
}) => [
  ...(input.parentId === undefined
    ? []
    : [`'${escapeDriveQueryValue(input.parentId)}' in parents`]),
  ...(input.includeTrashed === true ? [] : ['trashed = false'])
]

const driveFilesUrl = (input: {
  readonly parentId?: string
  readonly driveId?: string
  readonly pageSize?: number
  readonly pageToken?: string
  readonly orderBy?: string
  readonly includeTrashed?: boolean
  readonly searchQuery?: string
}) => {
  const params = new URLSearchParams()
  appendNumberSearchParam(params, 'pageSize', input.pageSize)
  appendSearchParam(params, 'pageToken', input.pageToken)
  appendSearchParam(params, 'orderBy', input.orderBy)

  const clauses = driveQueryClauses(input)
  if (input.searchQuery !== undefined) {
    const query = escapeDriveQueryValue(input.searchQuery)
    clauses.unshift(`(name contains '${query}' or fullText contains '${query}')`)
  }
  if (clauses.length > 0) params.set('q', clauses.join(' and '))

  params.set('spaces', 'drive')
  params.set('supportsAllDrives', 'true')
  params.set('includeItemsFromAllDrives', 'true')
  params.set('corpora', input.driveId === undefined ? 'user' : 'drive')
  if (input.driveId !== undefined) params.set('driveId', input.driveId)
  params.set('fields', googleDriveListFields)
  return `${googleDriveApiBaseUrl}/files?${params.toString()}`
}

const googleDriveListAction = (input: {
  readonly integration: ConnectorIntegration
  readonly url: string
  readonly code: string
  readonly message: string
  readonly resourceKeyFileId?: string
  readonly resourceKey?: string
}) =>
  Effect.gen(function* () {
    const token = yield* resolveGoogleAccessToken(
      input.integration,
      GoogleDriveMetadataReadonlyOAuthCredentialSlot
    )
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url: input.url,
        headers: {
          ...googleDriveReadHeaders(token),
          ...googleDriveResourceKeyHeaders(input.resourceKeyFileId, input.resourceKey)
        }
      })
    )

    if (!isSuccessStatus(response.status)) {
      return yield* providerFailureFromResponse({
        code: input.code,
        message: input.message,
        status: response.status,
        headers: response.headers,
        body: response.body
      })
    }

    const output = yield* decodeJsonResponse(GoogleDriveListFilesApiOutput, response)
    return ActionResult.success(googleDriveListFilesOutputFromApi(output))
  })

export const googleDriveListFilesAction = defineAction({
  id: 'drive.list_files',
  description: 'List Google Drive file and folder metadata, optionally within a parent folder.',
  inputSchema: GoogleDriveListFilesActionInput,
  outputSchema: GoogleDriveListFilesOutput,
  execute: ({ integration, input }) =>
    googleDriveListAction({
      integration,
      url: driveFilesUrl(input),
      code: 'drive_list_files_failed',
      message: 'Google Drive list files failed',
      resourceKeyFileId: input.parentId,
      resourceKey: input.parentResourceKey
    })
})

export const googleDriveSearchFilesAction = defineAction({
  id: 'drive.search_files',
  description: 'Search Google Drive file names and indexed text.',
  inputSchema: GoogleDriveSearchFilesActionInput,
  outputSchema: GoogleDriveListFilesOutput,
  execute: ({ integration, input }) =>
    googleDriveListAction({
      integration,
      url: driveFilesUrl({ ...input, searchQuery: input.query }),
      code: 'drive_search_files_failed',
      message: 'Google Drive search files failed',
      resourceKeyFileId: input.parentId,
      resourceKey: input.parentResourceKey
    })
})

export const googleDriveGetFileAction = defineAction({
  id: 'drive.get_file',
  description: 'Get Google Drive metadata for one file or folder by id.',
  inputSchema: GoogleDriveFileIdInput,
  outputSchema: GoogleDriveFile,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(
        integration,
        GoogleDriveMetadataReadonlyOAuthCredentialSlot
      )
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: googleDriveFileFields
      })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${googleDriveApiBaseUrl}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`,
          headers: {
            ...googleDriveReadHeaders(token),
            ...googleDriveResourceKeyHeaders(input.fileId, input.resourceKey)
          }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'drive_get_file_failed',
          message: 'Google Drive get file failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleDriveFileApi, response)
      return ActionResult.success(googleDriveFileFromApi(output))
    })
})

export const googleDriveCreateFolderAction = defineAction({
  id: 'drive.create_folder',
  description: 'Create a Google Drive folder, optionally within a parent folder.',
  access: 'write',
  inputSchema: GoogleDriveCreateFolderActionInput,
  outputSchema: GoogleDriveFile,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration, GoogleDriveFileOAuthCredentialSlot)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: googleDriveFileFields
      })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${googleDriveApiBaseUrl}/files?${params.toString()}`,
          headers: {
            ...googleDriveWriteHeaders(token),
            ...googleDriveResourceKeyHeaders(input.parentId, input.parentResourceKey)
          },
          body: JSON.stringify({
            name: input.name,
            mimeType: googleDriveFolderMimeType,
            ...(input.parentId === undefined ? {} : { parents: [input.parentId] })
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'drive_create_folder_failed',
          message: 'Google Drive create folder failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleDriveFileApi, response)
      return ActionResult.success(googleDriveFileFromApi(output))
    })
})

export const googleDriveTrashFileAction = defineAction({
  id: 'drive.trash_file',
  description: 'Move a Google Drive file or folder to trash.',
  access: 'destructive',
  inputSchema: GoogleDriveFileIdInput,
  outputSchema: GoogleDriveFile,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration, GoogleDriveFileOAuthCredentialSlot)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: googleDriveFileFields
      })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'PATCH',
          url: `${googleDriveApiBaseUrl}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`,
          headers: {
            ...googleDriveWriteHeaders(token),
            ...googleDriveResourceKeyHeaders(input.fileId, input.resourceKey)
          },
          body: JSON.stringify({ trashed: true })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'drive_trash_file_failed',
          message: 'Google Drive trash file failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      const output = yield* decodeJsonResponse(GoogleDriveFileApi, response)
      return ActionResult.success(googleDriveFileFromApi(output))
    })
})

export const googleDriveDeleteFileAction = defineAction({
  id: 'drive.delete_file',
  description: 'Permanently delete a Google Drive file or folder without moving it to trash.',
  access: 'destructive',
  inputSchema: GoogleDriveFileIdInput,
  outputSchema: GoogleDriveDeleteFileOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveGoogleAccessToken(integration, GoogleDriveFileOAuthCredentialSlot)
      const http = yield* ConnectorHttpClient
      const params = new URLSearchParams({ supportsAllDrives: 'true' })
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'DELETE',
          url: `${googleDriveApiBaseUrl}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`,
          headers: {
            ...googleDriveReadHeaders(token),
            ...googleDriveResourceKeyHeaders(input.fileId, input.resourceKey)
          }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return yield* providerFailureFromResponse({
          code: 'drive_delete_file_failed',
          message: 'Google Drive delete file failed',
          status: response.status,
          headers: response.headers,
          body: response.body
        })
      }

      return ActionResult.success(
        GoogleDriveDeleteFileOutput.make({ deleted: true, fileId: input.fileId })
      )
    })
})

export const googleDriveActions = [
  googleDriveListFilesAction,
  googleDriveSearchFilesAction,
  googleDriveGetFileAction,
  googleDriveCreateFolderAction,
  googleDriveTrashFileAction,
  googleDriveDeleteFileAction
]
