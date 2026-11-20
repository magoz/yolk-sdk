import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  driveListUrl,
  driveReadRequestHeaders,
  driveSyntheticChildren,
  driveSyntheticFileList,
  driveSyntheticFolderId
} from './synthetic.ts'

/**
 * The seeded practice folder listed without trashed items, then with them, as the read-only
 * leftover lookup lists it (`includeTrashed`, `pageSize=100`): the folder holds nothing in Trash,
 * so both answer the same five children.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shapes
 * follow the Drive API reference, fetched 2026-11-20: `files.list` (it "returns all files by
 * default, including trashed files"; a `FileList` of `files`, `nextPageToken` while more remain,
 * `kind`, and `incompleteSearch`;
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) and the search
 * guide (`'<id>' in parents` for direct children, `trashed = false` to leave Trash out;
 * https://developers.google.com/workspace/drive/api/guides/search-files), with the file shape of
 * the other Drive fixtures. `pnpm conformance:google --live --owner-approved --account <label>
 * --record` stages a replacement in a gitignored directory; see the script header for the manual
 * scrub-and-promote step.
 */
export const driveListTrashedFixture: WireFixture = {
  id: 'google.drive.list-includes-trashed.synthetic',
  caseId: 'google.drive.list-includes-trashed',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/drive/v3',
  note: "List the practice folder without trashed items, then with them (q='<folder>' in parents, as the leftover lookup sends it): the same five children, none in Trash. Synthetic placeholder shaped from the Drive API reference (fetched 2026-11-20; files.list returns trashed files unless q says trashed = false, a FileList of files: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list; the q syntax: https://developers.google.com/workspace/drive/api/guides/search-files) and the file shape of the other Drive fixtures. Not recorded from a live service.",
  exchanges: [
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
        method: 'GET',
        url: driveListUrl(driveSyntheticFolderId, { pageSize: 100, includeTrashed: true }),
        headers: driveReadRequestHeaders
      },
      response: driveSyntheticFileList(driveSyntheticChildren)
    }
  ]
}
