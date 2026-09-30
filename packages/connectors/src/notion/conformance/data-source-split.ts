import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const databaseId = '1f000000-0000-4000-8000-000000000004'

const dataSourceId = '1f0000d0-0000-4000-8000-000000000001'

const parentPageId = '1f0000d0-0000-4000-8000-0000000000aa'

const title = (text: string) => [
  { type: 'text', text: { content: text, link: null }, plain_text: text, href: null }
]

/**
 * The seeded database listing its data source (no `properties`), that data source with its
 * schema and database parent, and a `page_size: 1` query answering a page whose parent is the data
 * source.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionDataSourceSplitFixture: WireFixture = {
  id: 'notion.data-sources.database-split.synthetic',
  caseId: 'notion.data-sources.database-split',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'The seeded database, its first data source, and one queried row. Synthetic placeholder shaped like the Notion wire (API version 2025-09-03); not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `https://api.notion.com/v1/databases/${databaseId}`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'database',
          id: databaseId,
          title: title('Synthetic Tasks'),
          description: [],
          parent: { type: 'page_id', page_id: parentPageId },
          is_inline: false,
          in_trash: false,
          archived: false,
          created_time: '2026-09-20T09:00:00.000Z',
          last_edited_time: '2026-09-20T09:00:00.000Z',
          data_sources: [{ id: dataSourceId, name: 'Synthetic Tasks' }],
          url: 'https://www.notion.so/1f000000000040008000000000000004'
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: `https://api.notion.com/v1/data_sources/${dataSourceId}`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'data_source',
          id: dataSourceId,
          parent: { type: 'database_id', database_id: databaseId },
          database_parent: { type: 'page_id', page_id: parentPageId },
          title: title('Synthetic Tasks'),
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title', title: {} },
            Done: { id: 'Syn%3Ad', name: 'Done', type: 'checkbox', checkbox: {} }
          },
          archived: false,
          in_trash: false
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
        headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
        body: { page_size: 1 }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [
            {
              object: 'page',
              id: '1f0000d0-0000-4000-8000-000000000101',
              parent: {
                type: 'data_source_id',
                data_source_id: dataSourceId,
                database_id: databaseId
              },
              archived: false,
              in_trash: false,
              properties: {
                Name: { id: 'title', type: 'title', title: title('Synthetic task 1') },
                Done: { id: 'Syn%3Ad', type: 'checkbox', checkbox: false }
              },
              url: 'https://www.notion.so/Synthetic-task-1-1f0000d0000040008000000000000101'
            }
          ],
          next_cursor: '1f0000d0-0000-4000-8000-000000000102',
          has_more: true,
          type: 'page_or_data_source',
          page_or_data_source: {}
        })
      }
    }
  ]
}
