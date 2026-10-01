import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  gmailNotFound,
  gmailSyntheticApi,
  gmailSyntheticLabel,
  gmailSyntheticMinimalMessage,
  googleJson,
  googleJsonRequestHeaders,
  googleNoContent
} from './synthetic.ts'

const workMessageId = '18f00000000000b1'

const labelId = 'Label_9101'

const name = 'yolk-conformance run-synthetic label'

const workMessage = {
  method: 'GET',
  url: `${gmailSyntheticApi}/messages/${workMessageId}?format=minimal`
}

const labelUrl = `${gmailSyntheticApi}/labels/${labelId}`

/**
 * A run label created, applied to the seeded work message, read back, deleted by id, read again
 * (not found), and gone from the message.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailLabelLifecycleFixture: WireFixture = {
  id: 'google.gmail.label-create-apply-delete.synthetic',
  caseId: 'google.gmail.label-create-apply-delete',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'Create a run label, add it to the work message, read the message, delete the label (204), read the label (404), and read the message without it. Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${gmailSyntheticApi}/labels`,
        headers: googleJsonRequestHeaders,
        body: { name }
      },
      response: googleJson(200, gmailSyntheticLabel(labelId, name))
    },
    {
      request: {
        method: 'POST',
        url: `${gmailSyntheticApi}/messages/${workMessageId}/modify`,
        headers: googleJsonRequestHeaders,
        body: { addLabelIds: [labelId] }
      },
      response: googleJson(200, {
        id: workMessageId,
        threadId: workMessageId,
        labelIds: ['INBOX', 'IMPORTANT', labelId]
      })
    },
    {
      request: workMessage,
      response: googleJson(
        200,
        gmailSyntheticMinimalMessage(workMessageId, ['INBOX', 'IMPORTANT', labelId])
      )
    },
    { request: { method: 'DELETE', url: labelUrl }, response: googleNoContent },
    { request: { method: 'GET', url: labelUrl }, response: gmailNotFound },
    {
      request: workMessage,
      response: googleJson(200, gmailSyntheticMinimalMessage(workMessageId, ['INBOX', 'IMPORTANT']))
    }
  ]
}
