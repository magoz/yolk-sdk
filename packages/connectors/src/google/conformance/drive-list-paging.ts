import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  driveListUrl,
  driveReadRequestHeaders,
  driveSyntheticChildren,
  driveSyntheticFileList,
  driveSyntheticFolderId
} from './synthetic.ts'

const list = (pageSize: number, pageToken?: string) => ({
  method: 'GET',
  url: driveListUrl(
    driveSyntheticFolderId,
    pageToken === undefined ? { pageSize } : { pageSize, pageToken }
  ),
  headers: driveReadRequestHeaders
})

/**
 * The seeded practice folder listed on one page (`pageSize=100`), then in pages of two chained
 * through `nextPageToken`: the same five untrashed children.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const driveListPagingFixture: WireFixture = {
  id: 'google.drive.list-page-token.synthetic',
  caseId: 'google.drive.list-page-token',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/drive/v3',
  note: 'List the practice folder on one page, then two files at a time, feeding nextPageToken back as pageToken. Synthetic placeholder shaped like the Drive API; not recorded from a live service.',
  exchanges: [
    { request: list(100), response: driveSyntheticFileList(driveSyntheticChildren) },
    {
      request: list(2),
      response: driveSyntheticFileList(driveSyntheticChildren.slice(0, 2), 'synthetic-drive-page-2')
    },
    {
      request: list(2, 'synthetic-drive-page-2'),
      response: driveSyntheticFileList(driveSyntheticChildren.slice(2, 4), 'synthetic-drive-page-3')
    },
    {
      request: list(2, 'synthetic-drive-page-3'),
      response: driveSyntheticFileList(driveSyntheticChildren.slice(4))
    }
  ]
}
