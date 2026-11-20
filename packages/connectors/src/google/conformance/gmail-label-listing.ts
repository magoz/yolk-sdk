import type * as Schema from 'effect/Schema'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { gmailSyntheticApi, gmailSyntheticLabel, googleJson } from './synthetic.ts'

/** A system label as the label listing answers it (some carry no visibility fields). */
const systemLabel = (id: string, hidden: boolean): Schema.Json =>
  hidden
    ? {
        id,
        name: id,
        messageListVisibility: 'hide',
        labelListVisibility: 'labelHide',
        type: 'system'
      }
    : { id, name: id, type: 'system' }

/**
 * The label listing as the read-only leftover lookup sends it: the system labels, then the seeded
 * paging label, a user label.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it. The shapes
 * follow the Gmail API reference, fetched 2026-11-20: `users.labels.list` (`{ labels: [Label] }`,
 * each label holding only `id`, `name`, `messageListVisibility`, `labelListVisibility`, and
 * `type`; no message counts;
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list) and the
 * `Label` resource (`type` `system` or `user`;
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels), with the
 * user-label shape of the label fixture. Not in the reference: which system labels Gmail lists,
 * that their `name` equals their `id`, and which of them omit the visibility fields (a synthetic
 * choice here).
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailLabelListingFixture: WireFixture = {
  id: 'google.gmail.label-listing.synthetic',
  caseId: 'google.gmail.label-listing',
  evidence: 'unverified',
  recordedAt: '2026-11-20',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'The label listing: eight system labels, then the seeded paging label (a user label). Synthetic placeholder shaped from the Gmail API reference (fetched 2026-11-20; users.labels.list: { labels: [Label] }, each with only id, name, messageListVisibility, labelListVisibility, and type: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list; Label type system or user: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels) and the user-label shape of the label fixture. Not in the reference: which system labels are listed, their names, and which omit the visibilities (synthetic). Not recorded from a live service.',
  exchanges: [
    {
      request: { method: 'GET', url: `${gmailSyntheticApi}/labels` },
      response: googleJson(200, {
        labels: [
          systemLabel('INBOX', false),
          systemLabel('SENT', false),
          systemLabel('IMPORTANT', true),
          systemLabel('TRASH', true),
          systemLabel('DRAFT', true),
          systemLabel('SPAM', true),
          systemLabel('STARRED', true),
          systemLabel('UNREAD', false),
          gmailSyntheticLabel('Label_9001', 'Synthetic paging')
        ]
      })
    }
  ]
}
