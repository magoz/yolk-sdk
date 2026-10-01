import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Folder create (201), parent listing including it, DELETE (204), and GET of the deleted folder (404).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftOneDriveCreateFolderFixture: WireFixture = {
  id: 'microsoft.onedrive.create-folder-roundtrip.synthetic',
  caseId: 'microsoft.onedrive.create-folder-roundtrip',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Create a case-owned folder under the seeded parent, list the parent, delete the folder, and GET it (404). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICPARENTFOLDER0000000001/children',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          name: 'yolk-conformance-folder',
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail'
        }
      },
      response: {
        status: 201,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(\'b%21synthetic-drive-0001\')/items(\'01SYNTHETICPARENTFOLDER0000000001\')/children/$entity","id":"01SYNTHETICNEWFOLDER000000000001","name":"yolk-conformance-folder","size":0,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Conformance/yolk-conformance-folder","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICPARENTFOLDER0000000001","path":"/drive/root:/Conformance"},"folder":{"childCount":0}}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICPARENTFOLDER0000000001/children?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted&$top=200',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(\'b%21synthetic-drive-0001\')/items(\'01SYNTHETICPARENTFOLDER0000000001\')/children(id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted)","value":[{"id":"01SYNTHETICEXISTINGFILE000000001","name":"synthetic-existing.txt","size":12,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Conformance/synthetic-existing.txt","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICPARENTFOLDER0000000001","path":"/drive/root:/Conformance"},"file":{"mimeType":"text/plain","hashes":{"quickXorHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAA="}}},{"id":"01SYNTHETICNEWFOLDER000000000001","name":"yolk-conformance-folder","size":0,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Conformance/yolk-conformance-folder","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICPARENTFOLDER0000000001","path":"/drive/root:/Conformance"},"folder":{"childCount":0}}]}'
      }
    },
    {
      request: {
        method: 'DELETE',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICNEWFOLDER000000000001',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 204,
        headers: {},
        body: ''
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICNEWFOLDER000000000001?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 404,
        headers: {
          'content-type':
            'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'
        },
        body: '{"error":{"code":"itemNotFound","message":"The resource could not be found.","innerError":{"date":"2026-09-29T10:00:05","request-id":"00000000-0000-4000-8000-000000000005","client-request-id":"00000000-0000-4000-8000-000000000005"}}}'
      }
    }
  ]
}
