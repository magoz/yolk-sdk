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

const folderPath = '/Conformance/Work/yolk-conformance-copy'

const notFound =
  '{"error_summary": "path/not_found/.", "error": {".tag": "path", "path": {".tag": "not_found"}}}'

const folder = {
  name: 'yolk-conformance-copy',
  path_lower: '/conformance/work/yolk-conformance-copy',
  path_display: folderPath,
  id: 'id:SyntheticCopyFolder0001'
}

const file = (input: { name: string; folder: string; id: string; rev: string }) => ({
  '.tag': 'file',
  name: input.name,
  path_lower: `${input.folder}/${input.name}`.toLowerCase(),
  path_display: `${input.folder}/${input.name}`,
  id: input.id,
  client_modified: '2026-09-20T13:00:00Z',
  server_modified: '2026-09-29T13:00:00Z',
  rev: input.rev,
  size: 42,
  is_downloadable: true,
  content_hash: '0000000000000000000000000000000000000000000000000000000000000042'
})

/**
 * The source lookup, absence check, the case-owned folder create, `copy_v2` and `move_v2`
 * answering `{ metadata }`, then the restore: delete and a final not-found lookup.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const dropboxCopyMoveMetadataFixture: WireFixture = {
  id: 'dropbox.files.copy-move-metadata.synthetic',
  caseId: 'dropbox.files.copy-move-metadata',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.dropboxapi.com/2',
  note: 'Copy the seeded source file into a case-owned folder, move the copy to a new name, then delete the folder. Synthetic placeholder shaped like the Dropbox wire; not recorded from a live service.',
  exchanges: [
    {
      request: rpc('get_metadata', { path: '/Conformance/copy-source.txt' }),
      response: json(
        200,
        JSON.stringify(
          file({
            name: 'copy-source.txt',
            folder: '/Conformance',
            id: 'id:SyntheticCopySource001',
            rev: 'a1b2c3d4e5f60030'
          })
        )
      )
    },
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) },
    {
      request: rpc('create_folder_v2', { path: folderPath, autorename: false }),
      response: json(200, JSON.stringify({ metadata: folder }))
    },
    {
      request: rpc('copy_v2', {
        from_path: '/Conformance/copy-source.txt',
        to_path: `${folderPath}/yolk-conformance-copied`,
        autorename: false
      }),
      response: json(
        200,
        JSON.stringify({
          metadata: file({
            name: 'yolk-conformance-copied',
            folder: folderPath,
            id: 'id:SyntheticCopiedFile0001',
            rev: 'a1b2c3d4e5f60031'
          })
        })
      )
    },
    {
      request: rpc('move_v2', {
        from_path: `${folderPath}/yolk-conformance-copied`,
        to_path: `${folderPath}/yolk-conformance-moved`,
        autorename: false
      }),
      response: json(
        200,
        JSON.stringify({
          metadata: file({
            name: 'yolk-conformance-moved',
            folder: folderPath,
            id: 'id:SyntheticCopiedFile0001',
            rev: 'a1b2c3d4e5f60032'
          })
        })
      )
    },
    {
      request: rpc('delete_v2', { path: folderPath }),
      response: json(200, JSON.stringify({ metadata: { '.tag': 'folder', ...folder } }))
    },
    { request: rpc('get_metadata', { path: folderPath }), response: json(409, notFound) }
  ]
}
