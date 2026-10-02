/**
 * Telegram Bot API emulator API: the route table (evidence, query allowlist, guarded path,
 * handler) and the token-aware route resolution (internal; re-exported by `src/telegram.ts`, which
 * runs the table on the shared stateful wrapper, `src/stateful-emulator.ts`, in its resolved
 * mode).
 *
 * The bot token is part of every Bot API URL (`/bot<token>/<method>`, `/file/bot<token>/<path>`).
 * It is required, but it never reaches the core, the state, the ledger, a not-emulated message, or
 * a response. Resolution fails closed: only a request whose raw path is exactly an emulated route
 * shape is recognised, and its token is taken from that exact segment; every other request is
 * ledgered and answered with constant text only. For a recognised request the ledgered path reads
 * `/bot<redacted>/...`, the routes learn only whether the token names a bot, and the wrapper
 * scrubs the token and its secret part from the ledger and refuses a path, query, or body that
 * repeats them (raw, percent-decoded, or in any parsed JSON key, string value, or number).
 *
 * Only the routes the four Telegram conformance cases need are emulated, with wire shapes copied
 * from the synthetic fixtures; everything else answers the wrapper's ledgered 400 not-emulated.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type Commit,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulResolution,
  type StatefulRoute
} from '../stateful-emulator.ts'
import type { TelegramEmulatorChat, TelegramEmulatorState } from './state.ts'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type TelegramEmulatorDrills = {
  /** `true`: `getChat` of a member chat answers 200 with `ok: false`. */
  readonly getChatOkFalse?: boolean
  /** `true`: the `getChat` errors (absent chat, token naming no bot) answer 200, not 4xx. */
  readonly errorsAs200?: boolean
  /** `true`: `getFile` reports a `file_size` one byte larger than the file. */
  readonly fileSizeOffByOne?: boolean
  /** `true`: `sendMessage` answers 200 with `ok: false` (the message is still recorded as sent). */
  readonly sendOkFalse?: boolean
}

export type TelegramApiEnv = {
  /** Clock in epoch milliseconds (`date` of sent messages). */
  readonly now: () => number
  readonly drills: Required<TelegramEmulatorDrills>
}

/**
 * The route parameter the resolution supplies instead of the token: whether the token names a bot
 * (`known`) or not (`none`). The token itself never reaches a route.
 */
const botParam = 'bot'

type RouteRequest = {
  readonly query: URLSearchParams
  /** Decoded file path of the file route. */
  readonly filePath: string | undefined
  readonly body: Schema.Json | undefined
  readonly hasBody: boolean
  readonly contentType: string | null
  /** The token names a bot (its bot id is not 0). */
  readonly knownBot: boolean
}

/** A route handler (the wrapper's plan): validate without writing, then return the commit. */
type RouteHandler = (
  state: TelegramEmulatorState,
  request: RouteRequest,
  env: TelegramApiEnv
) => Commit | NotEmulated

type TelegramApiRoute = {
  readonly route: StatefulRoute<TelegramEmulatorState, TelegramApiEnv>
  readonly queryKeys: ReadonlyArray<string>
  /** The token-free path the request must not repeat the token in (the method, or `/file`). */
  readonly guardedPath: string
}

const validateCase = 'telegram.validate.get-chat'

const errorCase = 'telegram.errors.error-envelope'

const fileCase = 'telegram.files.get-file-path'

const sendCase = 'telegram.messages.send-message'

/** Bot API JSON answers, as the fixtures record them. */
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** A chat id: an integer (negative for groups and channels) or a public `@username`. */
const chatIdPattern = /^(?:-?[1-9][0-9]{0,19}|@[A-Za-z][A-Za-z0-9_]{3,31})$/

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

const mediaType = (contentType: string | null): string | undefined =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase()

/**
 * A JSON body with exactly the `keys` the fixture records, or a refusal. Refusals never name a
 * request key or value (constant text).
 */
const bodyObject = (
  request: RouteRequest,
  keys: ReadonlyArray<string>
): Schema.JsonObject | NotEmulated => {
  if (mediaType(request.contentType) !== 'application/json') {
    return notEmulated('Bot API bodies other than application/json are not emulated')
  }

  if (!isJsonObject(request.body)) {
    return notEmulated('a request body that is not a JSON object is not emulated')
  }

  const sent = Object.keys(request.body)

  if (sent.some(key => !keys.includes(key))) {
    return notEmulated('a body field this method does not take is not emulated')
  }

  return keys.every(key => sent.includes(key))
    ? request.body
    : notEmulated(
        `requests without each of the recorded body fields (${keys.join(', ')}) are not emulated`
      )
}

const noBody = (request: RouteRequest): NotEmulated | undefined =>
  request.hasBody ? notEmulated('a request body is not emulated on this method') : undefined

/** The chat a well-formed `chat_id` names, `null` for none, or a refusal. */
const chatOf = (
  state: TelegramEmulatorState,
  chatId: Schema.Json | undefined
): TelegramEmulatorChat | null | NotEmulated => {
  if (!Predicate.isString(chatId) || !chatIdPattern.test(chatId)) {
    return notEmulated('chat_id must be a chat id string (an integer or a public @username)')
  }

  return state.chats.find(chat => String(chat.id) === chatId) ?? null
}

/** The Bot API error envelope of the error fixture. */
const botApiError = (env: TelegramApiEnv, status: number, description: string): Response =>
  json(env.drills.errorsAs200 ? 200 : status, { ok: false, error_code: status, description })

const knownBotOnly = (request: RouteRequest): NotEmulated | undefined =>
  request.knownBot
    ? undefined
    : notEmulated('a bot token that names no bot is emulated only on getChat (as recorded)')

// Handlers: validate (not emulated) first, then return the commit that writes.

const getChat: RouteHandler = (state, request, env) => {
  const body = bodyObject(request, ['chat_id'])

  if (isNotEmulated(body)) return body

  const chat = chatOf(state, body.chat_id)

  if (isNotEmulated(chat)) return chat

  if (!request.knownBot) return () => botApiError(env, 401, 'Unauthorized')

  if (chat === null) return () => botApiError(env, 400, 'Bad Request: chat not found')

  return () =>
    json(200, {
      ok: !env.drills.getChatOkFalse,
      result: {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        permissions: { can_send_messages: chat.permissions.can_send_messages },
        accent_color_id: chat.accent_color_id,
        max_reaction_count: chat.max_reaction_count
      }
    })
}

const getFile: RouteHandler = (state, request, env) => {
  const refused = noBody(request) ?? knownBotOnly(request)

  if (refused !== undefined) return refused

  const fileId = request.query.get('file_id')
  const file = state.files.find(item => item.file_id === fileId)

  if (file === undefined) {
    return notEmulated('getFile of a file id the bot did not receive is not emulated')
  }

  return () =>
    json(200, {
      ok: true,
      result: {
        file_id: file.file_id,
        file_unique_id: file.file_unique_id,
        file_size: file.file_size + (env.drills.fileSizeOffByOne ? 1 : 0),
        file_path: file.file_path
      }
    })
}

const downloadFile: RouteHandler = (state, request) => {
  const refused = noBody(request) ?? knownBotOnly(request)

  if (refused !== undefined) return refused

  const file = state.files.find(item => item.file_path === request.filePath)

  if (file === undefined) return notEmulated('a file path getFile did not answer is not emulated')

  return () =>
    new Response(new TextEncoder().encode(file.content), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })
}

const sendMessage: RouteHandler = (state, request, env) => {
  const refused = knownBotOnly(request)

  if (refused !== undefined) return refused

  const body = bodyObject(request, ['chat_id', 'text', 'disable_web_page_preview'])

  if (isNotEmulated(body)) return body

  const chat = chatOf(state, body.chat_id)

  if (isNotEmulated(chat)) return chat

  if (chat === null) {
    return notEmulated('sendMessage to a chat the bot is not a member of is not emulated')
  }

  const { text, disable_web_page_preview: disablePreview } = body

  if (!Predicate.isString(text) || text === '') {
    return notEmulated('text must be a non-empty string')
  }

  if (disablePreview !== true) {
    return notEmulated('disable_web_page_preview other than true (as recorded) is not emulated')
  }

  return () => {
    // Read the clock before anything is written: a failing clock sends nothing.
    const now = env.now()

    if (!Number.isFinite(now)) throw new Error('the emulator clock is not a finite instant')

    const date = Math.floor(now / 1000)
    const messageId = state.counters.nextMessageId

    state.counters = { ...state.counters, nextMessageId: messageId + 1 }
    state.sentMessages = [
      ...state.sentMessages,
      { message_id: messageId, chat_id: chat.id, text, date, disable_web_page_preview: true }
    ]

    return json(200, {
      ok: !env.drills.sendOkFalse,
      result: {
        message_id: messageId,
        from: {
          id: state.bot.id,
          is_bot: true,
          first_name: state.bot.first_name,
          username: state.bot.username
        },
        chat: { id: chat.id, title: chat.title, type: chat.type },
        date,
        text
      }
    })
  }
}

/** The route's request, as the handlers see it (the wrapper checked and parsed the body). */
const routeRequest = (request: EmulatedRequest): RouteRequest => ({
  query: request.query,
  filePath: request.params.filePath,
  body: request.json,
  // A non-empty body is valid JSON by now (`json-or-empty`), so it always parses.
  hasBody: request.json !== undefined,
  contentType: request.header('content-type') ?? null,
  knownBot: request.params[botParam] === 'known'
})

const route = (
  method: string,
  path: string,
  guardedPath: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = []
): TelegramApiRoute => ({
  route: statefulRoute(
    { method, path, kind: 'connector', write, caseIds, evidence: 'unverified' },
    'json-or-empty',
    routeRequest,
    (state, request, context) => handler(state, request, context.env)
  ),
  queryKeys,
  guardedPath
})

/** The route table: evidence plus handler. `telegramEmulatorRoutes` is its evidence part. */
export const telegramApiRoutes: ReadonlyArray<TelegramApiRoute> = [
  route('POST', '/bot{token}/getChat', '/getChat', false, [validateCase, errorCase], getChat),
  route('GET', '/bot{token}/getFile', '/getFile', false, [fileCase], getFile, ['file_id']),
  route('GET', '/file/bot{token}/{filePath}', '/file', false, [fileCase], downloadFile),
  route('POST', '/bot{token}/sendMessage', '/sendMessage', true, [sendCase], sendMessage)
]

/**
 * A Bot API token as the connector sends it: `<bot id>:<secret>`, with a secret of at least 8
 * characters, so the secret part of every accepted token is long enough to be guarded on its own.
 * Matched on the RAW path segment: a percent-encoded character makes the request unrecognised.
 */
const tokenSource = '[0-9]+:[A-Za-z0-9_-]{8,}'

/** `/bot<token>/<method>`, exactly: one of the emulated Bot API methods, no other path text. */
const botPathPattern = new RegExp(`^/bot(${tokenSource})/(getChat|getFile|sendMessage)$`)

/**
 * `/file/bot<token>/<file_path>`, exactly: a relative file path of letters, digits, and `_ . -`
 * segments (no percent-encoding, no empty or dot segments), the shape the download helper sends.
 */
const filePathPattern = new RegExp(
  `^/file/bot(${tokenSource})/((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+)$`
)

const isPlainFilePath = (path: string): boolean =>
  path.split('/').every(part => part !== '.' && part !== '..')

/** The constant reason of every unrecognised request (no method, path, or query is quoted). */
const unrecognisedReason = 'no emulated Bot API route for this method and path'

/**
 * Resolve one Bot API request, failing closed. Only a request whose raw path is exactly an
 * emulated route shape (`/bot<token>/<method>` or `/file/bot<token>/<file_path>`, the strict token
 * on the raw segment, an emulated method, and no other path text) under that route's HTTP method
 * is recognised; the token is extracted from that exact segment, never searched for elsewhere.
 * Every other request is `unrecognised`: the wrapper ledgers and answers it with constant text
 * only, so nothing it carries can leak.
 */
export const resolveTelegramRequest = (
  request: Request,
  url: URL
): StatefulResolution<TelegramEmulatorState, TelegramApiEnv> => {
  const method = request.method.toUpperCase()
  const fileMatch = filePathPattern.exec(url.pathname)
  const botMatch = fileMatch === null ? botPathPattern.exec(url.pathname) : null
  const token = fileMatch?.[1] ?? botMatch?.[1]

  const template =
    fileMatch !== null
      ? '/file/bot{token}/{filePath}'
      : botMatch === null
        ? undefined
        : `/bot{token}/${botMatch[2] ?? ''}`

  const matched = telegramApiRoutes.find(
    candidate => candidate.route.method === method && candidate.route.path === template
  )

  const filePath = fileMatch?.[2]

  if (
    matched === undefined ||
    token === undefined ||
    (filePath !== undefined && !isPlainFilePath(filePath))
  ) {
    return { kind: 'unrecognised', reason: unrecognisedReason }
  }

  // The guarded values: the token and its secret part (plain text: the segment is unencoded).
  const secrets = [token, token.slice(token.indexOf(':') + 1)]

  const ledgerPath =
    filePath === undefined
      ? `/bot<redacted>/${botMatch?.[2] ?? ''}`
      : `/file/bot<redacted>/${filePath}`

  const refuse = (reason: string): StatefulResolution<TelegramEmulatorState, TelegramApiEnv> => ({
    kind: 'refused',
    ledgerPath,
    reason,
    route: matched.route,
    secrets
  })

  const keys = [...url.searchParams.keys()]

  // Constant text: a query key may carry anything, the token included.
  if (keys.some(key => !matched.queryKeys.includes(key))) {
    return refuse('a query parameter this method does not take is not emulated')
  }

  const missing = matched.queryKeys.find(key => !keys.includes(key))

  if (missing !== undefined) {
    return refuse(`requests without the query parameter ${missing} are not emulated`)
  }

  if (keys.length !== matched.queryKeys.length) {
    return refuse('repeated query parameters are not emulated')
  }

  // Routes see whether the token names a bot and the file path, never the token.
  const bot = /^0+:/.test(token) ? 'none' : 'known'

  return {
    kind: 'route',
    ledgerPath,
    route: matched.route,
    params: filePath === undefined ? { [botParam]: bot } : { [botParam]: bot, filePath },
    guardedPath:
      filePath === undefined
        ? `${matched.guardedPath}${url.search}`
        : `${matched.guardedPath}/${encodeURIComponent(filePath)}`,
    secrets
  }
}
