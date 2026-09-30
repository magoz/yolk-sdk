import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const page = (index: number) => ({
  object: 'page',
  id: `1f0000a0-0000-4000-8000-00000000000${index}`,
  created_time: '2026-09-20T09:00:00.000Z',
  last_edited_time: '2026-09-20T09:00:00.000Z',
  parent: { type: 'workspace', workspace: true },
  archived: false,
  in_trash: false,
  properties: {
    title: {
      id: 'title',
      type: 'title',
      title: [
        {
          type: 'text',
          text: { content: `yolk-search-probe ${index}`, link: null },
          plain_text: `yolk-search-probe ${index}`,
          href: null
        }
      ]
    }
  },
  url: `https://www.notion.so/yolk-search-probe-${index}-1f0000a0000040008000000000000${index}`
})

/**
 * A `page_size: 1` search for the seeded query with `has_more` and a `next_cursor`, then the last
 * page (`has_more: false`, `next_cursor: null`).
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionSearchPagingFixture: WireFixture = {
  id: 'notion.search.cursor-paging.synthetic',
  caseId: 'notion.search.cursor-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'Two search pages for the seeded query (two matching pages, page_size 1). Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.notion.com/v1/search',
        headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
        body: {
          query: 'yolk-search-probe',
          filter: { property: 'object', value: 'page' },
          page_size: 1
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [page(1)],
          next_cursor: '1f0000a0-0000-4000-8000-000000000002',
          has_more: true,
          type: 'page_or_data_source',
          page_or_data_source: {}
        })
      }
    },
    {
      request: {
        method: 'POST',
        url: 'https://api.notion.com/v1/search',
        headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
        body: {
          query: 'yolk-search-probe',
          filter: { property: 'object', value: 'page' },
          page_size: 1,
          start_cursor: '1f0000a0-0000-4000-8000-000000000002'
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [page(2)],
          next_cursor: null,
          has_more: false,
          type: 'page_or_data_source',
          page_or_data_source: {}
        })
      }
    }
  ]
}
