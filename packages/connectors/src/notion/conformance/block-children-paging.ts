import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const pageId = '1f000000-0000-4000-8000-000000000002'

const paragraph = (index: number) => ({
  object: 'block',
  id: `1f0000c0-0000-4000-8000-00000000000${index}`,
  parent: { type: 'page_id', page_id: pageId },
  created_time: '2026-09-20T09:00:00.000Z',
  last_edited_time: '2026-09-20T09:00:00.000Z',
  has_children: false,
  archived: false,
  in_trash: false,
  type: 'paragraph',
  paragraph: {
    rich_text: [
      {
        type: 'text',
        text: { content: `Synthetic paragraph ${index}`, link: null },
        plain_text: `Synthetic paragraph ${index}`,
        href: null
      }
    ],
    color: 'default'
  }
})

/**
 * A `page_size=2` page of the seeded page's child blocks with `has_more` and a `next_cursor`,
 * then the last page.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionBlockChildrenPagingFixture: WireFixture = {
  id: 'notion.blocks.children-cursor-paging.synthetic',
  caseId: 'notion.blocks.children-cursor-paging',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'Two pages of child blocks of the seeded page (three paragraphs, page_size 2). Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: `https://api.notion.com/v1/blocks/${pageId}/children?page_size=2`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [paragraph(1), paragraph(2)],
          next_cursor: '1f0000c0-0000-4000-8000-000000000003',
          has_more: true,
          type: 'block',
          block: {}
        })
      }
    },
    {
      request: {
        method: 'GET',
        url: `https://api.notion.com/v1/blocks/${pageId}/children?page_size=2&start_cursor=1f0000c0-0000-4000-8000-000000000003`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'list',
          results: [paragraph(3)],
          next_cursor: null,
          has_more: false,
          type: 'block',
          block: {}
        })
      }
    }
  ]
}
