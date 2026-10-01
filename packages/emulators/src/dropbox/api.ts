/**
 * Dropbox emulator API: the route table (evidence, request-shape checks, and stateful handlers),
 * the fixture error envelopes, metadata rendering, and list and search cursors (internal;
 * re-exported by `src/dropbox.ts`).
 *
 * Only the RPC and upload routes the eight Dropbox conformance cases (and their cleanup) send are
 * emulated, with the wire shapes of their synthetic fixtures. Every route is a `POST` under `/2`: the RPC routes on `api.dropboxapi.com` with a JSON body, the
 * upload on `content.dropboxapi.com` with an `application/octet-stream` body and a
 * `Dropbox-API-Arg` header, each only on the origin its fixtures record. Route errors are the
 * fixtures' HTTP 409 `error_summary` envelopes, copied byte for byte. Every route plans first
 * (reading the state, writing nothing) and commits only an eligible request: anything no fixture
 * shows is not emulated (400, nothing written, no fault used up).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactObject,
  integerIn,
  isNotEmulated,
  jsonResponse,
  mediaType,
  notEmulated,
  parseJsonText,
  statefulRoute,
  type Commit,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import {
  syntheticContentHash,
  type DropboxEmulatorDeleted,
  type DropboxEmulatorEntry,
  type DropboxEmulatorFile,
  type DropboxEmulatorState
} from './state.ts'

/** API version prefix of every Dropbox route. */
export const dropboxEmulatorBasePath = '/2'

/**
 * The fixture error envelopes, byte for byte (`not-found-envelope.ts`, `create-folder-conflict.ts`,
 * and `upload-rev-precondition.ts`), each answered with HTTP 409.
 */
export const dropboxEmulatorErrorBodies = {
  notFound:
    '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}',
  folderConflict:
    '{"error_summary": "path/conflict/folder/..", "error": {".tag": "path", "path": {".tag": "conflict", "conflict": {".tag": "folder"}}}}',
  uploadConflict:
    '{"error_summary": "path/conflict/file/..", "error": {".tag": "path", "path": {"reason": {".tag": "conflict", "conflict": {".tag": "file"}}}}}'
} as const

// Drill-only envelopes (tests only): each disagrees with one claim.
const drillErrorBodies = {
  notFoundAsPathLookup:
    '{"error_summary": "path_lookup/not_found/.", "error": {".tag": "path_lookup", "path_lookup": {".tag": "not_found"}}}',
  folderConflictAsFile:
    '{"error_summary": "path/conflict/file/..", "error": {".tag": "path", "path": {".tag": "conflict", "conflict": {".tag": "file"}}}}'
} as const

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type DropboxEmulatorDrills = {
  /** `list_folder` ignores `limit`: one page with every entry and `has_more: false`. */
  readonly listFolderSinglePage?: boolean
  /** `get_metadata` matches path components case-sensitively. */
  readonly getMetadataCaseSensitive?: boolean
  /** `search/continue_v2` answers the earlier pages' matches again before the new ones. */
  readonly searchRepeatsMatches?: boolean
  /** A missing path answers a `path_lookup/not_found` envelope (still 409). */
  readonly notFoundAsPathLookup?: boolean
  /** A folder create conflict answers `path/conflict/file` instead of `path/conflict/folder`. */
  readonly folderConflictAsFile?: boolean
  /** `delete_v2` keeps no deleted-entry record, so `include_deleted` is not emulated. */
  readonly deleteLeavesNoTombstone?: boolean
  /** `move_v2` gives the moved file a new id. */
  readonly moveMintsNewId?: boolean
  /** An `update` upload naming a stale rev overwrites instead of conflicting. */
  readonly uploadIgnoresRev?: boolean
}

export const dropboxEmulatorDrillKnobs: ReadonlyArray<keyof DropboxEmulatorDrills> = [
  'listFolderSinglePage',
  'getMetadataCaseSensitive',
  'searchRepeatsMatches',
  'notFoundAsPathLookup',
  'folderConflictAsFile',
  'deleteLeavesNoTombstone',
  'moveMintsNewId',
  'uploadIgnoresRev'
]

/** A `list_folder` cursor (runtime data, not state). */
export type DropboxListCursor = {
  readonly kind: 'list'
  readonly folderId: string
  /** The whole listing as rendered when the cursor was issued; any change is not emulated. */
  readonly fingerprint: string
  readonly offset: number
  readonly limit: number
}

/** A `search_v2` cursor (runtime data, not state). */
export type DropboxSearchCursor = {
  readonly kind: 'search'
  readonly query: string
  /** Every match as rendered when the cursor was issued; any change is not emulated. */
  readonly fingerprint: string
  readonly offset: number
  readonly maxResults: number
}

export type DropboxCursor = DropboxListCursor | DropboxSearchCursor

export type DropboxApiEnv = {
  /** Clock in epoch milliseconds (upload timestamps only). */
  readonly now: () => number
  readonly drills: Readonly<Record<keyof DropboxEmulatorDrills, boolean>>
  /** Issued cursors by value (runtime-only; cleared by reset and seed). */
  readonly cursors: Map<string, DropboxCursor>
  /** Cursor numbers; never reset, so a cursor issued before a reset is never issued again. */
  readonly cursorCounters: { list: number; search: number }
}

type Route = StatefulRoute<DropboxEmulatorState, DropboxApiEnv>

/** Origin of the RPC routes. */
export const dropboxEmulatorApiOrigin = 'https://api.dropboxapi.com'

/** Origin of the upload route. */
export const dropboxEmulatorContentOrigin = 'https://content.dropboxapi.com'

const pagingCase = 'dropbox.files.list-folder-cursor-paging'

const pathLowerCase = 'dropbox.files.path-lower-lookup'

const searchCase = 'dropbox.files.search-continue'

const notFoundCase = 'dropbox.errors.not-found-409-envelope'

const conflictCase = 'dropbox.files.create-folder-conflict'

const deleteCase = 'dropbox.files.delete-then-not-found'

const copyCase = 'dropbox.files.copy-move-metadata'

const uploadCase = 'dropbox.files.upload-rev-precondition'

const evidence = (
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  origin: string = dropboxEmulatorApiOrigin
) => ({
  method: 'POST',
  path: `${dropboxEmulatorBasePath}${path}`,
  kind: 'connector' as const,
  write,
  caseIds,
  evidence: 'unverified' as const,
  origin
})

// Responses.

const json = (status: number, text: string): Response =>
  new Response(text, { status, headers: { 'content-type': 'application/json' } })

const ok = (body: Schema.Json): Response => jsonResponse(200, body)

const notFound = (env: DropboxApiEnv): Response =>
  json(
    409,
    env.drills.notFoundAsPathLookup
      ? drillErrorBodies.notFoundAsPathLookup
      : dropboxEmulatorErrorBodies.notFound
  )

// Paths.

/** A parsed absolute path: its components as sent. */
type DropboxPath = { readonly components: ReadonlyArray<string> }

const pathPattern = /^(?:\/[^/]+)+$/

const parsePath = (value: Schema.Json | undefined, label: string): DropboxPath | NotEmulated => {
  if (!Predicate.isString(value) || !pathPattern.test(value)) {
    return notEmulated(
      `${label} must be an absolute /path (the root, ids, and revs are not emulated)`
    )
  }

  const components = value.split('/').slice(1)

  return components.some(component => component === '.' || component === '..')
    ? notEmulated(`${label} with . or .. components is not emulated`)
    : { components }
}

const idPattern = /^id:\S+$/

const childrenOf = (state: DropboxEmulatorState, folderId: string | null) =>
  state.entries.filter(entry => entry.parentId === folderId)

const sameName = (left: string, right: string, caseSensitive: boolean): boolean =>
  caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase()

/** The entry at `components` (case-insensitive, like Dropbox, unless `caseSensitive`). */
const lookup = (
  state: DropboxEmulatorState,
  components: ReadonlyArray<string>,
  caseSensitive = false
): DropboxEmulatorEntry | undefined => {
  let current: DropboxEmulatorEntry | undefined
  let parentId: string | null = null

  for (const component of components) {
    current = childrenOf(state, parentId).find(entry =>
      sameName(entry.name, component, caseSensitive)
    )

    if (current === undefined) return undefined

    parentId = current.id
  }

  return current
}

/**
 * The folder holding `components`: `null` for the root, the folder, or not emulated when it is
 * missing or a file (every fixture names a path whose parent folder exists).
 */
const parentFolder = (
  state: DropboxEmulatorState,
  components: ReadonlyArray<string>,
  label: string
): DropboxEmulatorEntry | null | NotEmulated => {
  if (components.length === 1) return null

  const parent = lookup(state, components.slice(0, -1))

  return parent !== undefined && parent.file === null
    ? parent
    : notEmulated(`${label} under a missing parent folder (or a file) is not emulated`)
}

/** Stored names from the root down to the entry. */
const storedNames = (
  state: DropboxEmulatorState,
  entry: DropboxEmulatorEntry
): ReadonlyArray<string> => {
  const names: Array<string> = []
  let current: DropboxEmulatorEntry | undefined = entry

  while (current !== undefined) {
    names.unshift(current.name)

    const parentId: string | null = current.parentId

    current =
      parentId === null ? undefined : state.entries.find(candidate => candidate.id === parentId)
  }

  return names
}

const pathOf = (names: ReadonlyArray<string>): string => names.map(name => `/${name}`).join('')

// Metadata, in the fixture key order.

const fileMetadata = (
  entry: DropboxEmulatorEntry,
  file: DropboxEmulatorFile,
  display: string
): Schema.JsonObject => ({
  '.tag': 'file',
  name: entry.name,
  path_lower: display.toLowerCase(),
  path_display: display,
  id: entry.id,
  client_modified: file.clientModified,
  server_modified: file.serverModified,
  rev: file.rev,
  size: file.size,
  is_downloadable: true,
  content_hash: file.contentHash
})

/** Folder metadata; `create_folder_v2` answers it without `.tag`, as its fixtures record. */
const folderMetadata = (
  entry: DropboxEmulatorEntry,
  display: string,
  tagged: boolean
): Schema.JsonObject => {
  const body = {
    name: entry.name,
    path_lower: display.toLowerCase(),
    path_display: display,
    id: entry.id
  }

  return tagged ? { '.tag': 'folder', ...body } : body
}

const impliedRefusal = (): NotEmulated =>
  notEmulated(
    'an answer showing a folder no fixture shows (an implied seed folder) is not emulated'
  )

/** Metadata at the stored display path, or not emulated for an implied entry. */
const metadataOf = (
  state: DropboxEmulatorState,
  entry: DropboxEmulatorEntry
): Schema.JsonObject | NotEmulated => {
  if (entry.implied) return impliedRefusal()

  const display = pathOf(storedNames(state, entry))

  return entry.file === null
    ? folderMetadata(entry, display, true)
    : fileMetadata(entry, entry.file, display)
}

/** Metadata of every entry, or not emulated when any is implied. */
const metadataOfAll = (
  state: DropboxEmulatorState,
  entries: ReadonlyArray<DropboxEmulatorEntry>
): ReadonlyArray<Schema.JsonObject> | NotEmulated => {
  const rendered: Array<Schema.JsonObject> = []

  for (const entry of entries) {
    const metadata = metadataOf(state, entry)

    if (isNotEmulated(metadata)) return metadata

    rendered.push(metadata)
  }

  return rendered
}

const deletedMetadata = (deleted: DropboxEmulatorDeleted): Schema.JsonObject => ({
  '.tag': 'deleted',
  name: deleted.name,
  path_lower: deleted.pathLower,
  path_display: deleted.pathDisplay
})

// Counters and timestamps (minted values).

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

const nextId = (state: DropboxEmulatorState): string => {
  const number = state.counters.nextIdNumber

  state.counters = { ...state.counters, nextIdNumber: number + 1 }

  return `id:SyntheticEntry${pad(number, 8)}`
}

const nextRev = (state: DropboxEmulatorState): string => {
  const number = state.counters.nextRevNumber

  state.counters = { ...state.counters, nextRevNumber: number + 1 }

  return `a1b2c3d4e5f6${pad(number, 4)}`
}

/** A Dropbox timestamp (`2026-09-29T14:00:00Z`) from the emulator clock. */
const nowTimestamp = (env: DropboxApiEnv): string =>
  new Date(Math.floor(env.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/** Issue a cursor (in a commit): a value never issued before, registered until reset or seed. */
const issueCursor = (env: DropboxApiEnv, cursor: DropboxCursor): string => {
  const number = env.cursorCounters[cursor.kind]

  env.cursorCounters[cursor.kind] = number + 1

  const value = `AAHsynthetic${cursor.kind === 'list' ? 'List' : 'Search'}Cursor${pad(number, 4)}`

  env.cursors.set(value, cursor)

  return value
}

// Request-shape checks shared by the routes.

const withoutQuery = (request: EmulatedRequest): NotEmulated | undefined =>
  request.query.size > 0
    ? notEmulated('query parameters are not emulated on Dropbox routes')
    : undefined

const rpcBody = (
  request: EmulatedRequest,
  route: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Schema.JsonObject | NotEmulated =>
  withoutQuery(request) ?? exactObject(request.json, `the ${route} body`, required, optional)

const falseFlag = (value: Schema.Json | undefined, label: string): NotEmulated | undefined =>
  value === false ? undefined : notEmulated(`${label} other than false is not emulated`)

const cursorValue = (request: EmulatedRequest, route: string): string | NotEmulated => {
  const body = rpcBody(request, route, ['cursor'])

  if (isNotEmulated(body)) return body

  return Predicate.isString(body.cursor) && body.cursor.length > 0
    ? body.cursor
    : notEmulated('cursor must be a non-empty string')
}

/** A read-only commit. */
const answer =
  (response: () => Response): Commit =>
  () =>
    response()

// Routes.

type GetMetadataInput = { readonly path: DropboxPath; readonly includeDeleted: boolean }

const getMetadata: Route = statefulRoute(
  evidence('/files/get_metadata', false, [
    pathLowerCase,
    notFoundCase,
    conflictCase,
    deleteCase,
    copyCase,
    uploadCase
  ]),
  'json',
  (request): GetMetadataInput | NotEmulated => {
    const body = rpcBody(request, 'get_metadata', ['path'], ['include_deleted'])

    if (isNotEmulated(body)) return body

    if (body.include_deleted !== undefined && body.include_deleted !== true) {
      return notEmulated('include_deleted other than true is not emulated')
    }

    const path = parsePath(body.path, 'path')

    return isNotEmulated(path) ? path : { path, includeDeleted: body.include_deleted === true }
  },
  (state, input, { env }) => {
    const entry = lookup(state, input.path.components, env.drills.getMetadataCaseSensitive)

    if (entry === undefined) {
      const parent = parentFolder(state, input.path.components, 'get_metadata of a path')

      if (isNotEmulated(parent)) return parent

      if (!input.includeDeleted) return answer(() => notFound(env))

      const lower = pathOf(input.path.components).toLowerCase()
      const deleted = state.deleted.find(candidate => candidate.pathLower === lower)

      return deleted === undefined
        ? notEmulated('include_deleted for a path without a recorded delete is not emulated')
        : answer(() => ok(deletedMetadata(deleted)))
    }

    if (input.includeDeleted) {
      return notEmulated('include_deleted for an existing entry is not emulated')
    }

    if (entry.file === null) {
      return notEmulated('get_metadata of a folder is not emulated (no fixture records it)')
    }

    if (entry.implied) return impliedRefusal()

    // Only the last component keeps the stored casing; the rest echo the request.
    const display = pathOf([...input.path.components.slice(0, -1), entry.name])
    const file = entry.file

    return answer(() => ok(fileMetadata(entry, file, display)))
  }
)

type ListInput = { readonly path: DropboxPath; readonly limit: number }

/** The whole listing of a folder, rendered, or not emulated (an implied child). */
const listingOf = (
  state: DropboxEmulatorState,
  folderId: string
): ReadonlyArray<Schema.JsonObject> | NotEmulated =>
  metadataOfAll(state, childrenOf(state, folderId))

/** A commit answering one listing page and issuing its cursor. */
const listPage =
  (
    env: DropboxApiEnv,
    folderId: string,
    listing: ReadonlyArray<Schema.JsonObject>,
    offset: number,
    limit: number
  ): Commit =>
  () => {
    const page = listing.slice(offset, offset + limit)
    const end = offset + page.length

    const cursor = issueCursor(env, {
      kind: 'list',
      folderId,
      fingerprint: JSON.stringify(listing),
      offset: end,
      limit
    })

    return ok({ entries: [...page], cursor, has_more: end < listing.length })
  }

const listFolder: Route = statefulRoute(
  evidence('/files/list_folder', false, [pagingCase]),
  'json',
  (request): ListInput | NotEmulated => {
    const body = rpcBody(request, 'list_folder', ['path', 'limit'])

    if (isNotEmulated(body)) return body

    const path = parsePath(body.path, 'path')

    if (isNotEmulated(path)) return path

    const limit = integerIn(body.limit, 'limit', 1, 2000)

    return isNotEmulated(limit) ? limit : { path, limit }
  },
  (state, input, { env }) => {
    const folder = lookup(state, input.path.components)

    if (folder === undefined || folder.file !== null) {
      return notEmulated('list_folder of a missing path or a file is not emulated')
    }

    const listing = listingOf(state, folder.id)

    if (isNotEmulated(listing)) return listing

    // Every recorded listing has entries; an empty one (for example the leftover lookup's empty
    // work folder) is no fixture's answer.
    if (listing.length === 0) {
      return notEmulated('a listing of an empty folder is not emulated (no fixture records one)')
    }

    const limit = env.drills.listFolderSinglePage ? Math.max(listing.length, 1) : input.limit

    return listPage(env, folder.id, listing, 0, limit)
  }
)

const listFolderContinue: Route = statefulRoute(
  evidence('/files/list_folder/continue', false, [pagingCase]),
  'json',
  request => cursorValue(request, 'list_folder/continue'),
  (state, value, { env }) => {
    const cursor = env.cursors.get(value)

    if (cursor === undefined || cursor.kind !== 'list') {
      return notEmulated(
        'a list cursor this emulator did not issue since the last reset is not emulated'
      )
    }

    const folder = state.entries.find(entry => entry.id === cursor.folderId)
    const listing = folder === undefined ? undefined : listingOf(state, folder.id)

    if (
      folder === undefined ||
      listing === undefined ||
      isNotEmulated(listing) ||
      JSON.stringify(listing) !== cursor.fingerprint
    ) {
      return notEmulated(
        'continuing a listing whose folder changed since its cursor is not emulated'
      )
    }

    if (cursor.offset >= listing.length) {
      return notEmulated('continuing a finished listing (changes since it) is not emulated')
    }

    return listPage(env, folder.id, listing, cursor.offset, cursor.limit)
  }
)

type SearchInput = { readonly query: string; readonly maxResults: number }

/** Every match of `query`, rendered as the fixture's match objects, or not emulated. */
const searchMatches = (
  state: DropboxEmulatorState,
  query: string
): ReadonlyArray<Schema.JsonObject> | NotEmulated => {
  const lower = query.toLowerCase()
  const matches = state.entries.filter(entry => entry.name.toLowerCase().includes(lower))

  if (matches.length === 0) return notEmulated('a search without matches is not emulated')

  if (matches.some(entry => entry.file === null)) {
    return notEmulated('a search matching a folder is not emulated (the fixture matches files)')
  }

  const rendered = metadataOfAll(state, matches)

  return isNotEmulated(rendered)
    ? rendered
    : rendered.map(metadata => ({
        match_type: { '.tag': 'filename' },
        metadata: { '.tag': 'metadata', metadata }
      }))
}

/** A commit answering one search page (the fixtures' last page carries no cursor). */
const searchPage =
  (
    env: DropboxApiEnv,
    query: string,
    matches: ReadonlyArray<Schema.JsonObject>,
    start: number,
    offset: number,
    maxResults: number
  ): Commit =>
  () => {
    const end = Math.min(offset + maxResults, matches.length)
    const hasMore = end < matches.length
    const body = { matches: matches.slice(start, end), has_more: hasMore }

    if (!hasMore) return ok(body)

    const cursor = issueCursor(env, {
      kind: 'search',
      query,
      fingerprint: JSON.stringify(matches),
      offset: end,
      maxResults
    })

    return ok({ ...body, cursor })
  }

const search: Route = statefulRoute(
  evidence('/files/search_v2', false, [searchCase]),
  'json',
  (request): SearchInput | NotEmulated => {
    const body = rpcBody(request, 'search_v2', ['query', 'options'])

    if (isNotEmulated(body)) return body

    if (!Predicate.isString(body.query) || body.query.trim().length === 0) {
      return notEmulated('query must be a non-empty string')
    }

    const options = exactObject(body.options, 'options', ['max_results', 'filename_only'])

    if (isNotEmulated(options)) return options

    if (options.filename_only !== true) {
      return notEmulated('options.filename_only other than true is not emulated')
    }

    const maxResults = integerIn(options.max_results, 'options.max_results', 1, 1000)

    return isNotEmulated(maxResults) ? maxResults : { query: body.query, maxResults }
  },
  (state, input, { env }) => {
    const matches = searchMatches(state, input.query)

    return isNotEmulated(matches)
      ? matches
      : searchPage(env, input.query, matches, 0, 0, input.maxResults)
  }
)

const searchContinue: Route = statefulRoute(
  evidence('/files/search/continue_v2', false, [searchCase]),
  'json',
  request => cursorValue(request, 'search/continue_v2'),
  (state, value, { env }) => {
    const cursor = env.cursors.get(value)

    if (cursor === undefined || cursor.kind !== 'search') {
      return notEmulated(
        'a search cursor this emulator did not issue since the last reset is not emulated'
      )
    }

    const matches = searchMatches(state, cursor.query)

    if (isNotEmulated(matches) || JSON.stringify(matches) !== cursor.fingerprint) {
      return notEmulated(
        'continuing a search whose matches changed since its cursor is not emulated'
      )
    }

    const start = env.drills.searchRepeatsMatches ? 0 : cursor.offset

    return searchPage(env, cursor.query, matches, start, cursor.offset, cursor.maxResults)
  }
)

const createFolder: Route = statefulRoute(
  evidence('/files/create_folder_v2', true, [conflictCase, deleteCase, copyCase, uploadCase]),
  'json',
  (request): DropboxPath | NotEmulated => {
    const body = rpcBody(request, 'create_folder_v2', ['path', 'autorename'])

    if (isNotEmulated(body)) return body

    return falseFlag(body.autorename, 'autorename') ?? parsePath(body.path, 'path')
  },
  (state, path, { env }) => {
    const parent = parentFolder(state, path.components, 'create_folder_v2')

    if (isNotEmulated(parent)) return parent

    const existing = lookup(state, path.components)

    if (existing !== undefined) {
      if (existing.file !== null) {
        return notEmulated('create_folder_v2 over a file is not emulated')
      }

      return answer(() =>
        json(
          409,
          env.drills.folderConflictAsFile
            ? drillErrorBodies.folderConflictAsFile
            : dropboxEmulatorErrorBodies.folderConflict
        )
      )
    }

    return () => {
      const created: DropboxEmulatorEntry = {
        id: nextId(state),
        parentId: parent?.id ?? null,
        name: path.components.at(-1) ?? '',
        file: null,
        implied: false
      }

      state.entries = [...state.entries, created]

      return ok({ metadata: folderMetadata(created, pathOf(storedNames(state, created)), false) })
    }
  }
)

/** The entry and everything under it. */
const subtreeOf = (
  state: DropboxEmulatorState,
  root: DropboxEmulatorEntry
): ReadonlyArray<DropboxEmulatorEntry> => [
  root,
  ...childrenOf(state, root.id).flatMap(child => subtreeOf(state, child))
]

type Target = { readonly id: string } | { readonly path: DropboxPath }

const deleteEntry: Route = statefulRoute(
  evidence('/files/delete_v2', true, [conflictCase, deleteCase, copyCase, uploadCase]),
  'json',
  (request): Target | NotEmulated => {
    const body = rpcBody(request, 'delete_v2', ['path'])

    if (isNotEmulated(body)) return body

    if (Predicate.isString(body.path) && idPattern.test(body.path)) return { id: body.path }

    const path = parsePath(body.path, 'path')

    return isNotEmulated(path) ? path : { path }
  },
  (state, target, { env }) => {
    const entry =
      'id' in target
        ? state.entries.find(candidate => candidate.id === target.id)
        : lookup(state, target.path.components)

    if (entry === undefined) {
      return notEmulated('delete_v2 of a missing entry is not emulated (no fixture records it)')
    }

    if (entry.file !== null) {
      return notEmulated('delete_v2 of a file is not emulated (the fixtures delete folders)')
    }

    const removed = subtreeOf(state, entry)

    if (removed.some(candidate => candidate.implied)) return impliedRefusal()

    const metadata = metadataOf(state, entry)

    if (isNotEmulated(metadata)) return metadata

    return () => {
      const removedIds = new Set(removed.map(candidate => candidate.id))

      // Only an empty folder's delete has a recorded `include_deleted` answer.
      if (removed.length === 1 && !env.drills.deleteLeavesNoTombstone) {
        const display = pathOf(storedNames(state, entry))
        const lower = display.toLowerCase()

        state.deleted = [
          ...state.deleted.filter(record => record.pathLower !== lower),
          { name: entry.name, pathLower: lower, pathDisplay: display }
        ]
      }

      state.entries = state.entries.filter(candidate => !removedIds.has(candidate.id))

      return ok({ metadata })
    }
  }
)

type RelocationInput = { readonly from: DropboxPath; readonly to: DropboxPath }

const relocationInput = (
  request: EmulatedRequest,
  route: string
): RelocationInput | NotEmulated => {
  const body = rpcBody(request, route, ['from_path', 'to_path', 'autorename'])

  if (isNotEmulated(body)) return body

  const autorename = falseFlag(body.autorename, 'autorename')

  if (autorename !== undefined) return autorename

  const from = parsePath(body.from_path, 'from_path')

  if (isNotEmulated(from)) return from

  const to = parsePath(body.to_path, 'to_path')

  return isNotEmulated(to) ? to : { from, to }
}

type Relocation = {
  readonly source: DropboxEmulatorEntry
  readonly file: DropboxEmulatorFile
  readonly parent: DropboxEmulatorEntry | null
}

/** The source file and destination folder of a copy or move, or not emulated. */
const relocation = (
  state: DropboxEmulatorState,
  input: RelocationInput,
  route: string
): Relocation | NotEmulated => {
  const source = lookup(state, input.from.components)

  if (source === undefined || source.file === null || source.implied) {
    return notEmulated(`${route} of a missing entry or a folder is not emulated (files only)`)
  }

  const parent = parentFolder(state, input.to.components, route)

  if (isNotEmulated(parent)) return parent

  return lookup(state, input.to.components) === undefined
    ? { source, file: source.file, parent }
    : notEmulated(`${route} onto an existing entry is not emulated`)
}

const copy: Route = statefulRoute(
  evidence('/files/copy_v2', true, [copyCase]),
  'json',
  request => relocationInput(request, 'copy_v2'),
  (state, input) => {
    const found = relocation(state, input, 'copy_v2')

    if (isNotEmulated(found)) return found

    // The copy keeps the source's size, content hash, and timestamps, as the fixture records.
    return () => {
      const file = { ...found.file, rev: nextRev(state) }

      const created: DropboxEmulatorEntry = {
        id: nextId(state),
        parentId: found.parent?.id ?? null,
        name: input.to.components.at(-1) ?? '',
        file,
        implied: false
      }

      state.entries = [...state.entries, created]

      return ok({ metadata: fileMetadata(created, file, pathOf(storedNames(state, created))) })
    }
  }
)

const move: Route = statefulRoute(
  evidence('/files/move_v2', true, [copyCase]),
  'json',
  request => relocationInput(request, 'move_v2'),
  (state, input, { env }) => {
    const found = relocation(state, input, 'move_v2')

    if (isNotEmulated(found)) return found

    // The moved file keeps its id and timestamps and gets a new rev, as the fixture records.
    return () => {
      const file = { ...found.file, rev: nextRev(state) }

      const moved: DropboxEmulatorEntry = {
        id: env.drills.moveMintsNewId ? nextId(state) : found.source.id,
        parentId: found.parent?.id ?? null,
        name: input.to.components.at(-1) ?? '',
        file,
        implied: false
      }

      state.entries = state.entries.map(entry => (entry.id === found.source.id ? moved : entry))

      return ok({ metadata: fileMetadata(moved, file, pathOf(storedNames(state, moved))) })
    }
  }
)

type UploadInput =
  | { readonly mode: 'add'; readonly path: DropboxPath; readonly bytes: Uint8Array }
  | {
      readonly mode: 'update'
      readonly id: string
      readonly rev: string
      readonly bytes: Uint8Array
    }

const revPattern = /^[0-9a-f]{9,}$/

/** A file written by an upload (in a commit): a new rev, its size, hash, and clock timestamps. */
const uploadedFile = (
  state: DropboxEmulatorState,
  at: string,
  bytes: Uint8Array
): DropboxEmulatorFile => {
  const rev = nextRev(state)

  return {
    rev,
    size: bytes.byteLength,
    contentHash: syntheticContentHash(rev.slice(-2)),
    clientModified: at,
    serverModified: at
  }
}

const upload: Route = statefulRoute(
  evidence('/files/upload', true, [uploadCase], dropboxEmulatorContentOrigin),
  'bytes',
  (request): UploadInput | NotEmulated => {
    const noQuery = withoutQuery(request)

    if (noQuery !== undefined) return noQuery

    if (mediaType(request.header('content-type')) !== 'application/octet-stream') {
      return notEmulated('the upload takes a content-type: application/octet-stream body')
    }

    const header = request.header('dropbox-api-arg')
    const arg = header === undefined ? undefined : parseJsonText(header)

    if (arg === undefined) return notEmulated('the upload needs a JSON Dropbox-API-Arg header')

    const fields = exactObject(arg, 'Dropbox-API-Arg', [
      'path',
      'mode',
      'autorename',
      'strict_conflict'
    ])

    if (isNotEmulated(fields)) return fields

    const autorename = falseFlag(fields.autorename, 'autorename')

    if (autorename !== undefined) return autorename

    if (fields.strict_conflict !== true) {
      return notEmulated('strict_conflict other than true is not emulated')
    }

    const bytes = request.bytes ?? new Uint8Array()

    if (fields.mode === 'add') {
      const path = parsePath(fields.path, 'path')

      return isNotEmulated(path) ? path : { mode: 'add', path, bytes }
    }

    const mode = exactObject(fields.mode, 'mode', ['.tag', 'update'])

    if (isNotEmulated(mode)) return mode

    if (
      mode['.tag'] !== 'update' ||
      !Predicate.isString(mode.update) ||
      !revPattern.test(mode.update)
    ) {
      return notEmulated(
        'mode other than add or { ".tag": "update", update: <rev> } is not emulated'
      )
    }

    return Predicate.isString(fields.path) && idPattern.test(fields.path)
      ? { mode: 'update', id: fields.path, rev: mode.update, bytes }
      : notEmulated('an update upload addresses the file by its id: form only')
  },
  (state, input, { env }) => {
    if (input.mode === 'add') {
      const parent = parentFolder(state, input.path.components, 'the upload')

      if (isNotEmulated(parent)) return parent

      const existing = lookup(state, input.path.components)

      if (existing !== undefined) {
        return existing.file === null
          ? notEmulated('an add upload onto a folder is not emulated')
          : answer(() => json(409, dropboxEmulatorErrorBodies.uploadConflict))
      }

      return () => {
        // Read the clock before any write: a failing clock writes nothing.
        const at = nowTimestamp(env)
        const file = uploadedFile(state, at, input.bytes)

        const created: DropboxEmulatorEntry = {
          id: nextId(state),
          parentId: parent?.id ?? null,
          name: input.path.components.at(-1) ?? '',
          file,
          implied: false
        }

        state.entries = [...state.entries, created]

        return ok(fileMetadata(created, file, pathOf(storedNames(state, created))))
      }
    }

    const existing = state.entries.find(entry => entry.id === input.id)

    if (existing === undefined || existing.file === null || existing.implied) {
      return notEmulated('an update upload of a missing file or a folder is not emulated')
    }

    if (existing.file.rev !== input.rev && !env.drills.uploadIgnoresRev) {
      return answer(() => json(409, dropboxEmulatorErrorBodies.uploadConflict))
    }

    return () => {
      const at = nowTimestamp(env)
      const file = uploadedFile(state, at, input.bytes)
      const updated: DropboxEmulatorEntry = { ...existing, file }

      state.entries = state.entries.map(entry => (entry.id === existing.id ? updated : entry))

      return ok(fileMetadata(updated, file, pathOf(storedNames(state, updated))))
    }
  }
)

/** The route table: evidence plus handlers. `dropboxEmulatorRoutes` is its evidence part. */
export const dropboxApiRoutes: ReadonlyArray<Route> = [
  listFolder,
  listFolderContinue,
  getMetadata,
  search,
  searchContinue,
  createFolder,
  deleteEntry,
  copy,
  move,
  upload
]
