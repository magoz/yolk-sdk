/**
 * Microsoft Graph emulator SharePoint site and Teams routes (internal), fixture-only: every answer
 * is a recorded exchange of the Teams and SharePoint site conformance fixtures, copied as data in
 * `teams-sites-recordings.ts` (status, content type, and body byte for byte), and anything no
 * fixture records answers the 400 not emulated before anything is written. These routes read no
 * entity of the state: under the `default` profile (the state flag `recordedTeamsSites`), a
 * request is answered when its raw path and its query parameters (decoded, in any order) equal a
 * recorded request's; under `empty` every request answers the 400 not emulated, since no fixture
 * records an empty listing.
 *
 * The one write is the chat send. It answers only the recorded send: the recorded chat (the
 * dedicated send chat), and a body of exactly `{ body: { contentType: 'html', content } }` whose
 * content is the recorded text with any run id (`run-` then lower-case letters, digits, and inner
 * hyphens, at most 40 characters) in place of the recorded one (taken from the copied fixture
 * body). Its answer is the recorded 201 with that run id and a minted message id (`1790000000000`
 * plus the `nextChatMessageNumber` counter, which starts at the recorded `1790000000101` and only
 * advances), both substituted in one pass. The sent message is recorded in the state
 * (`chatMessagesSent`), since Graph cannot undo a send; a read of a sent message by its id answers
 * the recorded readback with the same substitutions, and a listing of a chat holding a sent message
 * is not emulated (no fixture lists one).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  isJsonObject,
  notEmulated,
  parseJsonText,
  type MicrosoftApiEnv,
  type RouteHandler,
  type RouteRequest
} from './graph.ts'
import type { MicrosoftEmulatorState } from './state.ts'
import {
  microsoftTeamsSitesFixtures,
  type MicrosoftRecordedExchange,
  type MicrosoftRecordedFixture
} from './teams-sites-recordings.ts'

/** The query parameters of a request, decoded and sorted, as one comparable string. */
const canonicalQuery = (query: URLSearchParams): string =>
  JSON.stringify(
    [...query.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftKey < rightKey
          ? -1
          : 1
    )
  )

/** The recording key of a request: method, raw path, and canonical query. */
const requestKey = (method: string, path: string, query: URLSearchParams): string =>
  `${method} ${path} ${canonicalQuery(query)}`

const recordedKey = (exchange: MicrosoftRecordedExchange): string => {
  const url = new URL(exchange.request.url)

  return requestKey(exchange.request.method, url.pathname, url.searchParams)
}

const sendCaseId = 'microsoft.teams.send-chat-message'

/** Every recorded GET of the read cases, by recording key. */
const recordedReads = new Map(
  microsoftTeamsSitesFixtures
    .filter(fixture => fixture.caseId !== sendCaseId)
    .flatMap(fixture => fixture.exchanges)
    .filter(exchange => exchange.request.method === 'GET')
    .map(exchange => [recordedKey(exchange), exchange.response] as const)
)

/** Base of minted chat message ids: `1790000000101` for counter value 101. */
const mintedIdBase = 1_790_000_000_000

const runIdSource = 'run-[a-z0-9]+(?:-[a-z0-9]+)*'

const runIdPattern = `(${runIdSource})`

/** The run id a recorded send text names (the fixtures' `run-synthetic`, or a promoted one). */
const recordedRunIdPattern = new RegExp(runIdSource, 'u')

const maxRunIdLength = 40

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type SendTemplate = {
  /** The recorded chat id (decoded). */
  readonly chatId: string
  /** The run id the recorded message content names, taken from the copied fixture body. */
  readonly runId: string
  /** The recorded message content, matched with any run id in place of the recorded one. */
  readonly content: RegExp
  /** The recorded message id the answers carry. */
  readonly messageId: string
  readonly sent: MicrosoftRecordedExchange['response']
  readonly readback: MicrosoftRecordedExchange['response']
}

/**
 * The send fixture's two exchanges (the POST and the readback GET) among `fixtures`, read once at
 * load. The recorded run id comes from the copied body, so promoting a live recording (another run
 * id) keeps working.
 */
export const sendTemplateOf = (
  fixtures: ReadonlyArray<MicrosoftRecordedFixture>
): SendTemplate | undefined => {
  const fixture = fixtures.find(candidate => candidate.caseId === sendCaseId)
  const [post, readback] = fixture?.exchanges ?? []
  const body = post?.request.body

  if (post === undefined || readback === undefined || !isJsonObject(body)) return undefined

  const message = body.body
  const content = isJsonObject(message) ? message.content : undefined
  const chatSegment = /^\/v1\.0\/chats\/([^/]+)\/messages$/.exec(new URL(post.request.url).pathname)
  const readbackSegment = /\/messages\/([^/]+)$/.exec(new URL(readback.request.url).pathname)

  const runId = Predicate.isString(content) ? recordedRunIdPattern.exec(content)?.[0] : undefined

  if (
    !Predicate.isString(content) ||
    runId === undefined ||
    chatSegment?.[1] === undefined ||
    readbackSegment?.[1] === undefined
  ) {
    return undefined
  }

  return {
    chatId: decodeURIComponent(chatSegment[1]),
    runId,
    content: new RegExp(`^${content.split(runId).map(escapeRegExp).join(runIdPattern)}$`, 'u'),
    messageId: readbackSegment[1],
    sent: post.response,
    readback: readback.response
  }
}

const send = sendTemplateOf(microsoftTeamsSitesFixtures)

/** A JSON body transform a drill knob applies, or `undefined` when the knob is off. */
type Drill = (env: MicrosoftApiEnv) => ((body: Schema.JsonObject) => Schema.JsonObject) | undefined

const mapValues =
  (edit: (item: Schema.JsonObject) => Schema.JsonObject) =>
  (body: Schema.JsonObject): Schema.JsonObject => ({
    ...body,
    value: Array.isArray(body.value)
      ? body.value.map(item => (isJsonObject(item) ? edit(item) : item))
      : (body.value ?? null)
  })

const withoutKey = (item: Schema.JsonObject, key: string): Schema.JsonObject =>
  Object.fromEntries(Object.entries(item).filter(([name]) => name !== key))

/** A recorded answer as a response, through the route's drill when it is on. */
const answer = (
  recorded: MicrosoftRecordedExchange['response'],
  body: string,
  transform: ((body: Schema.JsonObject) => Schema.JsonObject) | undefined
): Response => {
  const parsed = transform === undefined ? undefined : parseJsonText(body)

  return new Response(
    transform !== undefined && isJsonObject(parsed) ? JSON.stringify(transform(parsed)) : body,
    { status: recorded.status, headers: recorded.headers }
  )
}

/** The recorded answer of a read request, or 400 not emulated. */
const recordedRead =
  (drill?: Drill): RouteHandler =>
  (_state, request, env) => {
    const recorded = recordedReads.get(requestKey('GET', request.path, request.query))

    return recorded === undefined
      ? notEmulated(
          request,
          'no fixture records this request on the fixture-only Teams and SharePoint routes.'
        )
      : answer(recorded, recorded.body, drill?.(env))
  }

const sentMessage = (state: MicrosoftEmulatorState, request: RouteRequest) =>
  state.chatMessagesSent.find(
    message => message.chatId === request.params.chatId && message.id === request.params.messageId
  )

/**
 * A recorded send answer with the minted message id and the request's run id in place of the
 * recorded ones, in one pass: an inserted run id is never scanned again, so a run id that holds the
 * recorded message id (`run-1790000000101`) comes back as sent.
 */
const substituted = (
  template: SendTemplate,
  body: string,
  runId: string,
  messageId: string
): string =>
  body.replace(
    new RegExp(`${escapeRegExp(template.messageId)}|${escapeRegExp(template.runId)}`, 'gu'),
    match => (match === template.messageId ? messageId : runId)
  )

/** `GET /sites?search=` (the recorded search). */
const searchSitesRecorded: RouteHandler = recordedRead(env =>
  env.drills.siteSearchEmpty ? body => ({ ...body, value: [] }) : undefined
)

/** `GET /sites/{siteId}/drives` (the recorded site's libraries). */
const listSiteDrivesRecorded: RouteHandler = recordedRead(env =>
  env.drills.siteDrivesNoLibrary
    ? mapValues(drive => ({ ...drive, driveType: 'business' }))
    : undefined
)

/** `GET /me/chats` (the recorded page). */
const listChatsRecorded: RouteHandler = recordedRead(env =>
  env.drills.chatsOmitMembers ? mapValues(chat => withoutKey(chat, 'members')) : undefined
)

/** `GET /chats/{chatId}` (the recorded chat). */
const getChatRecorded: RouteHandler = recordedRead()

const readChatMessages = recordedRead(env =>
  env.drills.chatMessagesOmitNextLink ? body => withoutKey(body, '@odata.nextLink') : undefined
)

/** `GET /chats/{chatId}/messages` (the recorded pages; not once the chat holds a sent message). */
const listChatMessagesRecorded: RouteHandler = (state, request, env) =>
  state.chatMessagesSent.some(message => message.chatId === request.params.chatId)
    ? notEmulated(
        request,
        'listing a chat that holds a message sent here is not emulated (no fixture lists one).'
      )
    : readChatMessages(state, request, env)

const readChatMessage = recordedRead()

/** `GET /chats/{chatId}/messages/{messageId}`: a sent message, else the recorded read. */
const getChatMessageRecorded: RouteHandler = (state, request, env) => {
  const sent = sentMessage(state, request)

  return sent === undefined || send === undefined
    ? readChatMessage(state, request, env)
    : answer(send.readback, substituted(send, send.readback.body, sent.runId, sent.id), undefined)
}

/** The run id of a send body that is the recorded one (any run id), or a refusal. */
const sendRunId = (request: RouteRequest, template: SendTemplate): string | Response => {
  const body = request.body
  const message = isJsonObject(body) ? body.body : undefined

  if (
    !isJsonObject(body) ||
    Object.keys(body).join(',') !== 'body' ||
    !isJsonObject(message) ||
    Object.keys(message).sort().join(',') !== 'content,contentType' ||
    message.contentType !== 'html' ||
    !Predicate.isString(message.content)
  ) {
    return notEmulated(
      request,
      'a send body other than { body: { contentType: html, content } } is not emulated.'
    )
  }

  const runId = template.content.exec(message.content)?.[1]

  return runId === undefined || runId.length > maxRunIdLength
    ? notEmulated(request, 'a message other than the recorded conformance text is not emulated.')
    : runId
}

/** `POST /chats/{chatId}/messages`: the recorded send, recorded in the state. */
const sendChatMessageRecorded: RouteHandler = (state, request, env) => {
  if (send === undefined || request.params.chatId !== send.chatId) {
    return notEmulated(request, 'a send to a chat no fixture records is not emulated.')
  }

  const runId = sendRunId(request, send)

  if (runId instanceof Response) return runId

  const number = state.counters.nextChatMessageNumber
  const id = String(mintedIdBase + number)

  state.chatMessagesSent = [...state.chatMessagesSent, { chatId: send.chatId, id, runId }]
  state.counters = { ...state.counters, nextChatMessageNumber: number + 1 }

  return answer(
    send.sent,
    substituted(send, send.sent.body, runId, id),
    env.drills.chatSendUnescaped
      ? body => {
          const message = body.body

          return isJsonObject(message) && Predicate.isString(message.content)
            ? {
                ...body,
                body: {
                  ...message,
                  content: message.content.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
                }
              }
            : body
        }
      : undefined
  )
}

/** `GET /me/joinedTeams` (the recorded listing). */
const listJoinedTeamsRecorded: RouteHandler = recordedRead(env =>
  env.drills.joinedTeamsEmpty ? body => ({ ...body, value: [] }) : undefined
)

/** `GET /teams/{teamId}`, `/channels`, `/channels/{channelId}`, and channel posts (recorded). */
const readTeamsRecorded: RouteHandler = recordedRead()

/** `GET /teams/{teamId}/channels/{channelId}/messages/{messageId}/replies` (recorded). */
const listRepliesRecorded: RouteHandler = recordedRead(env =>
  env.drills.repliesOmitReplyToId ? mapValues(reply => ({ ...reply, replyToId: null })) : undefined
)

/** `GET /me/onlineMeetings?$filter=` (the recorded lookup). */
const findOnlineMeetingRecorded: RouteHandler = recordedRead()

/** `GET /me/onlineMeetings/{meetingId}/transcripts` (the recorded listing). */
const listTranscriptsRecorded: RouteHandler = recordedRead(env =>
  env.drills.transcriptsOtherMeeting
    ? mapValues(transcript => ({ ...transcript, meetingId: 'MSpvdGhlcg' }))
    : undefined
)

/**
 * Only the default profile holds the recorded Teams and SharePoint data (its state flag
 * `recordedTeamsSites`); under the `empty` profile every one of these routes answers the 400 not
 * emulated, since no fixture records an empty listing or a missing item.
 */
const onlyRecorded =
  (handler: RouteHandler): RouteHandler =>
  (state, request, env) =>
    state.recordedTeamsSites
      ? handler(state, request, env)
      : notEmulated(
          request,
          'this profile holds no Teams or SharePoint data, and no fixture records an empty answer.'
        )

export const searchSites = onlyRecorded(searchSitesRecorded)

export const listSiteDrives = onlyRecorded(listSiteDrivesRecorded)

export const listChats = onlyRecorded(listChatsRecorded)

export const getChat = onlyRecorded(getChatRecorded)

export const listChatMessages = onlyRecorded(listChatMessagesRecorded)

export const getChatMessage = onlyRecorded(getChatMessageRecorded)

export const sendChatMessage = onlyRecorded(sendChatMessageRecorded)

export const listJoinedTeams = onlyRecorded(listJoinedTeamsRecorded)

export const readTeams = onlyRecorded(readTeamsRecorded)

export const listReplies = onlyRecorded(listRepliesRecorded)

export const findOnlineMeeting = onlyRecorded(findOnlineMeetingRecorded)

export const listTranscripts = onlyRecorded(listTranscriptsRecorded)
