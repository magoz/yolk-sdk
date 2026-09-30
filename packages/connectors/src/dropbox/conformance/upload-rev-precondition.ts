import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const rpc = (route: string, body: Schema.Json) => ({
  method: 'POST',
  url: `https://api.dropboxapi.com/2/files/${route}`,
  headers: { 'content-type': 'application/json' },
  body
})

const upload = (arg: Schema.Json, body: string) => ({
  method: 'POST',
  url: 'https://content.dropboxapi.com/2/files/upload',
  headers: {
    'content-type': 'application/octet-stream',
    'dropbox-api-arg': JSON.stringify(arg)
  },
  body
})

const json = (status: number, body: string) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body
})

const folderPath = '/Conformance/Work/yolk-conformance-run-synthetic-upload'

const filePath = `${folderPath}/yolk-conformance-upload.txt`

const fileId = 'id:SyntheticUploadFile0001'

const revA = 'a1b2c3d4e5f60040'

const revB = 'a1b2c3d4e5f60041'

const notFound =
  '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'

const uploadConflict =
  '{"error_summary": "path/conflict/file/..", "error": {".tag": "path", "path": {"reason": {".tag": "conflict", "conflict": {".tag": "file"}}}}}'

const folder = {
  name: 'yolk-conformance-run-synthetic-upload',
  path_lower: '/conformance/work/yolk-conformance-run-synthetic-upload',
  path_display: folderPath,
  id: 'id:SyntheticUploadFolder01'
}

const file = (rev: string) =>
  JSON.stringify({
    '.tag': 'file',
    name: 'yolk-conformance-upload.txt',
    path_lower: filePath.toLowerCase(),
    path_display: filePath,
    id: fileId,
    client_modified: '2026-09-29T14:00:00Z',
    server_modified: '2026-09-29T14:00:00Z',
    rev,
    size: 37,
    is_downloadable: true,
    content_hash: `00000000000000000000000000000000000000000000000000000000000000${rev.slice(-2)}`
  })

const addArg = { path: filePath, mode: 'add', autorename: false, strict_conflict: true }

const updateArg = {
  path: fileId,
  mode: { '.tag': 'update', update: revA },
  autorename: false,
  strict_conflict: true
}

/**
 * Absence check, the case-owned folder create, an `add` upload (rev A), an `update` with rev A
 * (rev B), a stale `update` still naming rev A and a second `add` (both 409 conflicts), the file
 * lookup still at rev B, then the restore: delete by id and a not-found lookup of the owned path.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxUploadRevPreconditionFixture: WireFixture = {
  id: 'dropbox.files.upload-rev-precondition.synthetic',
  caseId: 'dropbox.files.upload-rev-precondition',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://content.dropboxapi.com/2',
  note: 'Upload, update by rev, then a stale-rev update and a repeated add that both conflict, inside a case-owned folder that is deleted afterwards. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) },
    {
      request: rpc('create_folder_v2', { path: folderPath, autorename: false }),
      response: json(200, JSON.stringify({ metadata: folder }))
    },
    {
      request: upload(addArg, 'yolk-conformance synthetic upload v1\n'),
      response: json(200, file(revA))
    },
    {
      request: upload(updateArg, 'yolk-conformance synthetic upload v2\n'),
      response: json(200, file(revB))
    },
    {
      request: upload(updateArg, 'yolk-conformance synthetic upload v3\n'),
      response: json(409, uploadConflict)
    },
    {
      request: upload(addArg, 'yolk-conformance synthetic upload v3\n'),
      response: json(409, uploadConflict)
    },
    { request: rpc('get_metadata', { path: filePath }), response: json(200, file(revB)) },
    {
      request: rpc('delete_v2', { path: folder.id }),
      response: json(200, JSON.stringify({ metadata: { '.tag': 'folder', ...folder } }))
    },
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) }
  ]
}
