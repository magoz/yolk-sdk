import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const annotations = (bold: boolean) => ({
  bold,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default'
})

/**
 * The seeded page with one `title` property of two text items whose `plain_text` joins to the
 * seeded title.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionTitlePlainTextFixture: WireFixture = {
  id: 'notion.pages.title-plain-text.synthetic',
  caseId: 'notion.pages.title-plain-text',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'The seeded title page, its title split over two rich text items (plain and bold). Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.notion.com/v1/pages/1f000000-0000-4000-8000-000000000001',
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'page',
          id: '1f000000-0000-4000-8000-000000000001',
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
                  text: { content: 'Synthetic ', link: null },
                  annotations: annotations(false),
                  plain_text: 'Synthetic ',
                  href: null
                },
                {
                  type: 'text',
                  text: { content: 'Title Page', link: null },
                  annotations: annotations(true),
                  plain_text: 'Title Page',
                  href: null
                }
              ]
            }
          },
          url: 'https://www.notion.so/Synthetic-Title-Page-1f000000000040008000000000000001'
        })
      }
    }
  ]
}
