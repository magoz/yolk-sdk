import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const pageId = '1f000000-0000-4000-8000-000000000003'

// The seeded property id is `Syn%3Ap` (as the page object returns it); the connector encodes it
// once more for the path.
const propertyUrl = `https://api.notion.com/v1/pages/${pageId}/properties/Syn%253Ap`

const item = (index: number) => ({
  object: 'property_item',
  id: 'Syn%3Ap',
  type: 'rich_text',
  rich_text: {
    type: 'text',
    text: { content: `Synthetic segment ${index} `, link: null },
    plain_text: `Synthetic segment ${index} `,
    href: null
  }
})

/**
 * A `page_size=2` page of the seeded rich_text property's items with `has_more` and a
 * `next_cursor`, then the last page.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionPropertyItemPagingFixture: WireFixture = {
  id: 'notion.pages.property-item-paging.synthetic',
  caseId: 'notion.pages.property-item-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'Two pages of property items of the seeded rich_text property (three segments, page_size 2). Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `${propertyUrl}?page_size=2`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [item(1), item(2)],
          next_cursor: 'c3ludGhldGljLXByb3BlcnR5LWN1cnNvcg',
          has_more: true,
          type: 'property_item',
          property_item: {
            id: 'Syn%3Ap',
            next_url: `https://api.notion.com/v1/pages/${pageId}/properties/Syn%3Ap?start_cursor=c3ludGhldGljLXByb3BlcnR5LWN1cnNvcg`,
            type: 'rich_text',
            rich_text: {}
          }
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: `${propertyUrl}?page_size=2&start_cursor=c3ludGhldGljLXByb3BlcnR5LWN1cnNvcg`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [item(3)],
          next_cursor: null,
          has_more: false,
          type: 'property_item',
          property_item: { id: 'Syn%3Ap', next_url: null, type: 'rich_text', rich_text: {} }
        })
      }
    }
  ]
}
