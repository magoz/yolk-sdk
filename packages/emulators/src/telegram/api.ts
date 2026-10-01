/**
 * Telegram Bot API emulator API: the route table (evidence, query allowlist, core path, handler),
 * the token-aware route resolution, and the registration of the stateful handlers on the
 * `@emulators/core` app (internal; re-exported by `src/telegram.ts`).
 *
 * The bot token is part of every Bot API URL (`/bot<token>/<method>`, `/file/bot<token>/<path>`).
 * It is required, but it never reaches the core, the state, the ledger, a not-emulated message, or
 * a response. Resolution fails closed: only a request whose raw path is exactly an emulated route
 * shape is recognised, and its token is taken from that exact segment; every other request is
 * ledgered and answered with constant text only. For a recognised request the ledgered path reads
 * `/bot<redacted>/...`, the core learns only whether the token names a bot, and the wrapper
 * scrubs the token and its secret part from the ledger and refuses a path, query, or body that
 * repeats them (raw, percent-decoded, or in any parsed JSON key, string value, or number).
 *
 * Only the routes the four Telegram conformance cases need are emulated, with wire shapes copied
 * from the synthetic fixtures; everything else answers the wrapper's ledgered 400 not-emulated.
 *
 * @experimental
 */
import type { Hono } from '@emulators/core'
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { handlerFailedResponse } from '../emulator-http.ts'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import {
  commit,
  coreResponse,
  isRefusal,
  notEmulatedCoreResponse,
  parseJsonText,
  refuse,
  type CoreOutcome,
  type CoreRefusal,
  type StatefulFixtureResolution
} from '../stateful-fixture.ts'
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

/** Internal core header: whether the request's token names a bot (`known`) or not (`none`). */
export const telegramBotHeader = 'x-emulator-telegram-bot'

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

/** A route handler: validate without writing (a refusal), then `commit` the writes. */
type RouteHandler = (
  state: TelegramEmulatorState,
  request: RouteRequest,
  env: TelegramApiEnv
) => CoreOutcome

type TelegramApiRoute = EmulatorRouteEvidence & {
  readonly queryKeys: ReadonlyArray<string>
  /** Path of the core route (never a token). */
  readonly corePath: string
  readonly handler: RouteHandler
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
): Schema.JsonObject | CoreRefusal => {
  if (mediaType(request.contentType) !== 'application/json') {
    return refuse('Bot API bodies other than application/json are not emulated')
  }

  if (!isJsonObject(request.body)) {
    return refuse('a request body that is not a JSON object is not emulated')
  }

  const sent = Object.keys(request.body)

  if (sent.some(key => !keys.includes(key))) {
    return refuse('a body field this method does not take is not emulated')
  }

  return keys.every(key => sent.includes(key))
    ? request.body
    : refuse(
        `requests without each of the recorded body fields (${keys.join(', ')}) are not emulated`
      )
}

const noBody = (request: RouteRequest): CoreRefusal | undefined =>
  request.hasBody ? refuse('a request body is not emulated on this method') : undefined

/** The chat a well-formed `chat_id` names, `null` for none, or a refusal. */
const chatOf = (
  state: TelegramEmulatorState,
  chatId: Schema.Json | undefined
): TelegramEmulatorChat | null | CoreRefusal => {
  if (!Predicate.isString(chatId) || !chatIdPattern.test(chatId)) {
    return refuse('chat_id must be a chat id string (an integer or a public @username)')
  }

  return state.chats.find(chat => String(chat.id) === chatId) ?? null
}

/** The Bot API error envelope of the error fixture. */
const botApiError = (env: TelegramApiEnv, status: number, description: string): Response =>
  json(env.drills.errorsAs200 ? 200 : status, { ok: false, error_code: status, description })

const knownBotOnly = (request: RouteRequest): CoreRefusal | undefined =>
  request.knownBot
    ? undefined
    : refuse('a bot token that names no bot is emulated only on getChat (as recorded)')

// Handlers: validate (refuse) first, then `commit` the writes.

const getChat: RouteHandler = (state, request, env) => {
  const body = bodyObject(request, ['chat_id'])

  if (isRefusal(body)) return body

  const chat = chatOf(state, body.chat_id)

  if (isRefusal(chat)) return chat

  if (!request.knownBot) return commit(() => botApiError(env, 401, 'Unauthorized'))

  if (chat === null) return commit(() => botApiError(env, 400, 'Bad Request: chat not found'))

  return commit(() =>
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
  )
}

const getFile: RouteHandler = (state, request, env) => {
  const refused = noBody(request) ?? knownBotOnly(request)

  if (refused !== undefined) return refused

  const fileId = request.query.get('file_id')
  const file = state.files.find(item => item.file_id === fileId)

  if (file === undefined) {
    return refuse('getFile of a file id the bot did not receive is not emulated')
  }

  return commit(() =>
    json(200, {
      ok: true,
      result: {
        file_id: file.file_id,
        file_unique_id: file.file_unique_id,
        file_size: file.file_size + (env.drills.fileSizeOffByOne ? 1 : 0),
        file_path: file.file_path
      }
    })
  )
}

const downloadFile: RouteHandler = (state, request) => {
  const refused = noBody(request) ?? knownBotOnly(request)

  if (refused !== undefined) return refused

  const file = state.files.find(item => item.file_path === request.filePath)

  if (file === undefined) return refuse('a file path getFile did not answer is not emulated')

  return commit(
    () =>
      new Response(new TextEncoder().encode(file.content), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
  )
}

const sendMessage: RouteHandler = (state, request, env) => {
  const refused = knownBotOnly(request)

  if (refused !== undefined) return refused

  const body = bodyObject(request, ['chat_id', 'text', 'disable_web_page_preview'])

  if (isRefusal(body)) return body

  const chat = chatOf(state, body.chat_id)

  if (isRefusal(chat)) return chat

  if (chat === null) {
    return refuse('sendMessage to a chat the bot is not a member of is not emulated')
  }

  const { text, disable_web_page_preview: disablePreview } = body

  if (!Predicate.isString(text) || text === '') return refuse('text must be a non-empty string')

  if (disablePreview !== true) {
    return refuse('disable_web_page_preview other than true (as recorded) is not emulated')
  }

  return commit(() => {
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
  })
}

const route = (
  method: string,
  path: string,
  corePath: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = []
): TelegramApiRoute => ({
  method,
  path,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  queryKeys,
  corePath,
  handler
})

/** The route table: evidence plus handler. `telegramEmulatorRoutes` is its evidence part. */
export const telegramApiRoutes: ReadonlyArray<TelegramApiRoute> = [
  route('POST', '/bot{token}/getChat', '/getChat', false, [validateCase, errorCase], getChat),
  route('GET', '/bot{token}/getFile', '/getFile', false, [fileCase], getFile, ['file_id']),
  route('GET', '/file/bot{token}/{filePath}', '/file/:filePath', false, [fileCase], downloadFile),
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
export const resolveTelegramRequest = (request: Request, url: URL): StatefulFixtureResolution => {
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
    candidate => candidate.method === method && candidate.path === template
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

  const refuse = (reason: string): StatefulFixtureResolution => ({
    kind: 'not-emulated',
    ledgerPath,
    reason,
    route: matched,
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

  return {
    kind: 'route',
    ledgerPath,
    route: matched,
    corePath:
      filePath === undefined
        ? `${matched.corePath}${url.search}`
        : `/file/${encodeURIComponent(filePath)}`,
    coreHeaders: { [telegramBotHeader]: /^0+:/.test(token) ? 'none' : 'known' },
    secrets
  }
}

const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

const handle = async (
  raw: Request,
  state: TelegramEmulatorState,
  env: TelegramApiEnv
): Promise<Response> => {
  const url = new URL(raw.url)

  const filePath = url.pathname.startsWith('/file/')
    ? decodeSegment(url.pathname.slice('/file/'.length))
    : undefined

  const matched = telegramApiRoutes.find(
    candidate =>
      candidate.method === raw.method.toUpperCase() &&
      (candidate.corePath === url.pathname ||
        (candidate.corePath === '/file/:filePath' && filePath !== undefined))
  )

  if (matched === undefined) return notEmulatedCoreResponse('no emulated Bot API route')

  const text = await raw.text()

  const outcome = matched.handler(
    state,
    {
      query: url.searchParams,
      filePath,
      body: text === '' ? undefined : parseJsonText(text),
      hasBody: text !== '',
      contentType: raw.headers.get('content-type'),
      knownBot: raw.headers.get(telegramBotHeader) === 'known'
    },
    env
  )

  return coreResponse(outcome, raw)
}

/**
 * Register every route of the table on the core app under its token-free core path, over the
 * generation's state. A handler that throws answers `handlerFailedResponse()`, which the wrapper
 * turns into its 500 with `responseError` in the ledger.
 */
export const registerTelegramApi = (
  app: Hono,
  state: TelegramEmulatorState,
  env: TelegramApiEnv
): void => {
  for (const apiRoute of telegramApiRoutes) {
    app.on(apiRoute.method, apiRoute.corePath, async context => {
      try {
        return await handle(context.req.raw, state, env)
      } catch {
        return handlerFailedResponse()
      }
    })
  }
}
