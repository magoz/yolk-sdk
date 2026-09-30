import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/**
 * `notion.get_bot_user`: one GET /v1/users/me carrying `Notion-Version: 2025-09-03`, answered with
 * the bot user.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const notionPinnedVersionFixture: WireFixture = {
  id: 'notion.api.pinned-version-accepted.synthetic',
  caseId: 'notion.api.pinned-version-accepted',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://api.notion.com/v1',
  note: 'The bot user read with the pinned Notion-Version header. Synthetic placeholder shaped like the Notion wire; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'GET',
        url: 'https://api.notion.com/v1/users/me',
        headers: { 'notion-version': '2025-09-03' }
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          object: 'user',
          id: '1f0000b0-0000-4000-8000-000000000001',
          name: 'Synthetic Integration',
          avatar_url: null,
          type: 'bot',
          bot: {
            owner: { type: 'workspace', workspace: true },
            workspace_name: 'Synthetic Workspace'
          },
          request_id: '00000000-0000-4000-8000-0000000000e2'
        })
      }
    }
  ]
}
