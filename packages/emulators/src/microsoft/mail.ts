/**
 * Microsoft Graph emulator Outlook routes (internal): folder message listing with paging, draft
 * create, message update and move with immutable ids, attachment listing and retrieval, and the
 * JSON `$batch` permanent delete. Wire shapes follow the synthetic Outlook conformance fixtures.
 *
 * Ids: every message has an immutable id (answered under `Prefer: IdType="ImmutableId"`) and a
 * default id that a move regenerates; either addresses the message while it is current.
 *
 * Concurrent writes: a message write (update or move) holds its message for `conflictWindowMs`
 * before answering. Another write to the same message that arrives in that window loses with 409
 * `ErrorIrresolvableConflict` and changes nothing; the first arrival wins. Writes that do not
 * overlap both apply (last writer wins).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  bodyObject,
  codes,
  collection,
  invalidValue,
  isJsonObject,
  jsonResponse,
  nextChangeKey,
  nextLinkOf,
  notEmulated,
  nowTimestamp,
  padded,
  pageOf,
  parsePreferences,
  project,
  resolveUser,
  selectedFields,
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

const hasAttachments = (state: MicrosoftEmulatorState, message: MicrosoftEmulatorMessage) =>
  state.attachments.some(attachment => attachment.messageId === message.id && !attachment.isInline)

const idFor = (request: RouteRequest, message: MicrosoftEmulatorMessage): string =>
  request.prefer.immutableId ? message.id : message.restId

/** The full message, in the draft fixture's key order. */
const renderMessage = (
  state: MicrosoftEmulatorState,
  request: RouteRequest,
  message: MicrosoftEmulatorMessage
) => {
  const id = idFor(request, message)

  return {
    '@odata.etag': `W/"${message.changeKey}"`,
    id,
    createdDateTime: message.createdDateTime,
    lastModifiedDateTime: message.lastModifiedDateTime,
    changeKey: message.changeKey,
    categories: message.categories,
    receivedDateTime: message.receivedDateTime,
    sentDateTime: message.sentDateTime,
    hasAttachments: hasAttachments(state, message),
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

/** A folder by id or well-known name (`inbox`, `drafts`, `deleteditems`). */
const findFolder = (
  state: MicrosoftEmulatorState,
  idOrName: string
): MicrosoftEmulatorMailFolder | undefined =>
  state.mailFolders.find(
    folder => folder.id === idOrName || folder.wellKnownName === idOrName.toLowerCase()
  )

/** A message by its immutable id or its current default id. */
const findMessage = (
  state: MicrosoftEmulatorState,
  id: string
): MicrosoftEmulatorMessage | undefined =>
  state.messages.find(message => message.id === id || message.restId === id)

const replaceMessage = (state: MicrosoftEmulatorState, updated: MicrosoftEmulatorMessage) => {
  state.messages = state.messages.map(message => (message.id === updated.id ? updated : message))
}

/**
 * `GET /users/{userId}/mailFolders/{folderId}/messages`: newest `receivedDateTime` first, one
 * `$top`/`$skip` page with an opaque `@odata.nextLink` on the configured Graph origin.
 */
export const listFolderMessages: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const folder = findFolder(state, request.params.folderId ?? '')

  if (folder === undefined) return notFound(request)

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

  const page = pageOf(messages, request, { defaultTop: 10, maxTop: 1000 })

  if (page instanceof Response) return page

  return jsonResponse(
    200,
    collection(
      page.items.map(message => project(renderMessage(state, request, message), fields)),
      nextLinkOf(env, request, page, ['$select'])
    )
  )
}

/** `[{ emailAddress: { address, name? } }]` as stored recipients. */
const recipientsOf = (
  request: RouteRequest,
  key: string,
  value: Schema.Json
): ReadonlyArray<MicrosoftEmulatorRecipient> | Response => {
  if (!Array.isArray(value)) return invalidValue(request, `${key} must be an array.`)

  const recipients: Array<MicrosoftEmulatorRecipient> = []

  for (const entry of value) {
    const email = isJsonObject(entry) ? entry.emailAddress : undefined
    const address = isJsonObject(email) ? email.address : undefined
    const name = isJsonObject(email) ? email.name : undefined

    if (!Predicate.isString(address) || (name !== undefined && !Predicate.isString(name))) {
      return invalidValue(request, `${key} entries must be { emailAddress: { address, name? } }.`)
    }

    recipients.push({ name: name ?? null, address })
  }

  return recipients
}

type MessageWrite = {
  subject?: string
  bodyContentType?: MicrosoftEmulatorMessage['bodyContentType']
  bodyContent?: string
  toRecipients?: ReadonlyArray<MicrosoftEmulatorRecipient>
  ccRecipients?: ReadonlyArray<MicrosoftEmulatorRecipient>
  bccRecipients?: ReadonlyArray<MicrosoftEmulatorRecipient>
  isRead?: boolean
  flagStatus?: MicrosoftEmulatorMessage['flagStatus']
  categories?: ReadonlyArray<string>
}

/** Fields only a draft accepts; updating them on a sent or received message fails. */
const draftOnlyKeys: ReadonlyArray<string> = [
  'subject',
  'body',
  'toRecipients',
  'ccRecipients',
  'bccRecipients'
]

const flagStatuses: ReadonlyArray<MicrosoftEmulatorMessage['flagStatus']> = [
  'notFlagged',
  'flagged',
  'complete'
]

const isFlagStatus = (value: unknown): value is MicrosoftEmulatorMessage['flagStatus'] =>
  flagStatuses.some(candidate => candidate === value)

/** The emulated message fields of a create or update body; anything else fails closed. */
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
        const contentType = isJsonObject(value) ? value.contentType : undefined
        const content = isJsonObject(value) ? value.content : undefined

        if (
          !Predicate.isString(contentType) ||
          !['text', 'html'].includes(contentType.toLowerCase()) ||
          !Predicate.isString(content)
        ) {
          return invalidValue(request, 'body must be { contentType: Text | HTML, content }.')
        }

        write.bodyContentType = contentType.toLowerCase() === 'html' ? 'html' : 'text'
        write.bodyContent = content
        break
      }

      case 'toRecipients':
      case 'ccRecipients':
      case 'bccRecipients': {
        const recipients = recipientsOf(request, key, value)

        if (recipients instanceof Response) return recipients

        write[key] = recipients
        break
      }

      case 'from': {
        const address =
          isJsonObject(value) && isJsonObject(value.emailAddress)
            ? value.emailAddress.address
            : undefined

        if (!Predicate.isString(address) || address.toLowerCase() !== user.mail.toLowerCase()) {
          return notEmulated(request, 'from must be the mailbox owner (send-as is not emulated).')
        }

        break
      }

      case 'isRead':
        if (!Predicate.isBoolean(value)) return invalidValue(request, 'isRead must be a boolean.')

        write.isRead = value
        break
      case 'flag': {
        const status = isJsonObject(value) ? value.flagStatus : undefined

        if (!isJsonObject(value) || Object.keys(value).some(field => field !== 'flagStatus')) {
          return notEmulated(request, 'flag supports flagStatus only.')
        }

        if (!isFlagStatus(status)) {
          return invalidValue(request, 'flag.flagStatus must be notFlagged, flagged, or complete.')
        }

        write.flagStatus = status
        break
      }

      case 'categories':
        if (!Array.isArray(value) || !value.every(Predicate.isString)) {
          return invalidValue(request, 'categories must be an array of strings.')
        }

        write.categories = value.filter(Predicate.isString)
        break
    }
  }

  return write
}

const draftKeys: ReadonlyArray<string> = [
  'subject',
  'body',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'from',
  'isRead',
  'flag',
  'categories'
]

/** A fresh default (mutable) message id. */
const nextRestId = (state: MicrosoftEmulatorState): string => {
  let number = state.counters.nextRestIdNumber
  let id = `AAMkAGI2-synthetic-restid-${padded(number, 4)}=`

  while (findMessage(state, id) !== undefined) {
    number += 1
    id = `AAMkAGI2-synthetic-restid-${padded(number, 4)}=`
  }

  state.counters = { ...state.counters, nextRestIdNumber: number + 1 }

  return id
}

/** `POST /users/{userId}/messages`: a new draft in Drafts (201 with the message). Never sent. */
export const createDraft: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const fields = bodyObject(request, draftKeys)

  if (fields instanceof Response) return fields

  const write = messageWrite(request, fields, user)

  if (write instanceof Response) return write

  const drafts = findFolder(state, 'drafts')

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
    restId: nextRestId(state),
    parentFolderId: drafts.id,
    subject: write.subject ?? '',
    bodyContentType: write.bodyContentType ?? 'text',
    bodyContent: write.bodyContent ?? '',
    from: owner,
    sender: owner,
    toRecipients: write.toRecipients ?? [],
    ccRecipients: write.ccRecipients ?? [],
    bccRecipients: write.bccRecipients ?? [],
    replyTo: [],
    isRead: write.isRead ?? true,
    isDraft: true,
    importance: 'normal',
    flagStatus: write.flagStatus ?? 'notFlagged',
    categories: write.categories ?? [],
    createdDateTime: now,
    lastModifiedDateTime: now,
    receivedDateTime: now,
    sentDateTime: now,
    conversationId: `AAQkAGI2-synthetic-conversation-draft-${padded(number, 4)}=`,
    internetMessageId: `<synthetic-draft-${padded(number, 4)}@example.test>`,
    changeKey: nextChangeKey(state, messageTagPrefix)
  }

  state.messages = [...state.messages, message]

  return jsonResponse(201, renderMessage(state, request, message))
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * Run a message write under its message's lock: a write that finds the lock held loses with 409
 * (nothing changes); the winner commits, then holds the lock for `conflictWindowMs` before
 * answering.
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
 * `PATCH /users/{userId}/messages/{messageId}`: update read state, flag, categories, and (drafts
 * only) subject, body, and recipients; 200 with the message.
 */
export const updateMessage: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const fields = bodyObject(
    request,
    draftKeys.filter(key => key !== 'from')
  )

  if (fields instanceof Response) return fields

  if (!message.isDraft && Object.keys(fields).some(key => draftOnlyKeys.includes(key))) {
    return notEmulated(request, 'subject, body, and recipients are updatable on drafts only.')
  }

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

    return jsonResponse(200, renderMessage(state, request, updated))
  })
}

/**
 * `POST /users/{userId}/messages/{messageId}/move` (`{ destinationId }`, a folder id or
 * well-known name): 201 with the moved message. The immutable id stays; the default id changes.
 */
export const moveMessage: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const fields = bodyObject(request, ['destinationId'])

  if (fields instanceof Response) return fields

  if (!Predicate.isString(fields.destinationId)) {
    return invalidValue(request, 'destinationId must be a folder id or well-known name.')
  }

  const destination = findFolder(state, fields.destinationId)

  if (destination === undefined) return notFound(request)

  return withMessageLock(env, request, message, () => {
    const moved: MicrosoftEmulatorMessage = {
      ...message,
      parentFolderId: destination.id,
      restId: nextRestId(state),
      lastModifiedDateTime: nowTimestamp(env),
      changeKey: nextChangeKey(state, messageTagPrefix)
    }

    replaceMessage(state, moved)

    return jsonResponse(201, renderMessage(state, request, moved))
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
 * `GET /users/{userId}/messages/{messageId}/attachments`: every attachment, inline ones included.
 * `$select` accepts only base `attachment` properties, so a listing never carries `contentId`.
 */
export const listAttachments: RouteHandler = (state, request, env) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const message = findMessage(state, request.params.messageId ?? '')

  if (message === undefined) return notFound(request)

  const fields = selectedFields(request, attachmentListFields)

  if (fields instanceof Response) return fields

  const attachments = state.attachments.filter(attachment => attachment.messageId === message.id)
  const page = pageOf(attachments, request, { defaultTop: 10, maxTop: 1000 })

  if (page instanceof Response) return page

  return jsonResponse(
    200,
    collection(
      page.items.map(attachment => project(renderListedAttachment(attachment), fields)),
      nextLinkOf(env, request, page, ['$select'])
    )
  )
}

/** `GET /users/{userId}/messages/{messageId}/attachments/{attachmentId}`: the file attachment. */
export const getAttachment: RouteHandler = (state, request) => {
  const user = resolveUser(state, request)

  if (user instanceof Response) return user

  const message = findMessage(state, request.params.messageId ?? '')

  const attachment =
    message === undefined
      ? undefined
      : state.attachments.find(
          candidate =>
            candidate.messageId === message.id && candidate.id === request.params.attachmentId
        )

  return attachment === undefined
    ? notFound(request)
    : jsonResponse(200, renderAttachment(attachment))
}

// JSON batching: only permanent-delete subrequests are emulated.

const maxBatchRequests = 20

const permanentDeletePattern = /^\/?users\/([^/?#]+)\/messages\/([^/?#]+)\/permanentDelete$/

const allowedSubrequestHeaders: ReadonlyArray<string> = ['prefer', 'content-type']

type PermanentDelete = {
  readonly id: string
  readonly userId: string
  readonly messageId: string
  readonly prefer: string | null
}

const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
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

  let prefer: string | null = null

  if (headers !== undefined) {
    if (!isJsonObject(headers)) return 'batch request headers must be an object.'

    for (const [name, value] of Object.entries(headers)) {
      if (!allowedSubrequestHeaders.includes(name.toLowerCase()) || !Predicate.isString(value)) {
        return `batch request header '${name}' is not emulated.`
      }

      if (name.toLowerCase() === 'prefer') prefer = value
    }
  }

  return { id, userId, messageId, prefer }
}

/**
 * `POST /$batch`: at most 20 subrequests with unique ids, each a message `permanentDelete`
 * (anything else refuses the whole batch with 400 before anything runs). Subrequests run in
 * order; each answers 204 (deleted, with its attachments), 404, or 409 (a write is in flight),
 * in `{ responses: [{ id, status, headers, body? }] }`.
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

  const failed = (
    id: string,
    status: number,
    code: string,
    message: string
  ): Schema.JsonObject => ({
    id,
    status,
    headers: { 'content-type': 'application/json' },
    body: { error: { code, message } }
  })

  const responses: Array<Schema.JsonObject> = []

  for (const entry of deletes) {
    const itemRequest: RouteRequest = {
      ...request,
      params: { userId: entry.userId, messageId: entry.messageId },
      prefer: parsePreferences(entry.prefer)
    }

    const message = findMessage(state, entry.messageId)

    if (resolveUser(state, itemRequest) instanceof Response) {
      responses.push(
        failed(entry.id, 404, codes.invalidUser, 'Synthetic: the user is not emulated.')
      )
    } else if (message === undefined) {
      responses.push(
        failed(
          entry.id,
          404,
          codes.mailItemNotFound,
          'The specified object was not found in the store.'
        )
      )
    } else if (env.messageLocks.has(message.id)) {
      responses.push(failed(entry.id, 409, codes.conflict, 'Synthetic: a write is in flight.'))
    } else {
      state.messages = state.messages.filter(candidate => candidate.id !== message.id)
      state.attachments = state.attachments.filter(
        attachment => attachment.messageId !== message.id
      )
      responses.push({ id: entry.id, status: 204, headers: {} })
    }
  }

  return jsonResponse(200, { responses })
}
