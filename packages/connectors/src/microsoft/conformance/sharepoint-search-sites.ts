import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * A keyword site search that lists the seeded team site with its comma-separated site id.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:microsoft --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const microsoftSharePointSearchSitesFixture: WireFixture = {
  id: 'microsoft.sharepoint.search-finds-site.synthetic',
  caseId: 'microsoft.sharepoint.search-finds-site',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://graph.microsoft.com/v1.0',
  note: 'Site search for the seeded keyword: the seeded team site and one more site, each with a {hostname},{site-collection-id},{web-id} id. Shape from the Microsoft Graph v1.0 docs (Search for sites, https://learn.microsoft.com/graph/api/site-search). Synthetic placeholder shaped like the Microsoft Graph wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/sites?search=synthetic',
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
        body: '{"@odata.context":"https://graph.microsoft.com/v1.0/$metadata#sites","value":[{"createdDateTime":"2026-08-03T09:00:00Z","description":"Synthetic practice team site","id":"synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222","lastModifiedDateTime":"2026-09-28T16:45:00Z","name":"synthetic-team","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-team","displayName":"Synthetic Team"},{"createdDateTime":"2026-08-04T09:00:00Z","description":null,"id":"synthetic.sharepoint.com,11111111-1111-4111-8111-111111111111,33333333-3333-4333-8333-333333333333","lastModifiedDateTime":"2026-09-01T08:00:00Z","name":"synthetic-archive","webUrl":"https://synthetic.sharepoint.com/sites/synthetic-archive","displayName":"Synthetic Archive"}]}'
      }
    }
  ]
}
