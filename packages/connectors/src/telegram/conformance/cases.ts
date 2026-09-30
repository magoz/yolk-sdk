/**
 * Telegram conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Telegram connector relies on, running the REAL connector
 * actions (and the host-only `downloadTelegramFile` helper) over the connector ports
 * (`ConnectorHttpClient`, `ConnectorBinaryHttpClient`, `CredentialResolver`) plus the host-supplied
 * `TelegramConformanceConfig` seeds. The Telegram actions (`telegram.validate`,
 * `telegram.send_message`) read only the HTTP status of Bot API answers, never the `{ ok }`
 * body, so claims about that body are observed at the port the host provides (the cases send no
 * request of their own); the host-only `downloadTelegramFile` does decode the `getFile` result. The
 * same cases run on replay fixtures, an emulator, or by hand against a practice bot. None is
 * observed live yet (`observed` absent = unverified); sub-claims no live run has settled are marked
 * "(unverified: ...)" in their `wire`.
 *
 * The bot token is part of every Bot API URL (`/bot<token>/<method>`), so hosts must never log
 * those URLs; failures here never carry a URL.
 *
 * Irreversible write. `telegram.send_message` posts a real message that the connector cannot
 * delete (it has no delete action), so the send case is `write-irreversible`: a runner starts it
 * only when a person names its exact id. Its text names the `runId` seed, a per-invocation
 * `run-<hex>` value, so the message can be told apart. The send, the decoding of its observed
 * answer, and its classification run uninterruptibly together. A definitive rejection (HTTP 4xx
 * other than 408, including 429) sent nothing. An ambiguous outcome (a transport or decoding
 * failure, no status, HTTP 408 or 5xx, or a 2xx whose body is not `{ ok: true }`) may have
 * delivered the message anyway: the case fails with `TelegramConformanceActionFailed`
 * (`sendOutcome: 'unknown'`) naming the text to look for in the seeded chat, and hands that message
 * to the `ConformanceCleanupReporter` when the case is being interrupted. There is nothing to clean
 * up, and no leftover lookup: the Bot API cannot list the messages a bot sent.
 */
import { Context, Data, Effect, Exit, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { ConnectorBinaryHttpClient, type ConnectorBinaryHttpResponse } from '../../binary-http.ts'
import { classifyWriteExit, failReporting } from '../../conformance/cleanup-reporter.ts'
import { ApiKeyCredential, CredentialResolver, makeCredentialBinding } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type {
  ConnectorFileTransferBudget,
  ConnectorFileTransferError
} from '../../file-transfer.ts'
import {
  ConnectorHttpClient,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse
} from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import { downloadTelegramFile } from '../download.ts'
import {
  TelegramSendMessageInput,
  type TelegramSendMessageOutput,
  telegramSendMessageAction,
  telegramValidateAction
} from '../index.ts'
import { telegramBotTokenSlotId, telegramConnectorId } from '../shared.ts'
import { telegramErrorEnvelopeFixture } from './error-envelope.ts'
import { telegramGetFilePathFixture } from './get-file-path.ts'
import { telegramSendMessageFixture } from './send-message.ts'
import { telegramValidateGetChatFixture } from './validate-get-chat.ts'

/** A chat id: an integer (negative for groups and channels) or a public `@username`. */
const ChatId = Schema.String.check(
  Schema.isPattern(/^(?:-?[1-9][0-9]{0,19}|@[A-Za-z][A-Za-z0-9_]{3,31})$/)
)

/** A Bot API file id, in the characters `downloadTelegramFile` accepts. */
const FileId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seeds for the practice bot. Cases never hard-code account data. A case whose
 * required seed is missing fails with a `precondition:` `ConformanceMismatch` before any request.
 */
export const TelegramConformanceSeeds = Schema.Struct({
  /**
   * A practice chat the bot is a member of (the integration config `chatId`). The send case posts
   * a real message there.
   */
  chatId: Schema.optionalKey(ChatId),
  /**
   * A small plain UTF-8 text file (at most 1 MB) the bot received, by its Bot API `file_id`. Its
   * `getFile` answer must report `file_size`; recording refuses any other kind of file.
   */
  fileId: Schema.optionalKey(FileId),
  /**
   * Invocation-unique segment of the send case's message text. Replay uses the fixed synthetic id
   * of the fixtures; the live runner generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type TelegramConformanceSeeds = typeof TelegramConformanceSeeds.Type

export type TelegramConformanceSeedKey = keyof TelegramConformanceSeeds

/** Host-supplied seeds for the Telegram conformance cases. */
export class TelegramConformanceConfig extends Context.Service<
  TelegramConformanceConfig,
  TelegramConformanceSeeds
>()('@yolk-sdk/connectors/telegram/conformance/TelegramConformanceConfig') {}

/**
 * Credential reference the cases bind to the `telegram.bot_token` slot. A host
 * `CredentialResolver` (for example `staticCredentialResolverLayer` from
 * `@yolk-sdk/connectors/conformance`) resolves it to the practice bot's token.
 */
export const telegramConformanceCredentialRef = 'telegram.conformance'

/**
 * Synthetic bot token the committed fixtures are recorded with (it appears in their URLs). Replay
 * resolves the credential to it; a recording replaces the live token with it before staging.
 */
export const telegramConformanceReplayBotToken = '123456789:yolk-synthetic-replay-token'

/**
 * The integration a Telegram conformance case invokes the connector with: the `chatId` config
 * (when given) and the `telegram.bot_token` binding.
 */
export const telegramConformanceIntegration = (chatId?: string) =>
  makeIntegration({
    connectorId: telegramConnectorId,
    config: chatId === undefined ? {} : { chatId },
    credentialBindings: [
      makeCredentialBinding({
        slotId: telegramBotTokenSlotId,
        credentialRef: telegramConformanceCredentialRef
      })
    ]
  })

/** Synthetic marker every case-sent message text starts with. */
export const telegramConformanceMarker = 'yolk-conformance'

/**
 * A connector action or helper failed where the case needed success. `code` and `status` keep the
 * underlying classification (a `ConnectorError` cause such as `transport_failed`, a provider
 * failure code, or a `ConnectorFileTransferError` code).
 *
 * `sendOutcome: 'unknown'` marks an ambiguous send (a transport or decoding failure, no status,
 * HTTP 408 or 5xx, or a 2xx whose observed body is not `{ ok: true }`: codes `undecodable_answer`
 * and `unobserved_answer`): the message may have been delivered anyway, so the message names the
 * text to look for in the seeded chat. A sent message cannot be deleted through the connector.
 */
export class TelegramConformanceActionFailed extends Data.TaggedError(
  'TelegramConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly sendOutcome?: 'unknown'
  readonly text?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.sendOutcome === 'unknown'
        ? `; send outcome unknown: the message may have been delivered; look for "${this.text ?? telegramConformanceMarker}" in the seeded chat by hand (the connector cannot delete it)`
        : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

export type TelegramConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | TelegramConformanceActionFailed

/** What every Telegram conformance case requires from the host. */
export type TelegramConformanceRequirements =
  | ConnectorHttpClient
  | ConnectorBinaryHttpClient
  | CredentialResolver
  | TelegramConformanceConfig

export type TelegramConformanceCase = ConformanceCase<
  TelegramConformanceError,
  TelegramConformanceRequirements
>

const requireSeed = <K extends TelegramConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* TelegramConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: TelegramConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, TelegramConformanceActionFailed> => {
    if (Predicate.isTagged(result, 'Success')) {
      return Effect.succeed(result.value)
    }

    const { code, status } = result.error

    return Effect.fail(
      status === undefined
        ? new TelegramConformanceActionFailed({ actionId, code })
        : new TelegramConformanceActionFailed({ actionId, code, status })
    )
  }

/** The provider failure of a result, or `undefined` for a success. */
const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** `code status` of a result for mismatch details (`success` for a success). */
const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined ? 'success' : `${failure.code} ${failure.status ?? 'no-status'}`
}

/** The Bot API method of a request URL (`getChat`), never the token-bearing path before it. */
const botMethodOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1).split('?', 1)[0]

// Bot API envelopes, reduced to the one field that says whether the call succeeded: `ok`. The
// connector reads none of them; the cases check only that `ok` agrees with the HTTP status.

const BotApiOk = Schema.Struct({ ok: Schema.Literal(true) })

const BotApiError = Schema.Struct({ ok: Schema.Literal(false) })

/** Decode a JSON text body with `schema`, or `undefined`. */
const decodeBody = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  body: unknown
): Effect.Effect<A | undefined> =>
  Predicate.isString(body)
    ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )
    : Effect.succeed(undefined)

type ObservedExchange = {
  readonly request: ConnectorHttpRequest
  readonly response: ConnectorHttpResponse
}

/**
 * Run `effect` with the host's `ConnectorHttpClient` wrapped so every exchange is observed; the
 * requests and responses are the host's own, unchanged.
 */
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const exchanges = yield* Ref.make<ReadonlyArray<ObservedExchange>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        http
          .request(request)
          .pipe(
            Effect.tap(response => Ref.update(exchanges, list => [...list, { request, response }]))
          )
    })

    const value = yield* effect.pipe(Effect.provideService(ConnectorHttpClient, observing))

    return { value, exchanges: yield* Ref.get(exchanges) }
  })

/** `METHOD botMethod` per observed exchange, for request-shape checks. */
const sentMethods = (exchanges: ReadonlyArray<ObservedExchange>) =>
  exchanges.map(({ request }) => [request.method, botMethodOf(request.url)])

const validate = (chatId: string) =>
  telegramValidateAction.executeTyped({
    integration: telegramConformanceIntegration(chatId),
    input: {}
  })

// Read cases.

export const telegramValidateGetChatCase: TelegramConformanceCase = defineConformanceCase({
  id: 'telegram.validate.get-chat',
  title: 'validate is one getChat call, answered 2xx with ok true for a chat the bot is in',
  safety: 'read',
  docs: '`telegram.validate` sends POST https://api.telegram.org/bot<token>/getChat with the JSON body `{ chat_id }` (integration config `chatId`; it does not call getMe) and reports `{ ok: true, chatId }` on any 2xx status, without reading the body.',
  wire: "`telegram.validate` for the seeded chat, which the bot is a member of, sends exactly one POST `getChat`, and Telegram answers it with a 2xx status and a body with `ok: true` (observed at the `ConnectorHttpClient` port), so the connector's status-only check agrees with the Bot API envelope; the connector reports `{ ok: true, chatId }` with the seeded id.",
  fixtures: [telegramValidateGetChatFixture.id],
  run: Effect.gen(function* () {
    const chatId = yield* requireSeed('chatId')
    const { value, exchanges } = yield* observed(validate(chatId))
    const output = yield* successValue(telegramValidateAction.id)(value)

    yield* expectEqual(
      [output.ok, output.chatId],
      [true, chatId],
      'expected telegram.validate to report ok for the seeded chat'
    )
    yield* expectEqual(
      sentMethods(exchanges),
      [['POST', 'getChat']],
      'expected telegram.validate to send exactly one POST getChat'
    )

    const [exchange] = exchanges
    const body = yield* decodeBody(BotApiOk, exchange?.response.body)

    yield* expectConformance(
      body !== undefined,
      'expected the 2xx getChat answer to carry ok: true'
    )
  })
})

/** A chat id no practice bot is a member of (synthetic, never account data). */
const absentChatId = '-1009999999999'

/** A bot token Telegram cannot accept (synthetic; it names no bot). */
const invalidBotToken = '0:yolk-conformance-invalid-token'

const invalidTokenResolver = CredentialResolver.of({
  resolve: () => Effect.succeed(ApiKeyCredential.make({ key: invalidBotToken }))
})

export const telegramErrorEnvelopeCase: TelegramConformanceCase = defineConformanceCase({
  id: 'telegram.errors.error-envelope',
  title: 'Bot API errors answer a 4xx status, never 200, with ok false',
  safety: 'read',
  docs: "The connector treats any non-2xx Bot API answer as a failure (`telegram.validate`: `telegram_validate_failed`; `telegram.send_message`: 429 `telegram_rate_limited`, otherwise `telegram_send_failed`), keeps the HTTP status and the body as `underlying`, and never reads `ok`, `error_code`, `description`, or `parameters`. A 200 answer with `ok: false` would be reported as success, and the send case classifies a 4xx as 'nothing sent' but a 5xx as 'outcome unknown'.",
  wire: 'Two triggers, both through `telegram.validate`. (1) `getChat` for a chat id the bot is not a member of answers a 4xx status (unverified: 400 `chat not found`); (2) `getChat` with a bot token that names no bot answers a 4xx status (unverified: 401 or 404). Both are errors in the HTTP status itself, not a 200 whose body says `ok: false`, and both bodies carry `ok: false`; the connector reports `telegram_validate_failed` with that 4xx status (not a 5xx, which the send case would treat as an unknown outcome). The exact 4xx and the other body fields are not checked: the connector does not read them.',
  fixtures: [telegramErrorEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const chatId = yield* requireSeed('chatId')

    const triggers = [
      { label: 'a chat the bot is not a member of', attempt: validate(absentChatId) },
      {
        label: 'a bot token that names no bot',
        attempt: validate(chatId).pipe(
          Effect.provideService(CredentialResolver, invalidTokenResolver)
        )
      }
    ] as const

    for (const { label, attempt } of triggers) {
      const result = yield* attempt
      const failure = failureOf(result)

      if (failure === undefined) {
        return yield* new ConformanceMismatch({
          message: `expected telegram.validate to fail for ${label}`
        })
      }

      yield* expectConformance(
        failure.code === 'telegram_validate_failed' &&
          failure.status !== undefined &&
          failure.status >= 400 &&
          failure.status < 500,
        `expected ${label} to answer a 4xx status (telegram_validate_failed)`,
        { actual: outcomeOf(result) }
      )

      const envelope = yield* decodeBody(BotApiError, failure.underlying)

      yield* expectConformance(
        envelope !== undefined,
        `expected ${label} to answer a body with ok: false`
      )
    }
  })
})

/** Trusted conformance transfer limits: the seeded file must be at most 1 MB. */
const downloadBudget: ConnectorFileTransferBudget = {
  maxBytes: 1_048_576,
  maxMetadataBytes: 65_536,
  maxErrorBodyBytes: 65_536
}

const downloadActionId = 'telegram.conformance.download_file'

/** Map a transfer failure to a case failure (the helper returns code-only errors). */
const transferFailed = (error: ConnectorFileTransferError) =>
  error.status === undefined
    ? new TelegramConformanceActionFailed({ actionId: downloadActionId, code: error.code })
    : new TelegramConformanceActionFailed({
        actionId: downloadActionId,
        code: error.code,
        status: error.status
      })

const GetFileAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ file_id: Schema.String, file_size: Schema.optional(Schema.Number) })
})

export const telegramGetFilePathCase: TelegramConformanceCase = defineConformanceCase({
  id: 'telegram.files.get-file-path',
  title: 'getFile answers the same file_id and a relative file_path; the file matches file_size',
  safety: 'read',
  docs: 'The host-only `downloadTelegramFile` sends GET /bot<token>/getFile?file_id=<id> and requires `{ ok: true, result: { file_id, file_path, file_size? } }` with `file_id` equal to the requested id and a relative `file_path` (letters, digits, `_ . / -`, no empty or dot segments); it then GETs https://api.telegram.org/file/bot<token>/<file_path> without redirects and, when `file_size` is present, requires exactly that many bytes (hosted Bot API files are capped at 20 MB).',
  wire: 'For the seeded `fileId` (a small file the bot received), `getFile` answers `ok: true` with `result.file_id` equal to the seeded id (unverified: that Telegram echoes the `file_id` it was given rather than another valid id for the same file) and a `file_path` the helper accepts; the file URL then answers HTTP 200 with exactly `file_size` bytes, so `downloadTelegramFile` returns them with `source.fileId` equal to the seed. `file_size` is optional for the helper; the seed must name a file whose `getFile` answer reports one (a `precondition:`), so the byte-count check the helper relies on is exercised, and the size is compared only when present (observed at the `ConnectorBinaryHttpClient` port).',
  fixtures: [telegramGetFilePathFixture.id],
  run: Effect.gen(function* () {
    const fileId = yield* requireSeed('fileId')
    const binary = yield* ConnectorBinaryHttpClient
    const responses = yield* Ref.make<ReadonlyArray<ConnectorBinaryHttpResponse>>([])

    const observing = ConnectorBinaryHttpClient.of({
      request: request =>
        binary
          .request(request)
          .pipe(Effect.tap(response => Ref.update(responses, list => [...list, response])))
    })

    const file = yield* downloadTelegramFile(
      telegramConformanceIntegration(),
      { fileId },
      downloadBudget
    ).pipe(
      Effect.mapError(transferFailed),
      Effect.provideService(ConnectorBinaryHttpClient, observing)
    )

    const [metadata] = yield* Ref.get(responses)

    const answer =
      metadata === undefined
        ? undefined
        : yield* decodeBody(GetFileAnswer, new TextDecoder().decode(metadata.bytes))

    if (answer === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected getFile to answer { ok: true, result } with a file_id'
      })
    }

    yield* expectEqual(
      [answer.result.file_id, file.source.fileId],
      [fileId, fileId],
      'expected getFile to answer the requested file_id'
    )

    const size = answer.result.file_size

    if (size === undefined) {
      return yield* new ConformanceMismatch({
        message: 'precondition: fileId must name a file whose getFile answer reports file_size'
      })
    }

    yield* expectEqual(
      file.byteLength,
      size,
      'expected the file URL to answer exactly file_size bytes'
    )
  })
})

// Irreversible write case.

const sendCaseId = 'telegram.messages.send-message'

/** The send case's text: the marker and the run id, so each invocation's message is distinct. */
const sendText = (runId: string) =>
  `${telegramConformanceMarker} ${runId}: synthetic conformance message, safe to ignore`

/**
 * Classify a send from its exit and its observed answer. A transport or decoding failure, no
 * status, a 408 or 5xx, or a 2xx whose observed body is not `{ ok: true }` is ambiguous (the message may
 * have been delivered: `sendOutcome: 'unknown'`); a 4xx is a definitive rejection (nothing was
 * sent); `undefined` for a success with an `ok: true` body.
 */
const classifySend = (
  text: string,
  exit: Exit.Exit<ObservedSend, ConnectorError>
): Effect.Effect<TelegramConformanceActionFailed | undefined> =>
  Effect.gen(function* () {
    const actionId = telegramSendMessageAction.id
    const outcome = classifyWriteExit(Exit.map(exit, observedSend => observedSend.value))

    switch (outcome.kind) {
      case 'rejected':
        return new TelegramConformanceActionFailed({ actionId, ...outcome.failure })
      case 'ambiguous':
        return new TelegramConformanceActionFailed({
          actionId,
          ...outcome.failure,
          sendOutcome: 'unknown',
          text
        })
      case 'success':
        break
    }

    // A 2xx the connector reports as sent: unless the observed body says `ok: true`, the send may
    // or may not have happened.
    const answer = Exit.isSuccess(exit) ? exit.value.exchanges.at(-1)?.response : undefined
    const body = yield* decodeBody(BotApiOk, answer?.body)

    if (body !== undefined) {
      return undefined
    }

    return answer === undefined
      ? new TelegramConformanceActionFailed({
          actionId,
          code: 'unobserved_answer',
          sendOutcome: 'unknown',
          text
        })
      : new TelegramConformanceActionFailed({
          actionId,
          code: 'undecodable_answer',
          status: answer.status,
          sendOutcome: 'unknown',
          text
        })
  })

type ObservedSend = {
  readonly value: ActionResult<TelegramSendMessageOutput>
  readonly exchanges: ReadonlyArray<ObservedExchange>
}

export const telegramSendMessageCase: TelegramConformanceCase = defineConformanceCase({
  id: sendCaseId,
  title: 'sendMessage answers 2xx with ok true for a chat the bot may post in',
  safety: 'write-irreversible',
  docs: '`telegram.send_message` sends POST https://api.telegram.org/bot<token>/sendMessage with `{ chat_id, text, disable_web_page_preview }` (the preview is disabled unless the input says otherwise) and reports `{ sent: true, chatId }` on any 2xx status, without reading the body; 429 maps to `telegram_rate_limited`, any other non-2xx to `telegram_send_failed`. The connector has no delete action: a sent message cannot be undone through it.',
  wire: '`telegram.send_message` of a short synthetic text naming the run id to the seeded chat sends exactly one POST `sendMessage`, and Telegram answers a 2xx status with a body carrying `ok: true` (observed at the `ConnectorHttpClient` port and decoded inside the uninterruptible send, so a 2xx without it is reported as an unknown send outcome) while still accepting the deprecated `disable_web_page_preview` field (unverified: Bot API 7.0 replaced it with `link_preview_options`); the connector reports `{ sent: true, chatId }`. The message stays in the chat: this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: [telegramSendMessageFixture.id],
  run: Effect.gen(function* () {
    const chatId = yield* requireSeed('chatId')
    const runId = yield* requireSeed('runId')
    const text = sendText(runId)

    const sent = yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          observed(
            telegramSendMessageAction.executeTyped({
              integration: telegramConformanceIntegration(chatId),
              input: TelegramSendMessageInput.make({ message: text })
            })
          )
        )

        const error = yield* classifySend(text, exit)

        if (error !== undefined) {
          // An interruption may replace this failure, and with it the advice to check the chat.
          return yield* error.sendOutcome === 'unknown'
            ? failReporting(unmask, error)
            : Effect.fail(error)
        }

        return yield* exit
      })
    )

    const output = yield* successValue(telegramSendMessageAction.id)(sent.value)

    yield* expectEqual(
      [output.sent, output.chatId],
      [true, chatId],
      'expected telegram.send_message to report sent for the seeded chat'
    )
    yield* expectEqual(
      sentMethods(sent.exchanges),
      [['POST', 'sendMessage']],
      'expected telegram.send_message to send exactly one POST sendMessage'
    )
  })
})

/** Every Telegram conformance case, in fixture order. */
export const telegramConformanceCases: ReadonlyArray<TelegramConformanceCase> = [
  telegramValidateGetChatCase,
  telegramErrorEnvelopeCase,
  telegramGetFilePathCase,
  telegramSendMessageCase
]
