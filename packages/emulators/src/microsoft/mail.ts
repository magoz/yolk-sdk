/**
 * Microsoft Graph emulator Outlook routes (internal): folder message listing with paging, draft
 * create, message update and move with immutable ids, attachment listing and retrieval, and the
 * JSON `$batch` permanent delete. Wire shapes follow the synthetic Outlook conformance fixtures.
 *
 * Ids: every Outlook fixture request sends `Prefer: IdType="ImmutableId"`, so every Outlook route
 * (and every `$batch` subrequest) needs it; without it the request fails closed (400). Messages
 * have one id, the immutable id, which a move keeps.
 *
 * Writes accept only the fields the fixtures send: a draft create takes `subject`, a text `body`,
 * `toRecipients`, and the owner as `from`; an update takes `subject` and `isRead`; a move takes
 * `destinationId`, which must be `deleteditems`. Anything else, including unknown nested keys,
 * fails closed before any write.
 * The fixtures update, move, and permanently delete only drafts the case created, so those writes
 * to a message that is not a draft are not emulated (400), and neither is permanently deleting a
 * message with attachments (no fixture creates a draft with attachments).
 *
 * Concurrent writes: the first write (update or move) to reach the handler holds its message for
 * `conflictWindowMs` before answering; an overlapping write to that message gets 409
 * `ErrorIrresolvableConflict` and changes nothing. Non-overlapping writes both apply (an emulator
 * extrapolation).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  bodyObject,
  codes,
  collection,
  decodeSegment,
  entity,
  invalidValue,
  isJsonObject,
  jsonResponse,
  metadataContext,
  nestedObject,
  nextChangeKey,
  nextLinkOf,
  notEmulated,
  nowTimestamp,
  odataKey,
  padded,
  pageOf,
  parsePreferences,
  project,
  resolveUser,
  selectSuffix,
  selectedFields,
  textBody,
  type MicrosoftApiEnv,
  type RouteHandler,
  type RouteRequest
} from './graph.ts'
import type {
  MicrosoftEmulatorAttachment,
  MicrosoftEmulatorMailFolder,
  MicrosoftEmulatorMessage,
  MicrosoftEmulatorRecipient,
  MicrosoftEmulatorState,
  MicrosoftEmulatorUser
} from './state.ts'

const messageTagPrefix = 'CQAAABYAAAAsynthetic'

const messageFields: ReadonlyArray<string> = [
  'id',
  'createdDateTime',
  'lastModifiedDateTime',
  'changeKey',
  'categories',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'importance',
  'parentFolderId',
  'conversationId',
  'isDeliveryReceiptRequested',
  'isReadReceiptRequested',
  'isRead',
  'isDraft',
  'webLink',
  'body',
  'sender',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'flag'
]

const attachmentListFields: ReadonlyArray<string> = [
  'id',
  'name',
  'contentType',
  'size',
  'isInline',
  'lastModifiedDateTime'
]

const notFound = (request: RouteRequest): Response =>
  request.error(404, codes.mailItemNotFound, 'The specified object was not found in the store.')

const conflict = (request: RouteRequest): Response =>
  request.error(
    409,
    codes.conflict,
    'The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.'
  )

const recipient = (value: MicrosoftEmulatorRecipient) => ({
  emailAddress: { name: value.name ?? value.address, address: value.address }
})

/** Plain-text preview: tags stripped, whitespace collapsed, at most 255 characters. */
const bodyPreview = (message: MicrosoftEmulatorMessage): string =>
  (message.bodyContentType === 'html'
    ? message.bodyContent.replace(/<[^>]*>/g, ' ')
    : message.bodyContent
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)

/** 400 for an Outlook request without `Prefer: IdType="ImmutableId"` (every fixture sends it). */
const immutableIdProblem = (request: RouteRequest): Response | undefined =>
  request.prefer.immutableId
    ? undefined
    : notEmulated(
        request,
        'Outlook requests without Prefer: IdType="ImmutableId" are not emulated.'
      )

/** `users('{userId}')`, the context prefix of every Outlook route. */
const userContext = (request: RouteRequest): string =>
  `users${odataKey(request.params.userId ?? '')}`

/** `@odata.context` of a single message (create, update, move), as the fixtures record it. */
const messageEntityContext = (env: MicrosoftApiEnv, request: RouteRequest): string =>
  metadataContext(env, `${userContext(request)}/messages/$entity`)

/** The full message, in the draft fixture's key order. */
const renderMessage = (message: MicrosoftEmulatorMessage): Schema.JsonObject => {
  const id = message.id

  return {
    '@odata.etag': `W/"${message.changeKey}"`,
    id,
    createdDateTime: message.createdDateTime,
    lastModifiedDateTime: message.lastModifiedDateTime,
    changeKey: message.changeKey,
    categories: message.categories,
    receivedDateTime: message.receivedDateTime,
    sentDateTime: message.sentDateTime,
    hasAttachments: message.hasAttachments,
    internetMessageId: message.internetMessageId,
    subject: message.subject,
    bodyPreview: bodyPreview(message),
    importance: message.importance,
    parentFolderId: message.parentFolderId,
    conversationId: message.conversationId,
    isDeliveryReceiptRequested: false,
    isReadReceiptRequested: false,
    isRead: message.isRead,
    isDraft: message.isDraft,
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    body: { contentType: message.bodyContentType, content: message.bodyContent },
    sender: message.sender === null ? null : recipient(message.sender),
    from: message.from === null ? null : recipient(message.from),
    toRecipients: message.toRecipients.map(recipient),
    ccRecipients: message.ccRecipients.map(recipient),
    bccRecipients: message.bccRecipients.map(recipient),
    replyTo: message.replyTo.map(recipient),
    flag: { flagStatus: message.flagStatus }
  }
}

/** A folder by id (the paging fixture lists a folder by id, never by well-known name). */
const folderById = (
  state: MicrosoftEmulatorState,
  id: string
): MicrosoftEmulatorMailFolder | undefined => state.mailFolders.find(folder => folder.id === id)

/** The seeded folder with a well-known name (internal lookups and the move destination). */
const wellKnownFolder = (
  state: MicrosoftEmulatorState,
  name: MicrosoftEmulatorMailFolder['wellKnownName']
): MicrosoftEmulatorMailFolder | undefined =>
  state.mailFolders.find(folder => folder.wellKnownName === name)

/** The only move destination a fixture sends (`{ destinationId: 'deleteditems' }`). */
const moveDestination = 'deleteditems'

/** The largest folder message `$top` a fixture sends (`$top=2`, the paging case). */
const folderMessagesMaxTop = 2

/** A message by its (immutable) id. */
const findMessage = (
  state: MicrosoftEmulatorState,
  id: string
): MicrosoftEmulatorMessage | undefined => state.messages.find(message => message.id === id)

/** 400 for a write to a message that is not a draft (the fixtures write only case drafts). */
const notDraftProblem = (
  request: RouteRequest,
  message: MicrosoftEmulatorMessage
): Response | undefined =>
  message.isDraft
    ? undefined
    : notEmulated(
        request,
        'writes to a message that is not a draft are not emulated (the fixtures write only drafts).'
      )

const replaceMessage = (state: MicrosoftEmulatorState, updated: MicrosoftEmulatorMessage) => {
  state.messages = state.messages.map(message => (message.id === updated.id ? updated : message))
}

/**
 * `GET /users/{userId}/mailFolders/{folderId}/messages`: newest `receivedDateTime` first, one
 * `$top`/`$skip` page with an opaque `@odata.nextLink` on the configured Graph origin. The folder
 * is named by id (a well-known name or an unknown id is not emulated), and `$top` is required, at
 * most `folderMessagesMaxTop`, as the paging fixture sends it.
 */
export const listFolderMessages: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const folder = folderById(state, request.params.folderId ?? '')

  if (folder === undefined) {
    return notEmulated(
      request,
      'listing a folder by well-known name or an unknown folder id is not emulated (the paging fixture lists a folder by id).'
    )
  }

  const fields = selectedFields(request, messageFields)

  if (fields instanceof Response) return fields

  const messages = state.messages
    .filter(message => message.parentFolderId === folder.id)
    .sort((left, right) =>
      left.receivedDateTime === right.receivedDateTime
        ? left.id.localeCompare(right.id)
        : left.receivedDateTime < right.receivedDateTime
          ? 1
          : -1
    )

  const page = pageOf(messages, request, folderMessagesMaxTop)

  if (page instanceof Response) return page

  const context = metadataContext(
    env,
    `${userContext(request)}/mailFolders${odataKey(request.params.folderId ?? '')}/messages${selectSuffix(fields)}`
  )

  return jsonResponse(
    200,
    collection(
      context,
      page.items.map(message => project(renderMessage(message), fields)),
      nextLinkOf(env, request, page, ['$select'])
    )
  )
}

/**
 * A `recipient` write value, `{ emailAddress: { address, name? } }` with only those keys (the
 * shape the fixture responses show); anything else fails closed.
 */
const recipientOf = (
  request: RouteRequest,
  key: string,
  value: Schema.Json
): MicrosoftEmulatorRecipient | Response => {
  const expected = `${key} { emailAddress: { address, name? } }`
  const recipient = nestedObject(request, value, ['emailAddress'], expected)

  if (recipient instanceof Response) return recipient

  const email = nestedObject(request, recipient.emailAddress, ['address', 'name'], expected)

  if (email instanceof Response) return email

  const { address, name } = email

  if (!Predicate.isString(address) || (name !== undefined && !Predicate.isString(name))) {
    return invalidValue(request, `${expected} needs a string address (and name).`)
  }

  return { name: name ?? null, address }
}

/** `[recipient]` as stored recipients. */
const recipientsOf = (
  request: RouteRequest,
  key: string,
  value: Schema.Json
): ReadonlyArray<MicrosoftEmulatorRecipient> | Response => {
  if (!Array.isArray(value)) return invalidValue(request, `${key} must be an array.`)

  const recipients: Array<MicrosoftEmulatorRecipient> = []

  for (const entry of value) {
    const recipient = recipientOf(request, key, entry)

    if (recipient instanceof Response) return recipient

    recipients.push(recipient)
  }

  return recipients
}

type MessageWrite = {
  subject?: string
  bodyContent?: string
  toRecipients?: ReadonlyArray<MicrosoftEmulatorRecipient>
  isRead?: boolean
}

/** Draft create keys, as the Outlook fixtures send them. */
const draftKeys: ReadonlyArray<string> = ['subject', 'body', 'toRecipients', 'from']

/** Message update keys, as the Outlook fixtures send them. */
const updateKeys: ReadonlyArray<string> = ['subject', 'isRead']

/** The emulated message fields of a create or update body (keys already allowlisted). */
const messageWrite = (
  request: RouteRequest,
  fields: Schema.JsonObject,
  user: MicrosoftEmulatorUser
): MessageWrite | Response => {
  const write: MessageWrite = {}

  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case 'subject':
        if (!Predicate.isString(value)) return invalidValue(request, 'subject must be a string.')

        write.subject = value
        break
      case 'body': {
        const content = textBody(request, value)

        if (content instanceof Response) return content

        write.bodyContent = content
        break
      }

      case 'toRecipients': {
        const recipients = recipientsOf(request, key, value)

        if (recipients instanceof Response) return recipients

        write.toRecipients = recipients
        break
      }

      case 'from': {
        const from = recipientOf(request, key, value)

        if (from instanceof Response) return from

        if (from.address.toLowerCase() !== user.mail.toLowerCase()) {
          return notEmulated(request, 'from must be the mailbox owner (send-as is not emulated).')
        }

        break
      }

      case 'isRead':
        if (!Predicate.isBoolean(value)) return invalidValue(request, 'isRead must be a boolean.')

        write.isRead = value
        break
    }
  }

  return write
}

/**
 * `POST /users/{userId}/messages`: a new draft in Drafts (201 with the message). Never sent. New
 * drafts have no attachments (`hasAttachments: false`, as the fixtures record).
 */
export const createDraft: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const fields = bodyObject(request, draftKeys)

  if (fields instanceof Response) return fields

  const write = messageWrite(request, fields, user)

  if (write instanceof Response) return write

  const drafts = wellKnownFolder(state, 'drafts')

  if (drafts === undefined) return notFound(request)

  let number = state.counters.nextMessageNumber
  let id = `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-${padded(number, 4)}=`

  while (findMessage(state, id) !== undefined) {
    number += 1
    id = `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A-synthetic-immutable-${padded(number, 4)}=`
  }

  state.counters = { ...state.counters, nextMessageNumber: number + 1 }

  const now = nowTimestamp(env)
  const owner: MicrosoftEmulatorRecipient = { name: user.displayName, address: user.mail }

  const message: MicrosoftEmulatorMessage = {
    id,
    parentFolderId: drafts.id,
    subject: write.subject ?? '',
    bodyContentType: 'text',
    bodyContent: write.bodyContent ?? '',
    from: owner,
    sender: owner,
    toRecipients: write.toRecipients ?? [],
    ccRecipients: [],
    bccRecipients: [],
    replyTo: [],
    isRead: true,
    isDraft: true,
    importance: 'normal',
    flagStatus: 'notFlagged',
    categories: [],
    hasAttachments: false,
    createdDateTime: now,
    lastModifiedDateTime: now,
    receivedDateTime: now,
    sentDateTime: now,
    conversationId: `AAQkAGI2-synthetic-conversation-draft-${padded(number, 4)}=`,
    internetMessageId: `<synthetic-draft-${padded(number, 4)}@example.test>`,
    changeKey: nextChangeKey(state, messageTagPrefix)
  }

  state.messages = [...state.messages, message]

  return jsonResponse(201, entity(messageEntityContext(env, request), renderMessage(message)))
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * Run a message write under its message's lock: a write that finds the lock held loses with 409
 * (nothing changes); the first write to reach the handler commits, then holds the lock for
 * `conflictWindowMs` before answering.
 */
const withMessageLock = async (
  env: MicrosoftApiEnv,
  request: RouteRequest,
  message: MicrosoftEmulatorMessage,
  commit: () => Response
): Promise<Response> => {
  if (env.messageLocks.has(message.id)) return conflict(request)

  env.messageLocks.add(message.id)

  try {
    const response = commit()

    if (env.conflictWindowMs > 0) await delay(env.conflictWindowMs)

    return response
  } finally {
    env.messageLocks.delete(message.id)
  }
}

/**
 * `PATCH /users/{userId}/messages/{messageId}`: update a draft's `subject` or `isRead`; 200 with
 * the message.
 */
export const updateMessage: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const notDraft = notDraftProblem(request, message)

  if (notDraft !== undefined) return notDraft

  const fields = bodyObject(request, updateKeys)

  if (fields instanceof Response) return fields

  const write = messageWrite(request, fields, user)

  if (write instanceof Response) return write

  return withMessageLock(env, request, message, () => {
    const updated: MicrosoftEmulatorMessage = {
      ...message,
      ...write,
      lastModifiedDateTime: nowTimestamp(env),
      changeKey: nextChangeKey(state, messageTagPrefix)
    }

    replaceMessage(state, updated)

    return jsonResponse(200, entity(messageEntityContext(env, request), renderMessage(updated)))
  })
}

/**
 * `POST /users/{userId}/messages/{messageId}/move` with `{ destinationId: 'deleteditems' }`, the
 * only destination a fixture sends: 201 with the moved draft, which keeps its (immutable) id. Any
 * other destination (another well-known name such as `inbox` or `drafts`, or a folder id) is not
 * emulated (400) and moves nothing.
 */
export const moveMessage: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const notDraft = notDraftProblem(request, message)

  if (notDraft !== undefined) return notDraft

  const fields = bodyObject(request, ['destinationId'])

  if (fields instanceof Response) return fields

  if (!Predicate.isString(fields.destinationId)) {
    return invalidValue(request, 'destinationId must be a folder id or well-known name.')
  }

  if (fields.destinationId !== moveDestination) {
    return notEmulated(
      request,
      `moves to destinations other than ${moveDestination} are not emulated (the fixtures move only to Deleted Items).`
    )
  }

  // Every valid seed has a Deleted Items folder (the seed check requires it).
  const destination = wellKnownFolder(state, moveDestination)

  if (destination === undefined) return notFound(request)

  return withMessageLock(env, request, message, () => {
    const moved: MicrosoftEmulatorMessage = {
      ...message,
      parentFolderId: destination.id,
      lastModifiedDateTime: nowTimestamp(env),
      changeKey: nextChangeKey(state, messageTagPrefix)
    }

    replaceMessage(state, moved)

    return jsonResponse(201, entity(messageEntityContext(env, request), renderMessage(moved)))
  })
}

const attachmentBase = (attachment: MicrosoftEmulatorAttachment) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  '@odata.mediaContentType': attachment.contentType,
  id: attachment.id
})

/** A listed attachment: base `attachment` properties only (no `contentId`), as the fixture shows. */
const renderListedAttachment = (attachment: MicrosoftEmulatorAttachment) => ({
  ...attachmentBase(attachment),
  name: attachment.name,
  contentType: attachment.contentType,
  size: attachment.size,
  isInline: attachment.isInline,
  lastModifiedDateTime: attachment.lastModifiedDateTime
})

/** A retrieved file attachment, with `contentId` and `contentBytes`, in the fixture key order. */
const renderAttachment = (attachment: MicrosoftEmulatorAttachment) => ({
  ...attachmentBase(attachment),
  lastModifiedDateTime: attachment.lastModifiedDateTime,
  name: attachment.name,
  contentType: attachment.contentType,
  size: attachment.size,
  isInline: attachment.isInline,
  contentId: attachment.contentId,
  contentLocation: attachment.contentLocation,
  contentBytes: attachment.contentBytes
})

/**
 * `GET /users/{userId}/messages/{messageId}/attachments`: every attachment, inline ones included,
 * in one response (the fixtures send only `$select`: no `$top`, `$skip`, or `@odata.nextLink`).
 * `$select` accepts only base `attachment` properties, so a listing never carries `contentId`.
 */
export const listAttachments: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const fields = selectedFields(request, attachmentListFields)

  if (fields instanceof Response) return fields

  const attachments = state.attachments.filter(attachment => attachment.messageId === message.id)

  const context = metadataContext(
    env,
    `${userContext(request)}/messages${odataKey(request.params.messageId ?? '')}/attachments${selectSuffix(fields)}`
  )

  return jsonResponse(
    200,
    collection(
      context,
      attachments.map(attachment => project(renderListedAttachment(attachment), fields)),
      undefined
    )
  )
}

/** `GET /users/{userId}/messages/{messageId}/attachments/{attachmentId}`: the file attachment. */
export const getAttachment: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const immutable = immutableIdProblem(request)

  if (immutable !== undefined) return immutable

  const message = findMessage(state, request.params.messageId ?? '')

  const attachment =
    message === undefined
      ? undefined
      : state.attachments.find(
          candidate =>
            candidate.messageId === message.id && candidate.id === request.params.attachmentId
        )

  const context = metadataContext(
    env,
    `${userContext(request)}/messages${odataKey(request.params.messageId ?? '')}/attachments/$entity`
  )

  return attachment === undefined
    ? notFound(request)
    : jsonResponse(200, entity(context, renderAttachment(attachment)))
}

// JSON batching: only permanent-delete subrequests are emulated.

const maxBatchRequests = 20

const permanentDeletePattern = /^\/?users\/([^/?#]+)\/messages\/([^/?#]+)\/permanentDelete$/

/** Subrequest headers the fixtures send (`Prefer`, which must ask for immutable ids). */
const allowedSubrequestHeaders: ReadonlyArray<string> = ['prefer']

type PermanentDelete = {
  readonly id: string
  readonly userId: string
  readonly messageId: string
}

/** A validated subrequest, or why the whole batch is refused. */
const permanentDeleteOf = (entry: Schema.Json): PermanentDelete | string => {
  if (!isJsonObject(entry)) return 'each batch request must be an object.'

  const unknown = Object.keys(entry).find(key => !['id', 'method', 'url', 'headers'].includes(key))

  if (unknown !== undefined) {
    return `batch request property '${unknown}' is not emulated (no dependsOn or bodies).`
  }

  const { id, method, url, headers } = entry

  if (!Predicate.isString(id) || id.trim() === '') return 'each batch request needs an id.'

  if (!Predicate.isString(method) || !Predicate.isString(url)) {
    return 'each batch request needs a method and a url.'
  }

  const match = permanentDeletePattern.exec(url)

  if (method.toUpperCase() !== 'POST' || match === null) {
    return 'only POST /users/{userId}/messages/{messageId}/permanentDelete subrequests are emulated.'
  }

  const userId = decodeSegment(match[1] ?? '')
  const messageId = decodeSegment(match[2] ?? '')

  if (userId === undefined || messageId === undefined) return 'a batch url is not decodable.'

  if (!isJsonObject(headers)) {
    return 'batch requests without headers { Prefer: IdType="ImmutableId" } are not emulated.'
  }

  let prefer: string | undefined

  for (const [name, value] of Object.entries(headers)) {
    if (!allowedSubrequestHeaders.includes(name.toLowerCase()) || !Predicate.isString(value)) {
      return `batch request header '${name}' is not emulated.`
    }

    prefer = value
  }

  if (!parsePreferences(prefer ?? null).immutableId) {
    return 'batch requests without Prefer: IdType="ImmutableId" are not emulated.'
  }

  return { id, userId, messageId }
}

/**
 * `POST /$batch`: at most 20 subrequests with unique ids, each a message `permanentDelete` with
 * `Prefer: IdType="ImmutableId"`, answered `{ responses: [{ id, status: 204, headers: {} }] }` as
 * the fixtures record. Every subrequest is checked before any runs: anything else (another
 * route, an unknown user or message, a message named twice, a message with a write in flight, a
 * message that is not a draft, or one with attachments) refuses the whole batch with 400 and
 * deletes nothing, because no fixture records a failed subrequest or deletes anything but a
 * case-created draft (which has no attachments).
 */
export const batch: RouteHandler = (state, request, env) => {
  const fields = bodyObject(request, ['requests'])

  if (fields instanceof Response) return fields

  const requests = fields.requests

  if (!Array.isArray(requests) || requests.length === 0 || requests.length > maxBatchRequests) {
    return invalidValue(request, `requests must hold 1 to ${maxBatchRequests} subrequests.`)
  }

  const deletes: Array<PermanentDelete> = []

  for (const entry of requests) {
    const parsed = permanentDeleteOf(entry)

    if (Predicate.isString(parsed)) {
      return request.error(400, codes.unknownRoute, `Synthetic: ${parsed}`)
    }

    if (deletes.some(existing => existing.id === parsed.id)) {
      return invalidValue(request, `batch request id ${parsed.id} is used twice.`)
    }

    deletes.push(parsed)
  }

  const messages: Array<MicrosoftEmulatorMessage> = []

  for (const entry of deletes) {
    const itemRequest: RouteRequest = {
      ...request,
      params: { userId: entry.userId, messageId: entry.messageId }
    }

    const message = findMessage(state, entry.messageId)

    if (resolveUser(state, itemRequest) instanceof Response) {
      return notEmulated(request, `batch request ${entry.id} names a user that is not emulated.`)
    }

    if (message === undefined || messages.includes(message)) {
      return notEmulated(
        request,
        `batch request ${entry.id} names a missing or repeated message (failed subrequests are not emulated).`
      )
    }

    if (!message.isDraft) {
      return notEmulated(
        request,
        `batch request ${entry.id} names a message that is not a draft (the fixtures delete only drafts).`
      )
    }

    if (state.attachments.some(attachment => attachment.messageId === message.id)) {
      return notEmulated(
        request,
        `batch request ${entry.id} names a message with attachments (not emulated: no fixture deletes one).`
      )
    }

    if (env.messageLocks.has(message.id)) {
      return notEmulated(
        request,
        `batch request ${entry.id} names a message with a write in flight (failed subrequests are not emulated).`
      )
    }

    messages.push(message)
  }

  const removed = new Set(messages.map(message => message.id))

  state.messages = state.messages.filter(message => !removed.has(message.id))

  return jsonResponse(200, {
    responses: deletes.map(entry => ({ id: entry.id, status: 204, headers: {} }))
  })
}
