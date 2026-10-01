/**
 * Google Drive conformance cases (internal module; exported through `cases.ts`). See `cases.ts` for
 * the write-safety contract every write case follows.
 */
import { Effect, Ref } from 'effect'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual
} from '@yolk-sdk/conformance/case'
import {
  googleDriveCreateFolderAction,
  GoogleDriveCreateFolderInput,
  googleDriveDeleteFileAction,
  type GoogleDriveFile,
  GoogleDriveFileIdInput,
  googleDriveFolderMimeType,
  googleDriveGetFileAction,
  googleDriveListFilesAction,
  GoogleDriveListFilesInput,
  googleDriveTrashFileAction
} from '../drive.ts'
import { driveFolderLifecycleFixture } from './drive-folder-lifecycle.ts'
import { driveGetFileFieldsFixture } from './drive-get-file-fields.ts'
import { driveListPagingFixture } from './drive-list-paging.ts'
import {
  GoogleConformanceConfig,
  googleConformanceIntegration as integration,
  googleConformanceMarker,
  isNotFound,
  outcomeOf,
  requireSeed,
  successValue,
  withOwnedWrite,
  type GoogleConformanceCase
} from './shared.ts'

const listFiles = (input: ConstructorParameters<typeof GoogleDriveListFilesInput>[0]) =>
  googleDriveListFilesAction
    .executeTyped({ integration, input: GoogleDriveListFilesInput.make(input) })
    .pipe(Effect.flatMap(successValue(googleDriveListFilesAction.id)))

const getFile = (fileId: string) =>
  googleDriveGetFileAction.executeTyped({
    integration,
    input: GoogleDriveFileIdInput.make({ fileId })
  })

const deleteFile = (fileId: string) =>
  googleDriveDeleteFileAction.executeTyped({
    integration,
    input: GoogleDriveFileIdInput.make({ fileId })
  })

const parentsOf = (file: GoogleDriveFile): ReadonlyArray<string> => [...(file.parents ?? [])]

const filePageSize = 2

const pageCap = 10

/** Page size of the single listing the pages are compared with. */
const singleListingSize = 100

/** The folder's untrashed children on one page, failing when they do not fit on it. */
const folderChildren = (folderId: string) =>
  Effect.gen(function* () {
    const listing = yield* listFiles({ parentId: folderId, pageSize: singleListingSize })

    if (listing.nextPageToken !== undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: driveFolderId must hold at most ${singleListingSize} items`
      })
    }

    return [...listing.files]
  })

// Read cases.

export const driveListPagingCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.drive.list-page-token',
  title: 'A folder listing pages through nextPageToken to the same untrashed children as one page',
  safety: 'read',
  docs: "`drive.list_files` sends GET /drive/v3/files with `q` = `'<parentId>' in parents and trashed = false` (trashed items are excluded unless `includeTrashed`), `pageSize`, an opaque `pageToken`, `spaces=drive`, `corpora=user`, `supportsAllDrives`, `includeItemsFromAllDrives`, and `fields` naming every field it decodes; an answer without `files` counts as no files.",
  wire: 'For the seeded practice folder (3 to 20 items), `drive.list_files` with `parentId` and `pageSize: 100` answers every child on one page (no `nextPageToken`), each untrashed and listing the folder among its `parents`; with `pageSize: 2` each page answers at most two files and a `nextPageToken` while files remain, and feeding the tokens back as `pageToken` lists exactly the same files, none repeated. So a `nextPageToken` missing while files remain, a trashed file, or a file from another folder fails the case.',
  fixtures: [driveListPagingFixture.id],
  run: Effect.gen(function* () {
    const folderId = yield* requireSeed('driveFolderId')
    const children = yield* folderChildren(folderId)

    if (children.length <= filePageSize || children.length > pageCap * filePageSize) {
      return yield* new ConformanceMismatch({
        message: `precondition: driveFolderId must hold ${filePageSize + 1} to ${pageCap * filePageSize} items`
      })
    }

    for (const file of children) {
      yield* expectConformance(
        file.trashed !== true && parentsOf(file).includes(folderId),
        'expected every listed file to be an untrashed child of the folder',
        { actual: file.id }
      )
    }

    const seen: Array<string> = []
    let pageToken: string | undefined

    for (let page = 1; ; page++) {
      const listing = yield* listFiles(
        pageToken === undefined
          ? { parentId: folderId, pageSize: filePageSize }
          : { parentId: folderId, pageSize: filePageSize, pageToken }
      )

      const ids = [...listing.files].map(file => file.id)

      yield* expectConformance(
        ids.length <= filePageSize,
        'expected at most pageSize files on every page',
        { actual: ids.length }
      )
      yield* expectConformance(
        ids.every((id, index) => !seen.includes(id) && ids.indexOf(id) === index),
        'expected no file repeated within or across pages'
      )
      seen.push(...ids)

      if (listing.nextPageToken === undefined) {
        break
      }

      if (page >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `expected the listing to end within ${pageCap} pages`
        })
      }

      pageToken = listing.nextPageToken
    }

    yield* expectEqual(
      [...seen].sort(),
      children.map(file => file.id).sort(),
      'expected the pages to list exactly the files of the single listing'
    )
  })
})

export const driveGetFileFieldsCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.drive.get-file-fields',
  title: 'get_file accepts the connector fields selection and agrees with the list entry',
  safety: 'read',
  docs: '`drive.get_file` sends GET /drive/v3/files/{fileId} with `supportsAllDrives=true` and `fields` set to every file field the connector decodes (`googleDriveFileFields`), requires `id`, `name`, and `mimeType`, and keeps `parents`; `drive.list_files` asks for the same fields inside `files(...)`.',
  wire: 'For the seeded practice file, `drive.get_file` answers 2xx for the connector full `fields` selection (a field name Drive v3 does not know would answer 400), with the seeded id, a name, a mime type, and `parents` listing the seeded folder; its `id`, `name`, `mimeType`, and `parents` equal those of the same file in `drive.list_files` of that folder, so both reads decode the same metadata.',
  fixtures: [driveGetFileFieldsFixture.id],
  run: Effect.gen(function* () {
    const fileId = yield* requireSeed('driveFileId')
    const folderId = yield* requireSeed('driveFolderId')

    const file = yield* getFile(fileId).pipe(
      Effect.flatMap(successValue(googleDriveGetFileAction.id))
    )

    const entry = (yield* folderChildren(folderId)).find(child => child.id === fileId)

    if (entry === undefined) {
      return yield* new ConformanceMismatch({
        message: 'precondition: driveFileId must be an untrashed file directly inside driveFolderId'
      })
    }

    yield* expectConformance(
      file.id === fileId && parentsOf(file).includes(folderId),
      'expected get_file to answer the seeded id with the seeded folder among its parents'
    )
    yield* expectEqual(
      [file.id, file.name, file.mimeType, parentsOf(file)],
      [entry.id, entry.name, entry.mimeType, parentsOf(entry)],
      'expected get_file to answer the same metadata as the list entry'
    )
  })
})

// Write case.

const folderCaseId = 'google.drive.folder-trash-delete'

/** Delete a folder that may still exist (in Trash or not), by id, then verify it is not found. */
const ensureFolderDeleted = (fileId: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteFile(fileId)

    if (!isNotFound(deleted)) {
      yield* successValue(googleDriveDeleteFileAction.id)(deleted)
    }

    const read = yield* getFile(fileId)

    yield* expectConformance(
      isNotFound(read),
      'expected get_file to answer google_not_found after restoring',
      { actual: outcomeOf(read) }
    )
  })

export const driveFolderLifecycleCase: GoogleConformanceCase = defineConformanceCase({
  id: folderCaseId,
  title: 'A run folder is created, trashed (and hidden from listings), then permanently deleted',
  safety: 'write-reversible',
  docs: '`drive.create_folder` sends POST /drive/v3/files `{ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }`; `drive.trash_file` sends PATCH /drive/v3/files/{fileId} `{ trashed: true }` (Trash is recoverable); both decode the file with the full `fields` selection; `drive.delete_file` sends DELETE /drive/v3/files/{fileId}, which deletes permanently without going through Trash, and treats any 2xx as deleted without reading the body; `drive.get_file` maps 404 to `google_not_found`.',
  wire: '`drive.create_folder` with a run-scoped name in the seeded folder answers a folder (the folder mime type) with that name, the seeded parent, and no `trashed: true`; `drive.trash_file` answers it with `trashed: true`, `drive.get_file` reads it trashed, and `drive.list_files` of the parent leaves it out; `drive.delete_file` answers 2xx, and `drive.get_file` then answers `google_not_found`: the delete is permanent, even for a trashed folder. The case deletes its folder permanently, by id, even when a step fails, so nothing stays in Trash; only a failed cleanup can leave the folder there (recoverable for 30 days), which the leftover lookup reports.',
  fixtures: [driveFolderLifecycleFixture.id],
  run: Effect.gen(function* () {
    const folderId = yield* requireSeed('driveFolderId')
    const runId = yield* requireSeed('runId')
    const seeds = yield* GoogleConformanceConfig
    const name = `${googleConformanceMarker} ${runId} folder`

    yield* withOwnedWrite({
      caseId: folderCaseId,
      actionId: googleDriveCreateFolderAction.id,
      create: googleDriveCreateFolderAction.executeTyped({
        integration,
        input: GoogleDriveCreateFolderInput.make({ name, parentId: folderId })
      }),
      unknownRecovery: `delete the Drive folder "${name}" in folder ${folderId} by hand if it exists`,
      refuse: folder =>
        folder.name !== name ||
        folder.mimeType !== googleDriveFolderMimeType ||
        !parentsOf(folder).includes(folderId) ||
        folder.id === seeds.driveFolderId ||
        folder.id === seeds.driveFileId
          ? `Drive item ${folder.id} named "${folder.name}"`
          : undefined,
      recovery: folder => `delete the Drive folder ${folder.id} by hand if it still exists`,
      restore: folder => ensureFolderDeleted(folder.id),
      use: (folder, pending) =>
        Effect.gen(function* () {
          yield* expectConformance(
            folder.trashed !== true,
            'expected create_folder to answer an untrashed folder'
          )

          const trashed = yield* googleDriveTrashFileAction
            .executeTyped({
              integration,
              input: GoogleDriveFileIdInput.make({ fileId: folder.id })
            })
            .pipe(
              Effect.flatMap(successValue(googleDriveTrashFileAction.id)),
              Effect.uninterruptible
            )

          yield* expectEqual(
            [trashed.id, trashed.trashed ?? null],
            [folder.id, true],
            'expected trash_file to answer the folder with trashed true'
          )

          const read = yield* getFile(folder.id).pipe(
            Effect.flatMap(successValue(googleDriveGetFileAction.id))
          )

          yield* expectEqual(
            read.trashed ?? null,
            true,
            'expected get_file to read the folder trashed'
          )

          const children = yield* folderChildren(folderId)

          yield* expectConformance(
            children.every(child => child.id !== folder.id),
            'expected list_files to leave the trashed folder out'
          )

          yield* deleteFile(folder.id).pipe(
            Effect.flatMap(successValue(googleDriveDeleteFileAction.id)),
            Effect.uninterruptible
          )

          const gone = yield* getFile(folder.id)

          yield* expectConformance(
            isNotFound(gone),
            'expected get_file of the deleted folder to answer google_not_found',
            { actual: outcomeOf(gone) }
          )
          yield* Ref.set(pending, false)
        })
    })
  })
})
