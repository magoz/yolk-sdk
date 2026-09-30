import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const rpc = (route: string, body: Schema.Json) => ({
  method: 'POST',
  url: `https://api.dropboxapi.com/2/files/${route}`,
  headers: { 'content-type': 'application/json' },
  body
})

const json = (status: number, body: string) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body
})

const folderPath = '/Conformance/Work/yolk-conformance-folder'

const notFound =
  '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'

const conflict =
  '{"error_summary": "path/conflict/folder/..", "error": {".tag": "path", "path": {".tag": "conflict", "conflict": {".tag": "folder"}}}}'

const folder = {
  name: 'yolk-conformance-folder',
  path_lower: '/conformance/work/yolk-conformance-folder',
  path_display: folderPath,
  id: 'id:SyntheticConflictFolder1'
}

/**
 * Absence check, the case-owned folder create (no `.tag` in its metadata), the same create again
 * and upper-cased (both 409 `path/conflict/folder`), then the restore: delete and a final
 * not-found lookup.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxCreateFolderConflictFixture: WireFixture = {
  id: 'dropbox.files.create-folder-conflict.synthetic',
  caseId: 'dropbox.files.create-folder-conflict',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'Create a case-owned folder, create it again in the same and in upper casing (409 conflicts), then delete it and confirm it is gone. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) },
    {
      request: rpc('create_folder_v2', { path: folderPath, autorename: false }),
      response: json(200, JSON.stringify({ metadata: folder }))
    },
    {
      request: rpc('create_folder_v2', { path: folderPath, autorename: false }),
      response: json(409, conflict)
    },
    {
      request: rpc('create_folder_v2', {
        path: '/Conformance/Work/YOLK-CONFORMANCE-FOLDER',
        autorename: false
      }),
      response: json(409, conflict)
    },
    {
      request: rpc('delete_v2', { path: folderPath }),
      response: json(200, JSON.stringify({ metadata: { '.tag': 'folder', ...folder } }))
    },
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) }
  ]
}
