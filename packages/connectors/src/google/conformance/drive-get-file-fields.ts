import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  driveFileUrl,
  driveListUrl,
  driveReadRequestHeaders,
  driveSyntheticChildren,
  driveSyntheticFileList,
  driveSyntheticFolderId,
  googleJson
} from './synthetic.ts'

/**
 * `drive.get_file` of the seeded practice file with the connector's full `fields` selection, then
 * the practice folder listing that holds it.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const driveGetFileFieldsFixture: WireFixture = {
  id: 'google.drive.get-file-fields.synthetic',
  caseId: 'google.drive.get-file-fields',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://www.googleapis.com/drive/v3',
  note: 'Get the practice file with the full fields selection, then list the practice folder and compare the entry. Synthetic placeholder shaped like the Drive API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: driveFileUrl('synthetic-practice-file-0001'),
        headers: driveReadRequestHeaders
      },
      response: googleJson(200, driveSyntheticChildren[0] ?? null)
    },
    {
      request: {
        method: 'GET',
        url: driveListUrl(driveSyntheticFolderId, { pageSize: 100 }),
        headers: driveReadRequestHeaders
      },
      response: driveSyntheticFileList(driveSyntheticChildren)
    }
  ]
}
