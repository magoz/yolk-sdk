/**
 * Drive routes of the Google emulator (internal): the folder listing with page tokens, file reads
 * with the connector's full `fields` selection, and the lifecycle of a run-scoped folder (create,
 * trash, permanent delete, and the recorded 404 afterwards).
 *
 * Every answer comes from the Drive fixtures, through the seed or the request, or is minted (folder
 * ids, page tokens, and `createdTime` / `modifiedTime` / `trashedTime` from the injectable clock).
 * Every Drive request must send `accept: application/json`, as the fixtures record.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactBodyKeys,
  exactQuery,
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type EmulatedRequest,
  type NotEmulated
} from '../stateful-emulator.ts'
import {
  answer,
  evidence,
  googleEmulatorApisOrigin,
  googleErrorBody,
  googleJson,
  googleNoContent,
  isRunText,
  listPage,
  pageSize,
  param,
  recordedValue,
  type GoogleRoute
} from './shared.ts'
import {
  driveFile,
  driveFolderMimeType,
  mintedFolderId,
  mintedFolderIdPattern,
  type GoogleEmulatorDriveFile,
  type GoogleEmulatorState
} from './state.ts'

const listCase = 'google.drive.list-page-token'

const fieldsCase = 'google.drive.get-file-fields'

const folderCase = 'google.drive.folder-trash-delete'

const fileIdSegment = /^[A-Za-z0-9_-]{10,200}$/

const drive = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  withFile: boolean
) =>
  evidence(
    googleEmulatorApisOrigin,
    method,
    `/drive/v3/files${path}`,
    write,
    caseIds,
    withFile ? { fileId: fileIdSegment } : {}
  )

/**
 * The file `fields` selection the connector sends (a data copy of `googleDriveFileFields`; the
 * fixture URLs carry it, so the drift test fails when it changes).
 */
const fileFields = [
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

const listFields = `kind,nextPageToken,incompleteSearch,files(${fileFields})`

const parentQueryPattern = /^'([A-Za-z0-9_-]{10,200})' in parents and trashed = false$/

// Rendering, in the fixture key order.

type FileHead = {
  readonly kind: string
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly starred: boolean
  readonly trashed: boolean
  readonly explicitlyTrashed: boolean
  trashedTime?: string
}

type FileListHead = {
  readonly kind: string
  readonly incompleteSearch: boolean
  nextPageToken?: string
}

const renderFile = (file: GoogleEmulatorDriveFile, withoutParents = false): Schema.JsonObject => {
  const head: FileHead = {
    kind: 'drive#file',
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    starred: file.starred,
    trashed: file.trashed,
    explicitlyTrashed: file.explicitlyTrashed
  }

  // Drive answers `trashedTime` only for a trashed item.
  if (file.trashedTime !== undefined) head.trashedTime = file.trashedTime

  return {
    ...head,
    parents: withoutParents ? [] : [...file.parents],
    spaces: [...file.spaces],
    version: file.version,
    webViewLink: file.webViewLink,
    iconLink: file.iconLink,
    hasThumbnail: file.hasThumbnail,
    viewedByMe: file.viewedByMe,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    ownedByMe: file.ownedByMe,
    shared: file.shared,
    writersCanShare: file.writersCanShare,
    capabilities: file.capabilities
  }
}

/** Every Drive request sends `accept: application/json`, as the fixtures record. */
const acceptsJson = (request: EmulatedRequest): NotEmulated | undefined =>
  request.header('accept') === 'application/json'
    ? undefined
    : notEmulated('Drive requests without accept: application/json are not emulated')

/** The `supportsAllDrives=true&fields=<file fields>` query of file reads and writes. */
const fileQuery = (request: EmulatedRequest): NotEmulated | undefined => {
  const query = exactQuery(request, ['supportsAllDrives', 'fields'])

  if (isNotEmulated(query)) return query

  return (
    recordedValue(query, 'supportsAllDrives', 'true') ??
    (query['fields'] === fileFields
      ? undefined
      : notEmulated('a fields selection other than the connector one is not emulated'))
  )
}

const findFile = (state: GoogleEmulatorState, id: string) =>
  state.files.find(file => file.id === id)

/** A folder items can live in: an implied folder or a stored untrashed folder. */
const isLiveFolder = (state: GoogleEmulatorState, id: string): boolean => {
  const folder = findFile(state, id)

  return (
    state.impliedFolderIds.includes(id) ||
    (folder !== undefined && folder.mimeType === driveFolderMimeType && !folder.trashed)
  )
}

const isCreatedHere = (file: GoogleEmulatorDriveFile): boolean =>
  mintedFolderIdPattern.test(file.id)

// Listing.

type ListInput = {
  readonly parentId: string
  readonly pageSize: number
  readonly pageToken: string | undefined
}

const listFiles: GoogleRoute = statefulRoute(
  drive('GET', '', false, [listCase, fieldsCase, folderCase], false),
  'none',
  (request): ListInput | NotEmulated => {
    const accepts = acceptsJson(request)

    if (accepts !== undefined) return accepts

    const query = exactQuery(
      request,
      [
        'pageSize',
        'q',
        'spaces',
        'supportsAllDrives',
        'includeItemsFromAllDrives',
        'corpora',
        'fields'
      ],
      ['pageToken']
    )

    if (isNotEmulated(query)) return query

    const recorded =
      recordedValue(query, 'spaces', 'drive') ??
      recordedValue(query, 'supportsAllDrives', 'true') ??
      recordedValue(query, 'includeItemsFromAllDrives', 'true') ??
      recordedValue(query, 'corpora', 'user') ??
      (query['fields'] === listFields
        ? undefined
        : notEmulated('a fields selection other than the connector one is not emulated'))

    if (recorded !== undefined) return recorded

    const parentId = parentQueryPattern.exec(query['q'] ?? '')?.[1]

    if (parentId === undefined) {
      return notEmulated(`q other than '<folder>' in parents and trashed = false is not emulated`)
    }

    const size = pageSize(query['pageSize'], 'pageSize', 1, 1000)

    if (isNotEmulated(size)) return size

    const pageToken = query['pageToken']

    return pageToken === ''
      ? notEmulated('an empty pageToken is not emulated')
      : { parentId, pageSize: size, pageToken }
  },
  (state, input, { env }) => {
    if (!isLiveFolder(state, input.parentId)) {
      return notEmulated('listing anything but a folder the state holds is not emulated')
    }

    const children = state.files.filter(
      file =>
        file.parents.includes(input.parentId) && (env.drills.listIncludesTrashed || !file.trashed)
    )

    // Every recorded listing has children; an empty one is no fixture's answer.
    if (children.length === 0) {
      return notEmulated('a folder listing without items is not emulated (no fixture records one)')
    }

    return listPage(
      env,
      'drive',
      `drive\u0000${input.parentId}\u0000${input.pageSize}`,
      children.map(file => renderFile(file)),
      input.pageSize,
      input.pageToken,
      env.drills.drivePageRepeats,
      (page, nextPageToken) => {
        const head: FileListHead = { kind: 'drive#fileList', incompleteSearch: false }

        // The last page carries no `nextPageToken`.
        if (nextPageToken !== undefined) head.nextPageToken = nextPageToken

        return googleJson(200, { ...head, files: [...page] })
      }
    )
  }
)

// File reads and the folder lifecycle.

const getFile: GoogleRoute = statefulRoute(
  drive('GET', '/{fileId}', false, [fieldsCase, folderCase], true),
  'none',
  request => acceptsJson(request) ?? fileQuery(request) ?? param(request, 'fileId'),
  (state, id, { env }) => {
    const file = findFile(state, id)

    if (file !== undefined) {
      return answer(() => googleJson(200, renderFile(file, env.drills.getFileWithoutParents)))
    }

    if (state.impliedFolderIds.includes(id)) {
      return notEmulated('reading a folder a fixture only names is not emulated')
    }

    // The recorded not-found answer of an item the account does not hold.
    return answer(() =>
      googleJson(404, googleErrorBody(404, `File not found: ${id}.`, 'notFound', 'NOT_FOUND'))
    )
  }
)

type CreateInput = { readonly name: string; readonly parentId: string }

const createFolder: GoogleRoute = statefulRoute(
  drive('POST', '', true, [folderCase], false),
  'json',
  (request): CreateInput | NotEmulated => {
    const body =
      acceptsJson(request) ??
      fileQuery(request) ??
      exactBodyKeys(request.json, 'the create body', ['name', 'mimeType', 'parents'])

    if (isNotEmulated(body)) return body

    const name = Predicate.isString(body.name) ? body.name : ''

    if (!isRunText(name, 'folder')) {
      return notEmulated('a folder name other than "yolk-conformance <runId> folder"')
    }

    if (body.mimeType !== driveFolderMimeType) {
      return notEmulated('creating anything but a folder is not emulated')
    }

    const parents = body.parents

    return Array.isArray(parents) && parents.length === 1 && Predicate.isString(parents[0])
      ? { name, parentId: parents[0] }
      : notEmulated('a create with other than one parent is not emulated')
  },
  (state, input, { env }) => {
    if (!isLiveFolder(state, input.parentId)) {
      return notEmulated('creating a folder outside a folder the state holds is not emulated')
    }

    return () => {
      // Read the clock before any write: a failing clock writes nothing.
      const at = new Date(env.now()).toISOString()
      const number = state.counters.nextFolderNumber

      const folder = driveFile({
        id: mintedFolderId(number),
        name: input.name,
        mimeType: driveFolderMimeType,
        parents: [input.parentId],
        createdTime: at
      })

      state.counters = { ...state.counters, nextFolderNumber: number + 1 }
      state.files = [...state.files, folder]

      return googleJson(200, renderFile(folder))
    }
  }
)

const trashFile: GoogleRoute = statefulRoute(
  drive('PATCH', '/{fileId}', true, [folderCase], true),
  'json',
  (request): string | NotEmulated => {
    const body =
      acceptsJson(request) ??
      fileQuery(request) ??
      exactBodyKeys(request.json, 'the update body', ['trashed'])

    if (isNotEmulated(body)) return body

    return body.trashed === true
      ? param(request, 'fileId')
      : notEmulated('updates other than { trashed: true } are not emulated')
  },
  (state, id, { env }) => {
    const file = findFile(state, id)

    if (file === undefined || !isCreatedHere(file) || file.trashed) {
      return notEmulated('trashing anything but a live folder created here is not emulated')
    }

    return () => {
      const at = new Date(env.now()).toISOString()

      const trashed: GoogleEmulatorDriveFile = {
        ...file,
        trashed: true,
        explicitlyTrashed: true,
        trashedTime: at
      }

      state.files = state.files.map(candidate => (candidate.id === id ? trashed : candidate))

      return googleJson(200, renderFile(trashed))
    }
  }
)

const deleteFile: GoogleRoute = statefulRoute(
  drive('DELETE', '/{fileId}', true, [folderCase], true),
  'none',
  (request): string | NotEmulated => {
    const accepts = acceptsJson(request)

    if (accepts !== undefined) return accepts

    const query = exactQuery(request, ['supportsAllDrives'])

    if (isNotEmulated(query)) return query

    return recordedValue(query, 'supportsAllDrives', 'true') ?? param(request, 'fileId')
  },
  (state, id) => {
    const file = findFile(state, id)

    if (file === undefined || !isCreatedHere(file)) {
      return notEmulated('deleting anything but a folder created here is not emulated')
    }

    if (state.files.some(candidate => candidate.parents.includes(id))) {
      return notEmulated('deleting a folder that holds items is not emulated')
    }

    return () => {
      state.files = state.files.filter(candidate => candidate.id !== id)

      return googleNoContent()
    }
  }
)

/** The Drive routes, in manifest order. */
export const driveRoutes: ReadonlyArray<GoogleRoute> = [
  listFiles,
  createFolder,
  getFile,
  trashFile,
  deleteFile
]
