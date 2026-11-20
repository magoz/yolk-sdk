import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * The seeded site's document libraries, listed by its site id with literal commas.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftSharePointSiteDrivesFixture: WireFixture = {
  id: 'microsoft.sharepoint.site-drives-libraries.synthetic',
  caseId: 'microsoft.sharepoint.site-drives-libraries',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Document libraries of the seeded site (one without a description, sent as null), requested by its site id with the commas literal. Shape from the Microsoft Graph v1.0 docs (List drives, https://learn.microsoft.com/graph/api/drive-list). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/sites/synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222/drives?%24select=id%2Cname%2Cdescription%2CdriveType%2CwebUrl%2CcreatedDateTime%2ClastModifiedDateTime',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#drives(id,name,description,driveType,webUrl,createdDateTime,lastModifiedDateTime)","value":[{"id":"b!synthetic-library-0001","name":"Documents","description":null,"driveType":"documentLibrary","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team/Shared%20Documents","createdDateTime":"2026-08-03T09:00:00Z","lastModifiedDateTime":"2026-09-28T16:45:00Z"},{"id":"b!synthetic-library-0002","name":"Synthetic Records","description":"Synthetic records library","driveType":"documentLibrary","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team/Synthetic%20Records","createdDateTime":"2026-08-05T09:00:00Z","lastModifiedDateTime":"2026-09-20T12:00:00Z"}]}'
      }
    }
  ]
}
