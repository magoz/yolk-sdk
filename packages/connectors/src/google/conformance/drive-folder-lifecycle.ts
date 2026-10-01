import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { googleDriveFolderMimeType } from '../drive.ts'
import {
  driveCreateUrl,
  driveDeleteUrl,
  driveFileUrl,
  driveListUrl,
  driveReadRequestHeaders,
  driveSyntheticChildren,
  driveSyntheticFile,
  driveSyntheticFileList,
  driveSyntheticFolderId,
  driveWriteRequestHeaders,
  googleErrorBody,
  googleJson,
  googleNoContent
} from './synthetic.ts'

const folderId = 'synthetic-conformance-folder-0001'

const name = 'yolk-conformance run-synthetic folder'

const folder = (trashed: boolean) =>
  driveSyntheticFile({ id: folderId, name, mimeType: googleDriveFolderMimeType, trashed })

const read = { method: 'GET', url: driveFileUrl(folderId), headers: driveReadRequestHeaders }

/**
 * A run-scoped folder created in the practice folder, trashed, read trashed, left out of the
 * folder listing, deleted permanently by id (204), and read again (404).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const driveFolderLifecycleFixture: WireFixture = {
  id: 'google.drive.folder-trash-delete.synthetic',
  caseId: 'google.drive.folder-trash-delete',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/drive/v3',
  note: 'Create a run folder, trash it, read it trashed, list the parent without it, delete it permanently (204), and read it (404). Synthetic placeholder shaped like the Drive API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: driveCreateUrl,
        headers: driveWriteRequestHeaders,
        body: { name, mimeType: googleDriveFolderMimeType, parents: [driveSyntheticFolderId] }
      },
      response: googleJson(200, folder(false))
    },
    {
      request: {
        method: 'PATCH',
        url: driveFileUrl(folderId),
        headers: driveWriteRequestHeaders,
        body: { trashed: true }
      },
      response: googleJson(200, folder(true))
    },
    { request: read, response: googleJson(200, folder(true)) },
    {
      request: {
        method: 'GET',
        url: driveListUrl(driveSyntheticFolderId, { pageSize: 100 }),
        headers: driveReadRequestHeaders
      },
      response: driveSyntheticFileList(driveSyntheticChildren)
    },
    {
      request: {
        method: 'DELETE',
        url: driveDeleteUrl(folderId),
        headers: driveReadRequestHeaders
      },
      response: googleNoContent
    },
    {
      request: read,
      response: googleJson(
        404,
        googleErrorBody(404, `File not found: ${folderId}.`, 'notFound', 'NOT_FOUND')
      )
    }
  ]
}
