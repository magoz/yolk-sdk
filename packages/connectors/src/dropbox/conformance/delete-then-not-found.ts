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

const folderPath = '/Conformance/Work/yolk-conformance-delete'

const notFound =
  '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'

const folder = {
  name: 'yolk-conformance-delete',
  path_lower: '/conformance/work/yolk-conformance-delete',
  path_display: folderPath,
  id: 'id:SyntheticDeleteFolder01'
}

/**
 * Absence check, the case-owned folder create, `delete_v2` (metadata tagged `folder`), a
 * not-found lookup, and the `include_deleted` lookup answering `deleted` metadata.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxDeleteThenNotFoundFixture: WireFixture = {
  id: 'dropbox.files.delete-then-not-found.synthetic',
  caseId: 'dropbox.files.delete-then-not-found',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'Create a case-owned folder, delete it, and look it up without and with include_deleted. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) },
    {
      request: rpc('create_folder_v2', { path: folderPath, autorename: false }),
      response: json(200, JSON.stringify({ metadata: folder }))
    },
    {
      request: rpc('delete_v2', { path: folderPath }),
      response: json(200, JSON.stringify({ metadata: { '.tag': 'folder', ...folder } }))
    },
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) },
    {
      request: rpc('get_metadata', { path: folderPath, include_deleted: true }),
      response: json(
        200,
        JSON.stringify({
          '.tag': 'deleted',
          name: folder.name,
          path_lower: folder.path_lower,
          path_display: folder.path_display
        })
      )
    }
  ]
}
