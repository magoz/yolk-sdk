import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  base64UrlOfText,
  gmailConformanceDraftText,
  gmailConformanceUpdatedDraftText,
  gmailNotFound,
  gmailSyntheticApi,
  googleJson,
  googleJsonRequestHeaders,
  googleNoContent
} from './synthetic.ts'

const draftId = 'r-8000000000000000001'

const threadId = '18f00000000000d1'

const firstMessageId = '18f00000000000d1'

const updatedMessageId = '18f00000000000d2'

const subject = 'yolk-conformance run-synthetic draft: synthetic conformance draft, safe to delete'

const updatedSubject =
  'yolk-conformance run-synthetic draft updated: synthetic conformance draft, safe to delete'

const boundary = '=_yolk-draft-alternative'

const alternativeContentType = `multipart/alternative; boundary="${boundary}"`

/**
 * The quoted-printable text/plain and text/html parts the connector writes for a draft text (the
 * HTML is the text inside `<div dir="ltr">`; soft breaks keep lines within 76 characters).
 */
type EncodedParts = { readonly plain: string; readonly html: string }

const draftParts: EncodedParts = {
  plain: 'Synthetic conformance draft, safe to delete: gr=C3=BC=C3=9Fe =E2=9C=93',
  html: '<div dir=3D"ltr">Synthetic conformance draft, safe to delete: gr=C3=BC=\r\n=C3=9Fe =E2=9C=93</div>'
}

const updatedDraftParts: EncodedParts = {
  plain: 'Updated synthetic conformance draft: =C2=A1hola! =E2=9C=93',
  html: '<div dir=3D"ltr">Updated synthetic conformance draft: =C2=A1hola! =E2=9C=93=\r\n</div>'
}

/**
 * The MIME the connector builds for a draft without recipients, base64url-encoded: 7-bit
 * `multipart/alternative` with the exact text and its HTML rendering, both quoted-printable.
 */
const raw = (draftSubject: string, { plain, html }: EncodedParts) => {
  const part = (type: string, content: string) =>
    `Content-Type: text/${type}; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${content}`

  return base64UrlOfText(
    [
      `Subject: ${draftSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${alternativeContentType}`,
      '',
      `--${boundary}`,
      part('plain', plain),
      `--${boundary}`,
      part('html', html),
      `--${boundary}--`
    ].join('\r\n')
  )
}

const draftAnswer = (messageId: string) =>
  googleJson(200, { id: draftId, message: { id: messageId, threadId, labelIds: ['DRAFT'] } })

/** A `format=full` part whose `body.data` is transfer-decoded, as Gmail answers it. */
const textPart = (partId: string, type: 'plain' | 'html', content: string) => ({
  partId,
  mimeType: `text/${type}`,
  filename: '',
  headers: [
    { name: 'Content-Type', value: `text/${type}; charset=UTF-8` },
    { name: 'Content-Transfer-Encoding', value: 'quoted-printable' }
  ],
  body: {
    size: new TextEncoder().encode(content).byteLength,
    data: base64UrlOfText(content)
  }
})

/** A `format=full` thread holding the draft message with `draftSubject` and `body`. */
const thread = (messageId: string, draftSubject: string, body: string) =>
  googleJson(200, {
    id: threadId,
    historyId: '900020',
    messages: [
      {
        id: messageId,
        threadId,
        labelIds: ['DRAFT'],
        snippet: body,
        sizeEstimate: 512,
        historyId: '900020',
        internalDate: '1790000000000',
        payload: {
          partId: '',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [
            { name: 'Subject', value: draftSubject },
            { name: 'Content-Type', value: alternativeContentType }
          ],
          body: { size: 0 },
          parts: [
            textPart('0', 'plain', body),
            textPart('1', 'html', `<div dir="ltr">${body}</div>`)
          ]
        }
      }
    ]
  })

const threadRequest = { method: 'GET', url: `${gmailSyntheticApi}/threads/${threadId}?format=full` }

const deleteRequest = { method: 'DELETE', url: `${gmailSyntheticApi}/drafts/${draftId}` }

/** The draft message as `format=metadata` answers it: the DRAFT label, the subject, no recipient. */
const draftMetadata = googleJson(200, {
  id: firstMessageId,
  threadId,
  labelIds: ['DRAFT'],
  snippet: gmailConformanceDraftText,
  sizeEstimate: 512,
  historyId: '900020',
  internalDate: '1790000000000',
  payload: {
    partId: '',
    mimeType: 'multipart/alternative',
    filename: '',
    headers: [
      { name: 'Subject', value: subject },
      { name: 'Content-Type', value: alternativeContentType }
    ],
    body: { size: 0 }
  }
})

const updatedMessageRequest = {
  method: 'GET',
  url: `${gmailSyntheticApi}/messages/${updatedMessageId}?format=minimal`
}

/**
 * A draft without recipients composed with a UTF-8 body, its message read (`format=metadata`) to
 * prove it is the run's own, read back through `get_thread`, updated, read back again, deleted by id
 * (204, empty body), its message gone (404), deleted again (404), and its message still gone.
 *
 * Synthetic placeholder (`evidence: 'unverified'`) until a live recording replaces it.
 * `pnpm conformance:google --live --owner-approved --account <label> --record` stages a
 * replacement in a gitignored directory; see the script header for the manual scrub-and-promote
 * step.
 */
export const gmailDraftLifecycleFixture: WireFixture = {
  id: 'google.gmail.draft-compose-update-delete.synthetic',
  caseId: 'google.gmail.draft-compose-update-delete',
  evidence: 'unverified',
  recordedAt: '2026-09-30',
  account: 'synthetic',
  endpoint: 'https://gmail.googleapis.com',
  note: 'Compose a draft without recipients, read its message metadata (DRAFT, run subject, no recipient), read its thread, update it, read the thread again, delete the draft (204), read its message (404), delete it again (404), and read its message again (404). Synthetic placeholder shaped like the Gmail API; not recorded from a live service.',
  exchanges: [
    {
      request: {
        method: 'POST',
        url: `${gmailSyntheticApi}/drafts`,
        headers: googleJsonRequestHeaders,
        body: { message: { raw: raw(subject, draftParts) } }
      },
      response: draftAnswer(firstMessageId)
    },
    {
      request: {
        method: 'GET',
        url: `${gmailSyntheticApi}/messages/${firstMessageId}?format=metadata`
      },
      response: draftMetadata
    },
    {
      request: threadRequest,
      response: thread(firstMessageId, subject, gmailConformanceDraftText)
    },
    {
      request: {
        method: 'PUT',
        url: `${gmailSyntheticApi}/drafts/${draftId}`,
        headers: googleJsonRequestHeaders,
        body: {
          id: draftId,
          message: { raw: raw(updatedSubject, updatedDraftParts) }
        }
      },
      response: draftAnswer(updatedMessageId)
    },
    {
      request: threadRequest,
      response: thread(updatedMessageId, updatedSubject, gmailConformanceUpdatedDraftText)
    },
    { request: deleteRequest, response: googleNoContent },
    { request: updatedMessageRequest, response: gmailNotFound },
    { request: deleteRequest, response: gmailNotFound },
    { request: updatedMessageRequest, response: gmailNotFound }
  ]
}
