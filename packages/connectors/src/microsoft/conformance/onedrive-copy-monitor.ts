import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * Source read, folder create, copy accepted with a monitor `Location`, a completed status poll, the folder listing, and the folder removal.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a replacement in a
 * gitignored directory; see the script header for the manual scrub-and-promote step.
 */
export const microsoftOneDriveCopyMonitorFixture: WireFixture = {
  id: 'microsoft.onedrive.copy-accepted-monitor.synthetic',
  caseId: 'microsoft.onedrive.copy-accepted-monitor',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Read the seeded source file, create a case-owned folder, copy the file into it (202 with one monitor Location), poll the monitor once (completed), list the folder, then delete the folder and GET it (404). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICSOURCEFILE00000000001?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(\'b%21synthetic-drive-0001\')/items(id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted)/$entity","id":"01SYNTHETICSOURCEFILE00000000001","name":"synthetic-notes.txt","size":24,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Sources/synthetic-notes.txt","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICSOURCEPARENT000000001","path":"/drive/root:/Sources"},"file":{"mimeType":"text/plain","hashes":{"quickXorHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICPARENTFOLDER0000000001/children',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          name: 'yolk-conformance-copy',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(\'b%21synthetic-drive-0001\')/items(\'01SYNTHETICPARENTFOLDER0000000001\')/children/$entity","id":"01SYNTHETICCOPYFOLDER00000000001","name":"yolk-conformance-copy","size":0,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Conformance/yolk-conformance-copy","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICPARENTFOLDER0000000001","path":"/drive/root:/Conformance"},"folder":{"childCount":0}}'
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICSOURCEFILE00000000001/copy?@microsoft.graph.conflictBehavior=fail',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: {
          parentReference: {
            driveId: 'b!synthetic-drive-0001',
            id: '01SYNTHETICCOPYFOLDER00000000001'
          }
        }
      },
      response: {
        status: 202,
        headers: {
          location:
            'https://synthetic-my.sharepoint.com/personal/ada_example_test/_api/v2.0/monitor/4f0c1b9e-3a6d-4c8e-9b21-7d5e2a1c0f33'
        },
        body: ''
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://synthetic-my.sharepoint.com/personal/ada_example_test/_api/v2.0/monitor/4f0c1b9e-3a6d-4c8e-9b21-7d5e2a1c0f33',
        headers: {
          accept: 'application/json'
        }
      },
      response: {
        status: 200,
        headers: {
          'content-type': 'application/json;odata.metadata=minimal;odata.streaming=true'
        },
        body: '{"@odata.context":"https://synthetic-my.sharepoint.com/personal/ada_example_test/_api/v2.0/$metadata#oneDrive.asynchronousOperationStatus","percentageComplete":100.0,"resourceId":"01SYNTHETICCOPIEDFILE00000000001","status":"completed"}'
      }
    },
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICCOPYFOLDER00000000001/children?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted&$top=200',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(\'b%21synthetic-drive-0001\')/items(\'01SYNTHETICCOPYFOLDER00000000001\')/children(id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted)","value":[{"id":"01SYNTHETICCOPIEDFILE00000000001","name":"synthetic-notes.txt","size":24,"webUrl":"https://synthetic-my.sharepoint.com/personal/ada_example_test/Documents/Conformance/yolk-conformance-copy/synthetic-notes.txt","createdDateTime":"2026-09-29T10:00:00Z","lastModifiedDateTime":"2026-09-29T10:00:00Z","eTag":"\\"{00000001-0000-4000-8000-000000000000},1\\"","cTag":"\\"c:{00000001-0000-4000-8000-000000000000},0\\"","parentReference":{"driveType":"business","driveId":"b!synthetic-drive-0001","id":"01SYNTHETICCOPYFOLDER00000000001","path":"/drive/root:/Conformance/yolk-conformance-copy"},"file":{"mimeType":"text/plain","hashes":{"quickXorHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}]}'
      }
    },
    {
      request: {
        method: 'DELETE',
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICCOPYFOLDER00000000001',
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
        url: 'https://graph.microsoft.com/v1.0/drives/b!synthetic-drive-0001/items/01SYNTHETICCOPYFOLDER00000000001?$select=id,name,size,webUrl,createdDateTime,lastModifiedDateTime,eTag,cTag,parentReference,file,folder,package,remoteItem,shared,deleted',
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
        body: '{"error":{"code":"itemNotFound","message":"The resource could not be found.","innerError":{"date":"2026-09-29T10:00:06","request-id":"00000000-0000-4000-8000-000000000006","client-request-id":"00000000-0000-4000-8000-000000000006"}}}'
      }
    }
  ]
}
