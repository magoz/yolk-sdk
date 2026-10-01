/**
 * Microsoft Graph emulator OneDrive routes (internal): item read, children listing, folder
 * create, delete, and the asynchronous copy with its monitor URL. Wire shapes follow the
 * synthetic OneDrive conformance fixtures.
 *
 * Deleted items are removed with their subtree (no recycle bin is emulated). Folder create and
 * copy take `@microsoft.graph.conflictBehavior` `fail` only, as the fixtures send it, and only for
 * a name that is free: no fixture records a name conflict, so one fails closed (400). Children
 * listings need `$top` and answer one page (no `$skip`, no `@odata.nextLink`), as the fixtures
 * record them. A copy takes what the copy fixture sends (a file, `parentReference { driveId, id }`
 * on the same drive, no new `name`; anything else is not emulated) and answers 202 with one
 * monitor `Location` on the SharePoint origin; the monitor needs no credentials, answers `inProgress` (202) for `copyInProgressPolls` polls (default 0), then runs
 * the copy and answers `completed` (200) with the new item's `resourceId`, as the fixture's first
 * poll does. No fixture records a failed copy: when the copy can no longer run (source or
 * destination gone, or the name taken), the monitor answers 400 not emulated.
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
  entity,
  invalidValue,
  isJsonObject,
  jsonResponse,
  metadataContext,
  nestedObject,
  notEmulated,
  nowTimestamp,
  odataKey,
  padded,
  personalSite,
  project,
  selectSuffix,
  selectedFields,
  singlePage,
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

/** `drives('{driveId}')`, the context prefix of every OneDrive route. */
const driveContext = (request: RouteRequest): string =>
  `drives${odataKey(request.params.driveId ?? '')}`

/** `drives('{driveId}')/items('{itemId}')/children`. */
const childrenContext = (request: RouteRequest): string =>
  `${driveContext(request)}/items${odataKey(request.params.itemId ?? '')}/children`

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

  const context = metadataContext(
    env,
    `${driveContext(request)}/items${selectSuffix(fields)}/$entity`
  )

  return item === undefined
    ? notFound(request)
    : jsonResponse(200, entity(context, project(renderItem(state, env, item), fields)))
}

const byName = (left: MicrosoftEmulatorDriveItem, right: MicrosoftEmulatorDriveItem) =>
  left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
  left.id.localeCompare(right.id)

/** The largest children `$top` a fixture sends (`$top=200`, create-folder and copy cases). */
const childrenMaxTop = 200

/**
 * `GET /drives/{driveId}/items/{itemId}/children`: by name, at most `$top` (one page only;
 * `$top` required, at most `childrenMaxTop`).
 */
export const listChildren: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const fields = selectedFields(request, itemFields)

  if (fields instanceof Response) return fields

  const parent = findItem(state, request.params.itemId ?? '')

  if (parent === undefined) return notFound(request)

  if (parent.kind !== 'folder') return notEmulated(request, 'children of a file are not emulated.')

  const page = singlePage([...childrenOf(state, parent.id)].sort(byName), request, childrenMaxTop)

  if (page instanceof Response) return page

  return jsonResponse(
    200,
    collection(
      metadataContext(env, `${childrenContext(request)}${selectSuffix(fields)}`),
      page.map(item => project(renderItem(state, env, item), fields)),
      undefined
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
  notEmulated(request, 'name conflicts are not emulated (the name is already taken).')

/** Only `fail`, as the fixtures send it; anything else (or none) is not emulated. */
const conflictBehaviorProblem = (request: RouteRequest, value: unknown): Response | undefined =>
  value === 'fail'
    ? undefined
    : notEmulated(
        request,
        '@microsoft.graph.conflictBehavior must be fail (other or missing values are not emulated).'
      )

/**
 * `POST /drives/{driveId}/items/{itemId}/children` with a `folder` facet and
 * `@microsoft.graph.conflictBehavior: fail`: 201 with the folder. A taken name, and creating
 * files here, are not emulated.
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

  const behavior = conflictBehaviorProblem(request, fields['@microsoft.graph.conflictBehavior'])

  if (behavior !== undefined) return behavior

  if (nameTaken(state, parent.id, name)) return nameConflict(request)

  const now = nowTimestamp(env)

  const folder: MicrosoftEmulatorDriveItem = {
    id: nextItemId(state),
    parentId: parent.id,
    name,
    kind: 'folder',
    size: 0,
    mimeType: null,
    quickXorHash: null,
    createdDateTime: now,
    lastModifiedDateTime: now
  }

  state.driveItems = [...state.driveItems, folder]

  return jsonResponse(
    201,
    entity(
      metadataContext(env, `${childrenContext(request)}/$entity`),
      renderItem(state, env, folder)
    )
  )
}

/** `DELETE /drives/{driveId}/items/{itemId}`: 204; the item and its subtree are removed. */
export const deleteItem: RouteHandler = (state, request) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const item = findItem(state, request.params.itemId ?? '')

  if (item === undefined) return notFound(request)

  if (item.parentId === null)
    return notEmulated(request, 'deleting the drive root is not emulated.')

  const removed = new Set(subtreeOf(state, item).map(entry => entry.id))

  state.driveItems = state.driveItems.filter(entry => !removed.has(entry.id))

  return emptyResponse(204)
}

const monitorPath = (state: MicrosoftEmulatorState, id: string) =>
  `/personal/${personalSite(state.user)}/_api/v2.0/monitor/${id}`

/**
 * `POST /drives/{driveId}/items/{itemId}/copy` (`{ parentReference: { driveId, id } }`, query
 * `@microsoft.graph.conflictBehavior=fail`): 202 with an empty body and one monitor `Location`.
 * The copy itself runs when the monitor reports completion. Only what the copy fixture sends is
 * emulated: a file source, a destination on the same drive named by `driveId` and `id`, and the
 * source's name (a new `name`, a folder source, or a missing `driveId` fail closed).
 */
export const copyItem: RouteHandler = (state, request, env) => {
  const drive = driveProblem(state, request)

  if (drive !== undefined) return drive

  const source = findItem(state, request.params.itemId ?? '')

  if (source === undefined) return notFound(request)

  if (source.kind !== 'file') {
    return notEmulated(request, 'copying a folder is not emulated (the fixture copies a file).')
  }

  const behavior = conflictBehaviorProblem(
    request,
    request.query.get('@microsoft.graph.conflictBehavior') ?? undefined
  )

  if (behavior !== undefined) return behavior

  // A new `name` fails here too: the fixture's copy keeps the source's name.
  const fields = bodyObject(request, ['parentReference'])

  if (fields instanceof Response) return fields

  const reference = nestedObject(
    request,
    fields.parentReference,
    ['driveId', 'id'],
    'parentReference { driveId, id }'
  )

  if (reference instanceof Response) return reference

  if (reference.driveId === undefined) {
    return notEmulated(request, 'copies without parentReference.driveId are not emulated.')
  }

  if (!Predicate.isString(reference.id) || !Predicate.isString(reference.driveId)) {
    return invalidValue(request, 'parentReference must be { driveId, id } with string values.')
  }

  if (reference.driveId !== state.drive.id) {
    return notEmulated(request, 'copies to another drive are not emulated.')
  }

  const destination = findItem(state, reference.id)

  if (destination === undefined) return notFound(request)

  if (destination.kind !== 'folder') {
    return invalidValue(request, 'the destination is not a folder.')
  }

  const number = env.monitorCounter.next

  env.monitorCounter.next += 1

  const monitor: CopyMonitor = {
    id: `00000000-0000-4000-8000-${padded(number, 12)}`,
    sourceId: source.id,
    destinationParentId: destination.id,
    pollsLeft: env.copyInProgressPolls,
    resourceId: undefined
  }

  env.monitors.set(monitor.id, monitor)

  return emptyResponse(202, {
    location: `${env.sharePointOrigin}${monitorPath(state, monitor.id)}`
  })
}

/** Copy the file `item` under `parentId` with a fresh id and its name; returns the new id. */
const copyFile = (
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  item: MicrosoftEmulatorDriveItem,
  parentId: string
): string => {
  const now = nowTimestamp(env)

  const copy: MicrosoftEmulatorDriveItem = {
    ...item,
    id: nextItemId(state),
    parentId,
    createdDateTime: now,
    lastModifiedDateTime: now
  }

  state.driveItems = [...state.driveItems, copy]

  return copy.id
}

/**
 * Run a monitored copy: its `resourceId`, or why it cannot run (the source or destination is
 * gone, or the name is taken; no fixture records a failed copy).
 */
const runCopy = (
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  monitor: CopyMonitor
): string | { readonly problem: string } => {
  const source = findItem(state, monitor.sourceId)
  const destination = findItem(state, monitor.destinationParentId)

  if (source === undefined || destination === undefined || destination.kind !== 'folder') {
    return { problem: 'the copy source or destination no longer exists' }
  }

  if (nameTaken(state, destination.id, source.name)) {
    return { problem: 'the copy name is already taken in the destination' }
  }

  return copyFile(state, env, source, destination.id)
}

const monitorContentType = 'application/json;odata.metadata=minimal;odata.streaming=true'

/**
 * `GET /personal/{site}/_api/v2.0/monitor/{monitorId}` on the SharePoint origin (no credentials
 * needed, like the real capability URL): `inProgress` (202) while polls remain, then the copy runs
 * once and every later poll answers `completed` (200, `resourceId`). A copy that cannot run
 * answers 400 not emulated (failed copies are not emulated) and stays pending.
 */
export const copyMonitor: RouteHandler = (state, request, env) => {
  const monitor = env.monitors.get(request.params.monitorId ?? '')

  if (monitor === undefined || request.params.site !== personalSite(state.user)) {
    return notFound(request)
  }

  const context = `${env.sharePointOrigin}/personal/${personalSite(state.user)}/_api/v2.0/$metadata#oneDrive.asynchronousOperationStatus`
  const headers = { 'content-type': monitorContentType }

  if (monitor.resourceId === undefined && monitor.pollsLeft > 0) {
    monitor.pollsLeft -= 1

    return jsonResponse(
      202,
      { '@odata.context': context, percentageComplete: 0, status: 'inProgress' },
      headers
    )
  }

  const resourceId = monitor.resourceId ?? runCopy(state, env, monitor)

  if (!Predicate.isString(resourceId)) {
    return notEmulated(request, `${resourceId.problem} (failed copies are not emulated).`)
  }

  monitor.resourceId = resourceId

  return jsonResponse(
    200,
    {
      '@odata.context': context,
      percentageComplete: 100,
      resourceId,
      status: 'completed'
    },
    headers
  )
}
