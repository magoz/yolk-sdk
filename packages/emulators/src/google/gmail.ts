/**
 * Gmail routes of the Google emulator (internal): message listing by label with page tokens,
 * message reads in the recorded formats, attachments, the label lifecycle, label changes, trash and
 * untrash, the draft lifecycle with its thread, and the multipart practice send.
 *
 * Every answer comes from the Gmail fixtures, through the seed or the request, or is minted. The
 * practice send is irreversible on the real service: here it only records the sent message in the
 * state (nothing is delivered anywhere), and only a message whose sole recipient is the seeded
 * practice address, exactly as the send fixture records it, is accepted.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  DecodedViewRefusal,
  exactBodyKeys,
  exactQuery,
  isJsonObject,
  isNotEmulated,
  mediaType,
  notEmulated,
  parseJsonText,
  statefulRoute,
  type NotEmulated
} from '../stateful-emulator.ts'
import {
  answer,
  evidence,
  gmailIdSegment,
  googleEmulatorGmailOrigin,
  googleErrorBody,
  googleJson,
  googleNoContent,
  isRunText,
  listPage,
  pageSize,
  param,
  recordedInternalDate,
  recordedRunIdLength,
  recordedValue,
  runIdOf,
  withoutQuery,
  type GoogleApiEnv,
  type GoogleRoute
} from './shared.ts'
import {
  base64UrlOfText,
  lastLabelNumber,
  mintedLabelIdPattern,
  mintedDraftId,
  mintedMessageId,
  mintedMessageIdPattern,
  pad,
  type GoogleEmulatorGmailMessage,
  type GoogleEmulatorImpliedMessage,
  type GoogleEmulatorState
} from './state.ts'

/** Path prefix of every Gmail API route (`/gmail/v1/users/me`). */
export const gmailApiPath = '/gmail/v1/users/me'

const listCase = 'google.gmail.list-page-token'

const attachmentCase = 'google.gmail.attachment-base64url'

const notFoundCase = 'google.gmail.not-found-envelope'

const labelCase = 'google.gmail.label-create-apply-delete'

const draftCase = 'google.gmail.draft-compose-update-delete'

const trashCase = 'google.gmail.trash-untrash'

const sendCase = 'google.gmail.send-practice-address'

const gmail = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  params: ReadonlyArray<string> = []
) =>
  evidence(
    googleEmulatorGmailOrigin,
    method,
    `${gmailApiPath}${path}`,
    write,
    caseIds,
    Object.fromEntries(params.map(name => [name, gmailIdSegment]))
  )

// Recorded constants and renderings.

/** The Gmail not-found envelope (`messages`, `labels`, and `drafts` reads and deletes). */
const notFound = (env: GoogleApiEnv): Response =>
  googleJson(
    404,
    env.drills.notFoundWithoutMessage
      ? { error: { code: 404, status: 'NOT_FOUND' } }
      : googleErrorBody(404, 'Requested entity was not found.', 'notFound', 'NOT_FOUND')
  )

/** A message id of the recorded absent form (16 lower-case hex digits). */
const absentMessageIdPattern = /^[0-9a-f]{16}$/

const draftIdPattern = /^r-\d{1,20}$/

/** The draft texts the draft fixture records (non-ASCII on purpose). */
const draftText = 'Synthetic conformance draft, safe to delete: grüße ✓'

const updatedDraftText = 'Updated synthetic conformance draft: ¡hola! ✓'

const draftSubjectRest = 'synthetic conformance draft, safe to delete'

const sendSubjectRest = 'synthetic conformance message, safe to delete'

/** The practice address the send fixture records (the sender and the only recipient). */
const recordedPracticeAddress = 'practice@example.test'

/** Why a draft or send subject with a run id of another length is not emulated. */
const sizedRunIdReason = (what: 'draft' | 'send'): string =>
  `a ${what} subject whose run id is not ${recordedRunIdLength} characters long (the fixtures' run-synthetic) is not emulated: the recorded sizeEstimate covers the subject`

/** The 7-bit MIME the send fixture records for `practiceAddress` and `subject`. */
const practiceMime = (practiceAddress: string, subject: string): string =>
  [
    `To: ${practiceAddress}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Synthetic conformance message sent to the seeded practice address only. Safe to delete.',
    ''
  ].join('\r\n')

/** The `multipart/related` upload body the send fixture records. */
const uploadBody = (boundary: string, mime: string): string =>
  [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    '{}',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${boundary}--`
  ].join('\r\n')

type MessageFormat = 'minimal' | 'metadata' | 'full'

const head = (message: GoogleEmulatorGmailMessage): Schema.JsonObject => ({
  id: message.id,
  threadId: message.threadId,
  labelIds: [...message.labelIds],
  snippet: message.snippet,
  sizeEstimate: message.sizeEstimate,
  historyId: message.historyId,
  internalDate: message.internalDate
})

/** The recorded rendering of `message` in `format`, or `undefined` when none is recorded. */
const renderMessage = (
  message: GoogleEmulatorGmailMessage,
  format: MessageFormat
): Schema.JsonObject | undefined => {
  switch (format) {
    case 'minimal':
      return message.minimal ? head(message) : undefined
    case 'metadata':
      return message.metadataPayload === null
        ? undefined
        : { ...head(message), payload: message.metadataPayload }
    case 'full':
      return message.fullPayload === null
        ? undefined
        : { ...head(message), payload: message.fullPayload }
  }
}

/** The `{ id, threadId, labelIds }` answer of a label change, trash, or untrash. */
const labelsAnswer = (
  message: GoogleEmulatorGmailMessage,
  labelIds: ReadonlyArray<string>
): Response =>
  googleJson(200, { id: message.id, threadId: message.threadId, labelIds: [...labelIds] })

const findMessage = (state: GoogleEmulatorState, id: string) =>
  state.messages.find(message => message.id === id)

const isImpliedMessage = (state: GoogleEmulatorState, id: string): boolean =>
  state.impliedMessages.some(message => message.id === id)

const isDraftMessage = (message: GoogleEmulatorGmailMessage): boolean =>
  message.labelIds.includes('DRAFT')

const replaceMessage = (
  state: GoogleEmulatorState,
  next: GoogleEmulatorGmailMessage
): ReadonlyArray<GoogleEmulatorGmailMessage> =>
  state.messages.map(message => (message.id === next.id ? next : message))

// Listing by label.

type MessagesPageHead = {
  readonly messages: ReadonlyArray<Schema.Json>
  nextPageToken?: string
}

type ListInput = {
  readonly labelId: string
  readonly maxResults: number
  readonly pageToken: string | undefined
}

const listMessages: GoogleRoute = statefulRoute(
  gmail('GET', '/messages', false, [listCase]),
  'none',
  (request): ListInput | NotEmulated => {
    const query = exactQuery(request, ['labelIds', 'maxResults'], ['pageToken'])

    if (isNotEmulated(query)) return query

    const labelId = query['labelIds'] ?? ''

    if (!gmailIdSegment.test(labelId)) return notEmulated('labelIds must be one label id')

    const maxResults = pageSize(query['maxResults'], 'maxResults', 1, 500)

    if (isNotEmulated(maxResults)) return maxResults

    const pageToken = query['pageToken']

    return pageToken === ''
      ? notEmulated('an empty pageToken is not emulated')
      : { labelId, maxResults, pageToken }
  },
  (state, input, { env }) => {
    const known =
      state.impliedLabelIds.includes(input.labelId) ||
      state.labels.some(label => label.id === input.labelId)

    if (!known) return notEmulated('listing a label the state does not hold is not emulated')

    const matches: ReadonlyArray<GoogleEmulatorGmailMessage | GoogleEmulatorImpliedMessage> = [
      ...state.messages,
      ...state.impliedMessages
    ].filter(message => message.labelIds.includes(input.labelId))

    // Every recorded listing has results; an empty one is no fixture's answer.
    if (matches.length === 0) {
      return notEmulated('a listing without messages is not emulated (no fixture records one)')
    }

    if (matches.some(message => message.labelIds.some(id => id === 'TRASH' || id === 'SPAM'))) {
      return notEmulated('a listing that would leave out messages in Trash or Spam is not emulated')
    }

    return listPage(
      env,
      'gmail',
      `gmail\u0000${input.labelId}\u0000${input.maxResults}`,
      matches.map(message => ({ id: message.id, threadId: message.threadId })),
      input.maxResults,
      input.pageToken,
      env.drills.gmailPageRepeats,
      (page, nextPageToken) => {
        const head: MessagesPageHead = { messages: [...page] }

        // The last page carries no `nextPageToken`.
        if (nextPageToken !== undefined) head.nextPageToken = nextPageToken

        return googleJson(200, { ...head, resultSizeEstimate: matches.length })
      }
    )
  }
)

// Message reads.

type MessageRead = { readonly id: string; readonly format: MessageFormat }

const formats: ReadonlyArray<string> = ['minimal', 'metadata', 'full']

const isFormat = (value: string | undefined): value is MessageFormat =>
  value !== undefined && formats.includes(value)

const getMessage: GoogleRoute = statefulRoute(
  gmail(
    'GET',
    '/messages/{messageId}',
    false,
    [attachmentCase, notFoundCase, labelCase, draftCase, trashCase, sendCase],
    ['messageId']
  ),
  'none',
  (request): MessageRead | NotEmulated => {
    const query = exactQuery(request, ['format'])

    if (isNotEmulated(query)) return query

    const format = query['format']

    return isFormat(format)
      ? { id: param(request, 'messageId'), format }
      : notEmulated('format must be minimal, metadata, or full')
  },
  (state, input, { env }) => {
    const message = findMessage(state, input.id)

    if (message !== undefined) {
      const rendered = renderMessage(message, input.format)

      return rendered === undefined
        ? notEmulated(`no fixture records this message with format=${input.format}`)
        : answer(() => googleJson(200, rendered))
    }

    if (isImpliedMessage(state, input.id)) {
      return notEmulated('reading a message a fixture only names in a listing is not emulated')
    }

    // The recorded not-found answer: a minimal read of an id the mailbox does not hold.
    return input.format === 'minimal' && absentMessageIdPattern.test(input.id)
      ? answer(() => notFound(env))
      : notEmulated('only a format=minimal read of an absent 16-hex-digit id is recorded')
  }
)

type AttachmentRead = { readonly messageId: string; readonly attachmentId: string }

const getAttachment: GoogleRoute = statefulRoute(
  gmail(
    'GET',
    '/messages/{messageId}/attachments/{attachmentId}',
    false,
    [attachmentCase],
    ['messageId', 'attachmentId']
  ),
  'none',
  (request): AttachmentRead | NotEmulated =>
    withoutQuery(request) ?? {
      messageId: param(request, 'messageId'),
      attachmentId: param(request, 'attachmentId')
    },
  (state, input, { env }) => {
    const attachment = state.attachments.find(
      item => item.messageId === input.messageId && item.attachmentId === input.attachmentId
    )

    if (attachment === undefined || findMessage(state, input.messageId) === undefined) {
      return notEmulated('an attachment the state does not hold is not emulated')
    }

    const data = env.drills.attachmentStandardBase64
      ? attachment.data.replaceAll('-', '+').replaceAll('_', '/')
      : attachment.data

    return answer(() => googleJson(200, { size: attachment.size, data }))
  }
)

// Labels.

const createLabel: GoogleRoute = statefulRoute(
  gmail('POST', '/labels', true, [labelCase]),
  'json',
  (request): string | NotEmulated => {
    const body = withoutQuery(request) ?? exactBodyKeys(request.json, 'the label body', ['name'])

    if (isNotEmulated(body)) return body

    return Predicate.isString(body.name) && isRunText(body.name, 'label')
      ? body.name
      : notEmulated('a label name other than "yolk-conformance <runId> label" is not emulated')
  },
  (state, name) => {
    if (state.labels.some(label => label.name === name)) {
      return notEmulated('creating a label whose name exists is not emulated')
    }

    // Refused before any fault: no minted label id is left.
    if (state.counters.nextLabelNumber > lastLabelNumber) {
      return notEmulated('creating a label when no Label_<n> id is left is not emulated')
    }

    return () => {
      const number = state.counters.nextLabelNumber

      const label = {
        id: `Label_${number}`,
        name,
        messageListVisibility: 'show',
        labelListVisibility: 'labelShow',
        type: 'user'
      }

      state.counters = { ...state.counters, nextLabelNumber: number + 1 }
      state.labels = [...state.labels, label]

      return googleJson(200, { ...label })
    }
  }
)

const getLabel: GoogleRoute = statefulRoute(
  gmail('GET', '/labels/{labelId}', false, [labelCase], ['labelId']),
  'none',
  request => withoutQuery(request) ?? param(request, 'labelId'),
  (state, id, { env }) => {
    if (state.labels.some(label => label.id === id) || state.impliedLabelIds.includes(id)) {
      return notEmulated('no fixture records a label read of an existing label')
    }

    return mintedLabelIdPattern.test(id)
      ? answer(() => notFound(env))
      : notEmulated('only a read of an absent Label_<n> id is recorded')
  }
)

const deleteLabel: GoogleRoute = statefulRoute(
  gmail('DELETE', '/labels/{labelId}', true, [labelCase], ['labelId']),
  'none',
  request => withoutQuery(request) ?? param(request, 'labelId'),
  (state, id, { env }) => {
    if (!state.labels.some(label => label.id === id)) {
      return notEmulated('only deleting a label created here is recorded')
    }

    return () => {
      const without = <M extends { readonly labelIds: ReadonlyArray<string> }>(message: M): M =>
        message.labelIds.includes(id)
          ? { ...message, labelIds: message.labelIds.filter(label => label !== id) }
          : message

      state.labels = state.labels.filter(label => label.id !== id)

      // Deleting a label removes it from every message (the label fixture's last read).
      if (!env.drills.labelDeleteKeepsOnMessages) {
        state.messages = state.messages.map(without)
        state.impliedMessages = state.impliedMessages.map(without)
      }

      return googleNoContent()
    }
  }
)

// Label changes, trash, and untrash.

type ModifyInput = { readonly messageId: string; readonly labelId: string }

const modifyMessage: GoogleRoute = statefulRoute(
  gmail('POST', '/messages/{messageId}/modify', true, [labelCase], ['messageId']),
  'json',
  (request): ModifyInput | NotEmulated => {
    const body =
      withoutQuery(request) ?? exactBodyKeys(request.json, 'the modify body', ['addLabelIds'])

    if (isNotEmulated(body)) return body

    const added = body.addLabelIds

    if (!Array.isArray(added) || added.length !== 1 || !Predicate.isString(added[0])) {
      return notEmulated('a modify adding other than one label is not emulated')
    }

    return { messageId: param(request, 'messageId'), labelId: added[0] }
  },
  (state, input) => {
    const message = findMessage(state, input.messageId)

    if (message === undefined || isDraftMessage(message)) {
      return notEmulated('changing the labels of a message the state does not hold is not emulated')
    }

    if (!state.labels.some(label => label.id === input.labelId)) {
      return notEmulated('adding a label other than one created here is not emulated')
    }

    if (message.labelIds.includes(input.labelId)) {
      return notEmulated('adding a label the message carries already is not emulated')
    }

    return () => {
      const next = { ...message, labelIds: [...message.labelIds, input.labelId] }

      state.messages = replaceMessage(state, next)

      return labelsAnswer(next, next.labelIds)
    }
  }
)

const trashRoute = (action: 'trash' | 'untrash'): GoogleRoute =>
  statefulRoute(
    gmail('POST', `/messages/{messageId}/${action}`, true, [trashCase], ['messageId']),
    'none',
    request => withoutQuery(request) ?? param(request, 'messageId'),
    (state, id, { env }) => {
      const message = findMessage(state, id)

      if (message === undefined || isDraftMessage(message)) {
        return notEmulated(`${action} of a message the state does not hold is not emulated`)
      }

      const inTrash = message.labelIds.includes('TRASH')

      if (action === 'trash' ? inTrash : !inTrash) {
        return notEmulated(
          action === 'trash'
            ? 'trashing a message already in Trash is not emulated'
            : 'untrashing a message not in Trash is not emulated'
        )
      }

      return () => {
        const labelIds =
          action === 'trash'
            ? [...message.labelIds, 'TRASH']
            : message.labelIds.filter(label => label !== 'TRASH')

        const next = { ...message, labelIds }

        state.messages = replaceMessage(state, next)

        return labelsAnswer(
          next,
          action === 'trash' && env.drills.trashAnswerOmitsTrash
            ? labelIds.filter(label => label !== 'TRASH')
            : labelIds
        )
      }
    }
  )

// Drafts.

const base64UrlPattern = /^[A-Za-z0-9_-]*$/

/** The UTF-8 text of canonical unpadded base64url, or `undefined`. */
const decodeBase64UrlText = (raw: string): string | undefined => {
  if (!base64UrlPattern.test(raw) || raw.length % 4 === 1) return undefined

  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    // Canonical only: the encoding the connector writes, byte for byte.
    return base64UrlOfText(text) === raw ? text : undefined
  } catch {
    return undefined
  }
}

const draftMimePattern =
  /^Subject: ([^\r\n]*)\r\nContent-Type: text\/plain; charset=utf-8\r\n\r\n([\s\S]*)$/

type DraftContent = { readonly subject: string; readonly body: string }

/** The reasons a draft `message.raw` is refused with (constants; never derived from a request). */
const draftKeysReason = 'message has a key this route does not take'

const canonicalRawReason = 'message.raw must be canonical base64url UTF-8 MIME'

const otherDraftReason = (kind: 'compose' | 'update'): string =>
  `a draft ${kind} other than the recorded run draft is not emulated`

/**
 * Every reason `readDraftRaw` refuses a draft of `kind` with: the route's declared
 * `viewRefusalReasons`, so the wrapper ledgers exactly these (and nothing derived from a request).
 */
const draftRefusalReasons = (kind: 'compose' | 'update'): ReadonlyArray<string> => [
  draftKeysReason,
  canonicalRawReason,
  otherDraftReason(kind),
  sizedRunIdReason('draft')
]

type DraftRaw = {
  /** The decoded MIME when `message.raw` is canonical base64url UTF-8 (decoded once). */
  readonly decoded: string | undefined
  readonly content: DraftContent | NotEmulated
}

/** The recorded draft MIME (no recipient) of a compose or an update, decoded once. */
const readDraftRaw = (message: Schema.Json | undefined, kind: 'compose' | 'update'): DraftRaw => {
  // Decode `raw` before the key check, so a cleanly decoded raw is always available to the
  // credential guard (a bearer inside it is a repeat, whatever else is wrong with `message`).
  const raw =
    Predicate.hasProperty(message, 'raw') && !Array.isArray(message) ? message.raw : undefined

  const decoded = Predicate.isString(raw) ? decodeBase64UrlText(raw) : undefined

  const fields = exactBodyKeys(message, 'message', ['raw'])

  if (isNotEmulated(fields)) return { decoded, content: fields }

  if (decoded === undefined) return { decoded, content: notEmulated(canonicalRawReason) }

  const parts = draftMimePattern.exec(decoded)
  const subject = parts?.[1] ?? ''
  const body = parts?.[2] ?? ''

  const runId =
    kind === 'compose'
      ? runIdOf(subject, 'draft', draftSubjectRest)
      : runIdOf(subject, 'draft updated', draftSubjectRest)

  const recordedBody = kind === 'compose' ? draftText : updatedDraftText

  if (parts === null || runId === undefined || body !== recordedBody) {
    return { decoded, content: notEmulated(otherDraftReason(kind)) }
  }

  return {
    decoded,
    content:
      runId.length === recordedRunIdLength
        ? { subject, body }
        : notEmulated(sizedRunIdReason('draft'))
  }
}

/**
 * The decoded view of a draft body for the credential guard (Gmail's own wire format wraps the
 * draft MIME in base64url `message.raw`). Fail closed: when the body is a JSON object whose
 * `message` object carries `raw`, the view returns the decoded MIME only when it is exactly the
 * recorded draft MIME of this route (`kind`), the run id aside. Any other raw makes it throw a
 * `DecodedViewRefusal` with the route's own constant reason (one of `draftRefusalReasons`) and
 * whatever it decoded cleanly: the wrapper ledgers a repeat when that text holds the bearer, and
 * the declared reason otherwise, before anything is recorded, so a refused raw (line-wrapped, the
 * standard alphabet, a stray character, RFC 2047 words, quoted-printable, UTF-16, a 12-character
 * run id, ...) never reaches the ledger. A body without `message.raw` yields no view (the route's
 * own shape check refuses it).
 */
const draftRawViews =
  (kind: 'compose' | 'update') =>
  (body: string): ReadonlyArray<string> => {
    const parsed = parseJsonText(body)
    const message = isJsonObject(parsed) ? parsed.message : undefined

    if (!isJsonObject(message) || !('raw' in message)) return []

    const { decoded, content } = readDraftRaw(message, kind)

    if (isNotEmulated(content)) {
      throw new DecodedViewRefusal({
        reason: content.reason,
        decoded: decoded === undefined ? [] : [decoded]
      })
    }

    return decoded === undefined ? [] : [decoded]
  }

const textPayload = (subject: string, body: Schema.JsonObject): Schema.JsonObject => ({
  partId: '',
  mimeType: 'text/plain',
  filename: '',
  headers: [
    { name: 'Subject', value: subject },
    { name: 'Content-Type', value: 'text/plain; charset=utf-8' }
  ],
  body
})

/** A draft message as the draft fixture records it (the metadata rendering only on compose). */
const draftMessage = (
  id: string,
  threadId: string,
  content: DraftContent,
  withMetadata: boolean
): GoogleEmulatorGmailMessage => ({
  id,
  threadId,
  labelIds: ['DRAFT'],
  snippet: content.body,
  sizeEstimate: 512,
  historyId: '900020',
  internalDate: recordedInternalDate,
  minimal: false,
  metadataPayload: withMetadata ? textPayload(content.subject, { size: 64 }) : null,
  fullPayload: textPayload(content.subject, {
    size: new TextEncoder().encode(content.body).byteLength,
    data: base64UrlOfText(content.body)
  })
})

const draftAnswer = (draftId: string, message: GoogleEmulatorGmailMessage): Response =>
  googleJson(200, {
    id: draftId,
    message: { id: message.id, threadId: message.threadId, labelIds: [...message.labelIds] }
  })

const composeDraft: GoogleRoute = statefulRoute(
  {
    ...gmail('POST', '/drafts', true, [draftCase]),
    decodedViews: draftRawViews('compose'),
    viewRefusalReasons: draftRefusalReasons('compose')
  },
  'json',
  (request): DraftContent | NotEmulated => {
    const body = withoutQuery(request) ?? exactBodyKeys(request.json, 'the draft body', ['message'])

    return isNotEmulated(body) ? body : readDraftRaw(body.message, 'compose').content
  },
  (state, content) => () => {
    const draftNumber = state.counters.nextDraftNumber
    const messageNumber = state.counters.nextDraftMessageNumber
    const id = mintedMessageId('d', messageNumber)
    const message = draftMessage(id, id, content, true)
    const draftId = mintedDraftId(draftNumber)

    state.counters = {
      ...state.counters,
      nextDraftNumber: draftNumber + 1,
      nextDraftMessageNumber: messageNumber + 1
    }
    state.messages = [...state.messages, message]
    state.drafts = [...state.drafts, { id: draftId, messageId: id }]

    return draftAnswer(draftId, message)
  }
)

type UpdateInput = { readonly draftId: string; readonly content: DraftContent }

const updateDraft: GoogleRoute = statefulRoute(
  {
    ...gmail('PUT', '/drafts/{draftId}', true, [draftCase], ['draftId']),
    decodedViews: draftRawViews('update'),
    viewRefusalReasons: draftRefusalReasons('update')
  },
  'json',
  (request): UpdateInput | NotEmulated => {
    const draftId = param(request, 'draftId')

    const body =
      withoutQuery(request) ?? exactBodyKeys(request.json, 'the draft body', ['id', 'message'])

    if (isNotEmulated(body)) return body

    if (body.id !== draftId) return notEmulated('a body id other than the path draft id')

    const content = readDraftRaw(body.message, 'update').content

    return isNotEmulated(content) ? content : { draftId, content }
  },
  (state, input, { env }) => {
    const draft = state.drafts.find(candidate => candidate.id === input.draftId)
    const previous = draft === undefined ? undefined : findMessage(state, draft.messageId)

    if (draft === undefined || previous === undefined) {
      return notEmulated('updating a draft the state does not hold is not emulated')
    }

    return () => {
      const number = state.counters.nextDraftMessageNumber
      const id = mintedMessageId('d', number)

      const message: GoogleEmulatorGmailMessage = env.drills.draftUpdateKeepsContent
        ? { ...previous, id, metadataPayload: null }
        : draftMessage(id, previous.threadId, input.content, false)

      state.counters = { ...state.counters, nextDraftMessageNumber: number + 1 }
      state.messages = [
        ...state.messages.filter(candidate => candidate.id !== previous.id),
        message
      ]
      state.drafts = state.drafts.map(candidate =>
        candidate.id === draft.id ? { ...candidate, messageId: id } : candidate
      )

      return draftAnswer(draft.id, message)
    }
  }
)

const deleteDraft: GoogleRoute = statefulRoute(
  gmail('DELETE', '/drafts/{draftId}', true, [draftCase], ['draftId']),
  'none',
  request => withoutQuery(request) ?? param(request, 'draftId'),
  (state, id, { env }) => {
    const draft = state.drafts.find(candidate => candidate.id === id)

    if (draft === undefined) {
      // The recorded repeated delete: an absent draft answers the not-found envelope.
      return draftIdPattern.test(id)
        ? answer(() => notFound(env))
        : notEmulated('only deleting an absent r-<digits> draft id is recorded')
    }

    return () => {
      state.drafts = state.drafts.filter(candidate => candidate.id !== id)
      state.messages = state.messages.filter(message => message.id !== draft.messageId)

      return googleNoContent()
    }
  }
)

const getThread: GoogleRoute = statefulRoute(
  gmail('GET', '/threads/{threadId}', false, [draftCase], ['threadId']),
  'none',
  (request): string | NotEmulated => {
    const query = exactQuery(request, ['format'])

    if (isNotEmulated(query)) return query

    return recordedValue(query, 'format', 'full') ?? param(request, 'threadId')
  },
  (state, threadId) => {
    const messages = state.messages.filter(message => message.threadId === threadId)

    // Only draft threads created here are recorded (a seeded message's thread is not).
    const createdDrafts = messages.every(
      message => isDraftMessage(message) && mintedMessageIdPattern.test(message.id)
    )

    if (messages.length === 0 || !createdDrafts) {
      return notEmulated('a thread other than a draft thread created here is not emulated')
    }

    const rendered = messages.map(message => renderMessage(message, 'full'))

    if (rendered.some(item => item === undefined)) {
      return notEmulated('a thread with a message without a full rendering is not emulated')
    }

    return answer(() =>
      googleJson(200, {
        id: threadId,
        historyId: messages.at(-1)?.historyId ?? '',
        messages: rendered.flatMap(item => (item === undefined ? [] : [item]))
      })
    )
  }
)

// The practice send (upload endpoint).

const boundaryPattern = /^[A-Za-z0-9_]{1,70}$/

type SendInput = { readonly boundary: string; readonly subject: string; readonly text: string }

/**
 * The boundary of `multipart/related; boundary=<b>`, or `undefined`. The parameter list is parsed
 * whole: each parameter is split on its first `=`, and the content type must carry exactly one
 * parameter, `boundary`, whose whole value is 1 to 70 of `[A-Za-z0-9_]` (unquoted). Any other,
 * repeated, empty, or malformed parameter is refused (the send records no other parameter).
 */
const multipartBoundary = (contentType: string | undefined): string | undefined => {
  if (mediaType(contentType) !== 'multipart/related') return undefined

  const params = (contentType ?? '')
    .split(';')
    .slice(1)
    .map(param => {
      const separator = param.indexOf('=')

      return separator === -1
        ? undefined
        : {
            name: param.slice(0, separator).trim().toLowerCase(),
            value: param.slice(separator + 1)
          }
    })

  const [only] = params

  return params.length === 1 &&
    only !== undefined &&
    only.name === 'boundary' &&
    boundaryPattern.test(only.value)
    ? only.value
    : undefined
}

const sendMessage: GoogleRoute = statefulRoute(
  evidence(googleEmulatorGmailOrigin, 'POST', '/upload/gmail/v1/users/me/messages/send', true, [
    sendCase
  ]),
  'bytes',
  (request): SendInput | NotEmulated => {
    const query = exactQuery(request, ['uploadType'])

    if (isNotEmulated(query)) return query

    const problem = recordedValue(query, 'uploadType', 'multipart')

    if (problem !== undefined) return problem

    const boundary = multipartBoundary(request.header('content-type'))

    if (boundary === undefined) {
      return notEmulated(
        'a content-type other than multipart/related; boundary=<b> is not emulated'
      )
    }

    let text: string

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(request.bytes)
    } catch {
      return notEmulated('an upload body that is not 7-bit text is not emulated')
    }

    const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(text)?.[1] ?? ''

    const runId = runIdOf(subject, 'send', sendSubjectRest)

    if (runId === undefined) {
      return notEmulated(
        'a send other than the recorded run-scoped practice message is not emulated'
      )
    }

    return runId.length === recordedRunIdLength
      ? { boundary, subject, text }
      : notEmulated(sizedRunIdReason('send'))
  },
  (state, input, { env }) => {
    // The recorded sizeEstimate covers the To and From headers: only the recorded address.
    if (state.practiceAddress !== recordedPracticeAddress) {
      return notEmulated(
        `a send while the seeded practiceAddress is not the recorded ${recordedPracticeAddress} is not emulated (the recorded sizeEstimate covers the address)`
      )
    }

    // Only the recorded message, whose ONLY recipient is the seeded practice address.
    if (
      input.text !== uploadBody(input.boundary, practiceMime(state.practiceAddress, input.subject))
    ) {
      return notEmulated(
        'a send other than the recorded 7-bit message to the seeded practice address only is not emulated'
      )
    }

    return () => {
      // Read the clock before any write: a failing clock, or one answering an instant outside the
      // Date range (non-finite or not), writes nothing.
      const instant = new Date(env.now())

      if (!Number.isFinite(instant.getTime())) {
        throw new Error('the clock answered an instant outside the Date range')
      }

      const date = instant.toUTCString().replace(/GMT$/, '+0000')
      const number = state.counters.nextSentNumber
      const id = mintedMessageId('e', number)
      const address = state.practiceAddress

      const headers = [
        { name: 'MIME-Version', value: '1.0' },
        { name: 'Date', value: date },
        { name: 'Message-ID', value: `<synthetic-send-${pad(number, 4)}@example.test>` },
        { name: 'Subject', value: input.subject },
        { name: 'From', value: address },
        { name: 'To', value: address },
        { name: 'Content-Type', value: 'text/plain; charset=us-ascii' }
      ].filter(header => !(env.drills.sentMessageWithoutTo && header.name === 'To'))

      // Recorded in the state only: nothing is delivered anywhere.
      const sent: GoogleEmulatorGmailMessage = {
        id,
        threadId: id,
        labelIds: ['SENT', 'INBOX', 'UNREAD'],
        snippet: 'Synthetic conformance message sent to the seeded practice address only.',
        sizeEstimate: 640,
        historyId: '900030',
        internalDate: recordedInternalDate,
        minimal: false,
        metadataPayload: {
          partId: '',
          mimeType: 'text/plain',
          filename: '',
          headers,
          body: { size: 88 }
        },
        fullPayload: null
      }

      state.counters = { ...state.counters, nextSentNumber: number + 1 }
      state.messages = [...state.messages, sent]

      return googleJson(200, { id, threadId: id, labelIds: ['SENT'] })
    }
  }
)

/** The Gmail routes, in manifest order. */
export const gmailRoutes: ReadonlyArray<GoogleRoute> = [
  listMessages,
  getMessage,
  getAttachment,
  modifyMessage,
  trashRoute('trash'),
  trashRoute('untrash'),
  createLabel,
  getLabel,
  deleteLabel,
  composeDraft,
  updateDraft,
  deleteDraft,
  getThread,
  sendMessage
]
