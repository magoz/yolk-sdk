/**
 * Microsoft Graph emulator OneDrive routes (internal): item read, children listing, folder
 * create, delete, and the asynchronous copy with its monitor URL. Wire shapes follow the
 * synthetic OneDrive conformance fixtures.
 *
 * Deleted items are removed with their subtree (no recycle bin is emulated). A copy answers 202
 * with one monitor `Location` on the SharePoint origin; the monitor needs no credentials, answers
 * `inProgress` (202) for `copyInProgressPolls` polls, then runs the copy and answers `completed`
 * (200) with the new item's `resourceId`, or `failed` when the copy can no longer run.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  bodyObject,
  codes,
  collection,
  emptyResponse,
  invalidValue,
  isJsonObject,
  jsonResponse,
  nextLinkOf,
  notEmulated,
  nowTimestamp,
  padded,
  pageOf,
  personalSite,
  project,
  selectedFields,
  type CopyMonitor,
  type MicrosoftApiEnv,
  type RouteHandler,
  type RouteRequest
} from './graph.ts'
import type { MicrosoftEmulatorDriveItem, MicrosoftEmulatorState } from './state.ts'

const itemFields: ReadonlyArray<string> = [
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
]

const notFound = (request: RouteRequest): Response =>
  request.error(404, codes.driveItemNotFound, 'The resource could not be found.')

const childrenOf = (state: MicrosoftEmulatorState, id: string) =>
  state.driveItems.filter(item => item.parentId === id)

/** The item and its descendants. */
const subtreeOf = (
  state: MicrosoftEmulatorState,
  root: MicrosoftEmulatorDriveItem
): ReadonlyArray<MicrosoftEmulatorDriveItem> => [
  root,
  ...childrenOf(state, root.id).flatMap(child => subtreeOf(state, child))
]

/** Folders report the size of their contents. */
const sizeOf = (state: MicrosoftEmulatorState, item: MicrosoftEmulatorDriveItem): number =>
  item.kind === 'file'
    ? item.size
    : childrenOf(state, item.id).reduce((sum, child) => sum + sizeOf(state, child), 0)

/** Names from below the root down to the item (empty for the root). */
const pathNames = (
  state: MicrosoftEmulatorState,
  item: MicrosoftEmulatorDriveItem
): ReadonlyArray<string> => {
  const parent =
    item.parentId === null
      ? undefined
      : state.driveItems.find(candidate => candidate.id === item.parentId)

  return parent === undefined ? [] : [...pathNames(state, parent), item.name]
}

/** A stable synthetic GUID for an item's `eTag`/`cTag` (FNV-1a over the id). */
const itemGuid = (id: string): string => {
  let hash = 0x811c9dc5

  for (const character of id) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0
  }

  return `${hash.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

/** The full item, in the fixture key order. */
const renderItem = (
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  item: MicrosoftEmulatorDriveItem
): Schema.JsonObject => {
  const site = personalSite(state.user)
  const names = pathNames(state, item)
  const parentPath = names.slice(0, -1)

  const parentReference: Schema.JsonObject =
    item.parentId === null
      ? { driveType: state.drive.driveType, driveId: state.drive.id }
      : {
          driveType: state.drive.driveType,
          driveId: state.drive.id,
          id: item.parentId,
          path: `/drive/root:${parentPath.map(name => `/${name}`).join('')}`
        }

  const base = {
    id: item.id,
    name: item.name,
    size: sizeOf(state, item),
    webUrl: `${env.sharePointOrigin}/personal/${site}/Documents${names.map(name => `/${encodeURIComponent(name)}`).join('')}`,
    createdDateTime: item.createdDateTime,
    lastModifiedDateTime: item.lastModifiedDateTime,
    eTag: `"{${itemGuid(item.id)}},1"`,
    cTag: `"c:{${itemGuid(item.id)}},0"`,
    parentReference
  }

  if (item.kind === 'folder') {
    return { ...base, folder: { childCount: childrenOf(state, item.id).length } }
  }

  return {
    ...base,
    file: {
      mimeType: item.mimeType ?? 'application/octet-stream',
      hashes: item.quickXorHash === null ? {} : { quickXorHash: item.quickXorHash }
    }
  }
}

/** The drive of the `{driveId}` segment, or 404. */
const driveProblem = (state: MicrosoftEmulatorState, request: RouteRequest) =>
  request.params.driveId === state.drive.id ? undefined : notFound(request)

/** The item of an id segment (`root` names the drive root). */
const findItem = (
  state: MicrosoftEmulatorState,
  id: string
): MicrosoftEmulatorDriveItem | undefined => {
  const resolved = id.toLowerCase() === 'root' ? state.drive.rootId : id

  return state.driveItems.find(item => item.id === resolved)
}

/** `GET /drives/{driveId}/items/{itemId}` (`$select`). */
export const getItem: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const fields = selectedFields(request, itemFields)

  if (fields instanceof Response) return fields

  const item = findItem(state, request.params.itemId ?? '')

  return item === undefined
    ? notFound(request)
    : jsonResponse(200, project(renderItem(state, env, item), fields))
}

const byName = (left: MicrosoftEmulatorDriveItem, right: MicrosoftEmulatorDriveItem) =>
  left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
  left.id.localeCompare(right.id)

/** `GET /drives/{driveId}/items/{itemId}/children`: by name, one `$top`/`$skip` page. */
export const listChildren: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const fields = selectedFields(request, itemFields)

  if (fields instanceof Response) return fields

  const parent = findItem(state, request.params.itemId ?? '')

  if (parent === undefined) return notFound(request)

  if (parent.kind !== 'folder') return notEmulated(request, 'children of a file are not emulated.')

  const page = pageOf([...childrenOf(state, parent.id)].sort(byName), request, {
    defaultTop: 200,
    maxTop: 999
  })

  if (page instanceof Response) return page

  return jsonResponse(
    200,
    collection(
      page.items.map(item => project(renderItem(state, env, item), fields)),
      nextLinkOf(env, request, page, ['$select'])
    )
  )
}

const invalidNamePattern = /["*:<>?/\\|]/

const nameProblem = (request: RouteRequest, name: unknown): string | Response =>
  Predicate.isString(name) &&
  name.trim() !== '' &&
  name.trim() === name &&
  !invalidNamePattern.test(name) &&
  name !== '.' &&
  name !== '..' &&
  !name.endsWith('.')
    ? name
    : invalidValue(request, 'the item name is empty or has characters OneDrive does not allow.')

const nameTaken = (state: MicrosoftEmulatorState, parentId: string, name: string): boolean =>
  childrenOf(state, parentId).some(child => child.name.toLowerCase() === name.toLowerCase())

/** `name 1.ext`, `name 2.ext`, ... until free (the `rename` conflict behavior). */
const freeName = (state: MicrosoftEmulatorState, parentId: string, name: string): string => {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''

  for (let number = 1; ; number++) {
    const candidate = `${stem} ${number}${extension}`

    if (!nameTaken(state, parentId, candidate)) return candidate
  }
}

const nextItemId = (state: MicrosoftEmulatorState): string => {
  let number = state.counters.nextItemNumber
  let id = `01SYNTHETICITEM${padded(number, 17)}`

  while (state.driveItems.some(item => item.id === id)) {
    number += 1
    id = `01SYNTHETICITEM${padded(number, 17)}`
  }

  state.counters = { ...state.counters, nextItemNumber: number + 1 }

  return id
}

const nameConflict = (request: RouteRequest): Response =>
  request.error(409, codes.nameAlreadyExists, 'The specified item name already exists.')

type ConflictBehavior = 'fail' | 'rename'

const conflictBehaviorOf = (request: RouteRequest, value: unknown): ConflictBehavior | Response => {
  if (value === undefined || value === 'fail' || value === 'rename') return value ?? 'fail'

  return value === 'replace'
    ? notEmulated(request, 'conflictBehavior replace is not emulated (fail and rename only).')
    : invalidValue(request, 'conflictBehavior must be fail or rename.')
}

/**
 * `POST /drives/{driveId}/items/{itemId}/children` with a `folder` facet: 201 with the folder;
 * `@microsoft.graph.conflictBehavior` `fail` (409 `nameAlreadyExists`) or `rename`. Creating
 * files here is not emulated.
 */
export const createFolder: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const parent = findItem(state, request.params.itemId ?? '')

  if (parent === undefined) return notFound(request)

  if (parent.kind !== 'folder') return invalidValue(request, 'the parent item is not a folder.')

  const fields = bodyObject(request, ['name', 'folder', '@microsoft.graph.conflictBehavior'])

  if (fields instanceof Response) return fields

  if (fields.folder === undefined) {
    return notEmulated(request, 'only folder creation (a folder facet) is emulated here.')
  }

  const folderFacet = fields.folder

  if (!isJsonObject(folderFacet) || Object.keys(folderFacet).length > 0) {
    return notEmulated(request, 'the folder facet must be {}.')
  }

  const name = nameProblem(request, fields.name)

  if (name instanceof Response) return name

  const behavior = conflictBehaviorOf(request, fields['@microsoft.graph.conflictBehavior'])

  if (behavior instanceof Response) return behavior

  const taken = nameTaken(state, parent.id, name)

  if (taken && behavior === 'fail') return nameConflict(request)

  const now = nowTimestamp(env)

  const folder: MicrosoftEmulatorDriveItem = {
    id: nextItemId(state),
    parentId: parent.id,
    name: taken ? freeName(state, parent.id, name) : name,
    kind: 'folder',
    size: 0,
    mimeType: null,
    quickXorHash: null,
    createdDateTime: now,
    lastModifiedDateTime: now
  }

  state.driveItems = [...state.driveItems, folder]

  return jsonResponse(201, renderItem(state, env, folder))
}

/** `DELETE /drives/{driveId}/items/{itemId}`: 204; the item and its subtree are removed. */
export const deleteItem: RouteHandler = (state, request) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const item = findItem(state, request.params.itemId ?? '')

  if (item === undefined) return notFound(request)

  if (item.parentId === null)
    return notEmulated(request, 'deleting the drive root is not emulated.')

  if (request.ifMatch !== undefined && request.ifMatch !== `"{${itemGuid(item.id)}},1"`) {
    return request.error(
      412,
      codes.preconditionFailed,
      'Synthetic: the If-Match eTag does not match.'
    )
  }

  const removed = new Set(subtreeOf(state, item).map(entry => entry.id))

  state.driveItems = state.driveItems.filter(entry => !removed.has(entry.id))

  return emptyResponse(204)
}

const monitorPath = (state: MicrosoftEmulatorState, id: string) =>
  `/personal/${personalSite(state.user)}/_api/v2.0/monitor/${id}`

/**
 * `POST /drives/{driveId}/items/{itemId}/copy` (`{ parentReference: { driveId?, id }, name? }`,
 * query `@microsoft.graph.conflictBehavior` `fail` or `rename`): 202 with an empty body and one
 * monitor `Location`. The copy itself runs when the monitor reports completion.
 */
export const copyItem: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const source = findItem(state, request.params.itemId ?? '')

  if (source === undefined) return notFound(request)

  const behavior = conflictBehaviorOf(
    request,
    request.query.get('@microsoft.graph.conflictBehavior') ?? undefined
  )

  if (behavior instanceof Response) return behavior

  const fields = bodyObject(request, ['parentReference', 'name'])

  if (fields instanceof Response) return fields

  const reference = fields.parentReference

  if (
    !isJsonObject(reference) ||
    !Predicate.isString(reference.id) ||
    Object.keys(reference).some(key => key !== 'id' && key !== 'driveId')
  ) {
    return invalidValue(request, 'parentReference must be { driveId?, id }.')
  }

  if (reference.driveId !== undefined && reference.driveId !== state.drive.id) {
    return notEmulated(request, 'copies to another drive are not emulated.')
  }

  const destination = findItem(state, reference.id)

  if (destination === undefined) return notFound(request)

  if (destination.kind !== 'folder') {
    return invalidValue(request, 'the destination is not a folder.')
  }

  if (subtreeOf(state, source).some(item => item.id === destination.id)) {
    return invalidValue(request, 'a folder cannot be copied into itself.')
  }

  const name = fields.name === undefined ? undefined : nameProblem(request, fields.name)

  if (name instanceof Response) return name

  const number = env.monitorCounter.next

  env.monitorCounter.next += 1

  const monitor: CopyMonitor = {
    id: `00000000-0000-4000-8000-${padded(number, 12)}`,
    sourceId: source.id,
    destinationParentId: destination.id,
    name,
    conflictBehavior: behavior,
    pollsLeft: env.copyInProgressPolls,
    result: undefined
  }

  env.monitors.set(monitor.id, monitor)

  return emptyResponse(202, {
    location: `${env.sharePointOrigin}${monitorPath(state, monitor.id)}`
  })
}

/** Copy `item` (and its subtree) under `parentId` with fresh ids; returns the new root id. */
const copyTree = (
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  item: MicrosoftEmulatorDriveItem,
  parentId: string,
  name: string
): string => {
  const now = nowTimestamp(env)

  const copy: MicrosoftEmulatorDriveItem = {
    ...item,
    id: nextItemId(state),
    parentId,
    name,
    createdDateTime: now,
    lastModifiedDateTime: now
  }

  const children = childrenOf(state, item.id)

  state.driveItems = [...state.driveItems, copy]

  for (const child of children) copyTree(state, env, child, copy.id, child.name)

  return copy.id
}

/** Run a monitored copy: the source and destination must still exist. */
const runCopy = (
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  monitor: CopyMonitor
): CopyMonitor['result'] => {
  const source = findItem(state, monitor.sourceId)
  const destination = findItem(state, monitor.destinationParentId)

  if (source === undefined || destination === undefined || destination.kind !== 'folder') {
    return {
      status: 'failed',
      code: codes.driveItemNotFound,
      message: 'Synthetic: the copy source or destination no longer exists.'
    }
  }

  const name = monitor.name ?? source.name
  const taken = nameTaken(state, destination.id, name)

  if (taken && monitor.conflictBehavior === 'fail') {
    return {
      status: 'failed',
      code: codes.nameAlreadyExists,
      message: 'The specified item name already exists.'
    }
  }

  const resourceId = copyTree(
    state,
    env,
    source,
    destination.id,
    taken ? freeName(state, destination.id, name) : name
  )

  return { status: 'completed', resourceId }
}

const monitorContentType = 'application/json;odata.metadata=minimal;odata.streaming=true'

/**
 * `GET /personal/{site}/_api/v2.0/monitor/{monitorId}` on the SharePoint origin (no credentials
 * needed, like the real capability URL): `inProgress` (202) while polls remain, then the copy
 * runs once and every later poll answers its `completed` (200, `resourceId`) or `failed` status.
 */
export const copyMonitor: RouteHandler = (state, request, env) => {
  const monitor = env.monitors.get(request.params.monitorId ?? '')

  if (monitor === undefined || request.params.site !== personalSite(state.user)) {
    return notFound(request)
  }

  const context = `${env.sharePointOrigin}/personal/${personalSite(state.user)}/_api/v2.0/$metadata#oneDrive.asynchronousOperationStatus`
  const headers = { 'content-type': monitorContentType }

  if (monitor.result === undefined && monitor.pollsLeft > 0) {
    monitor.pollsLeft -= 1

    return jsonResponse(
      202,
      { '@odata.context': context, percentageComplete: 0, status: 'inProgress' },
      headers
    )
  }

  const result = monitor.result ?? runCopy(state, env, monitor)

  monitor.result = result

  return result?.status === 'completed'
    ? jsonResponse(
        200,
        {
          '@odata.context': context,
          percentageComplete: 100,
          resourceId: result.resourceId,
          status: 'completed'
        },
        headers
      )
    : jsonResponse(
        200,
        {
          '@odata.context': context,
          percentageComplete: 0,
          status: 'failed',
          error: { code: result?.code, message: result?.message }
        },
        headers
      )
}
