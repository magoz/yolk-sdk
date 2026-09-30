import type { WireFixture } from '@yolk-sdk/conformance/fixture'

const parentPageId = '1f000000-0000-4000-8000-000000000005'

const pageId = '1f0000e0-0000-4000-8000-000000000001'

const page = (trashed: boolean) =>
  JSON.stringify({
    object: 'page',
    id: pageId,
    created_time: '2026-09-29T15:00:00.000Z',
    last_edited_time: '2026-09-29T15:00:00.000Z',
    parent: { type: 'page_id', page_id: parentPageId },
    archived: trashed,
    in_trash: trashed,
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: [
          {
            type: 'text',
            text: { content: 'yolk-conformance page: safe to delete', link: null },
            plain_text: 'yolk-conformance page: safe to delete',
            href: null
          }
        ]
      }
    },
    url: 'https://www.notion.so/yolk-conformance-page-safe-to-delete-1f0000e0000040008000000000000001'
  })

/**
 * The case-owned page create, the archive PATCH (`archived` and `in_trash` true), and a GET that
 * still answers with `archived: true`.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionArchiveInTrashFixture: WireFixture = {
  id: 'notion.pages.archive-in-trash.synthetic',
  caseId: 'notion.pages.archive-in-trash',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'Create a case-owned page under the seeded parent page, archive it, and read it back. Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: 'https://api.notion.com/v1/pages',
        headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
        body: {
          parent: { page_id: parentPageId },
          properties: {
            title: { title: [{ text: { content: 'yolk-conformance page: safe to delete' } }] }
          }
        }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: page(false)
      }
    },
    {
      request: {
        method: 'PATCH',
        url: `https://api.notion.com/v1/pages/${pageId}`,
        headers: { 'content-type': 'application/json', 'notion-version': '2025-09-03' },
        body: { archived: true }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: page(true)
      }
    },
    {
      request: {
        method: 'GET',
        url: `https://api.notion.com/v1/pages/${pageId}`,
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: page(true)
      }
    }
  ]
}
