/**
 * Plain-JSON email backends and the bridge that turns one into the `EmailClient` port.
 *
 * An `EmailBackend` answers one port call at a time: a method name and the request as plain JSON
 * without credential fields, answered with a `response` value, a `failure`, or a fail-closed
 * `notEmulated`. The bridge (`emailClientFromBackend` / `emailClientLayerFromBackend`) lets the email
 * conformance cases run the real connector actions against replayed `PortFixture`s
 * (`makeEmailReplayBackend`) or against any structural backend, such as the fixture-driven fake in
 * `@yolk-sdk/emulators/email` (the connectors package never depends on the emulators package).
 *
 * For conformance and tests only: it speaks no IMAP, POP3, or SMTP and is never a production host
 * adapter. Hosts implement `EmailClient` themselves.
 *
 * @experimental
 */
import { Effect, Equal, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  redactPortPayload,
  type PortFailure,
  type PortFixture
} from '@yolk-sdk/conformance/fixture'
import { ConnectorError, ConnectorErrorCause } from '../../error.ts'
import { ActionResult } from '../../result.ts'
import {
  EmailBatchMoveOutput,
  EmailBatchOperationOutput,
  EmailClient,
  EmailCreateDraftOutput,
  EmailGetAttachmentOutput,
  EmailGetMessageOutput,
  EmailListMessagesOutput,
  EmailModifyLabelsOutput,
  EmailMoveMessageOutput,
  EmailSendMessageOutput,
  EmailSetFlagOutput,
  EmailSetReadOutput,
  emailConnectorId,
  type EmailClientApi
} from '../index.ts'

/** The port name every email `PortFixture` carries. */
export const emailPortName = 'EmailClient'

/**
 * Every `EmailClient` method the bridge forwards: all of them except `getAttachmentBytes`, which
 * carries raw bytes rather than JSON and stays unbridged (the connector then reports
 * `not_downloadable`).
 */
export const emailBackendMethods = [
  'listMessages',
  'listMessagesFiltered',
  'getMessage',
  'getAttachment',
  'setRead',
  'setFlag',
  'trash',
  'untrash',
  'move',
  'modifyLabels',
  'batchSetRead',
  'batchSetFlag',
  'batchMove',
  'batchTrash',
  'batchUntrash',
  'batchModifyLabels',
  'deletePermanently',
  'createDraft',
  'sendMessage'
] as const

export type EmailBackendMethod = (typeof emailBackendMethods)[number]

/**
 * One backend answer: a `response` value, a `failure` (`expected` becomes an
 * `ActionResult.failure`, `error` a `ConnectorError`), or `notEmulated` (the backend refuses the
 * request, the port analogue of HTTP 400; the bridge fails with a `transport_failed`
 * `ConnectorError` naming only the method and the reason).
 */
export type EmailBackendReply =
  | { readonly response: Schema.Json }
  | { readonly failure: PortFailure }
  | { readonly notEmulated: { readonly reason: string } }

/**
 * A structural, plain-JSON email backend. `request` never carries credential fields: the bridge
 * removes them (`redactPortPayload`) before calling. A throw is reported as a `transport_failed`
 * `ConnectorError`.
 */
export type EmailBackend = {
  readonly call: (method: string, request: Schema.Json) => EmailBackendReply
}

/** A request value as plain JSON: class instances become plain objects, `undefined` keys drop. */
const toPortJson = (value: unknown): Schema.Json | undefined => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return value
  }

  if (Predicate.isNumber(value)) {
    return Number.isFinite(value) ? value : undefined
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const json = toPortJson(item)

      return json === undefined ? [] : [json]
    })
  }

  if (Predicate.isObject(value)) {
    const json: Record<string, Schema.Json> = {}

    for (const [key, item] of Object.entries(value)) {
      const entry = toPortJson(item)

      if (entry !== undefined) {
        json[key] = entry
      }
    }

    return json
  }

  return undefined
}

/** The credential-free JSON form of a port request, as a backend and a fixture see it. */
export const emailPortRequestJson = (request: unknown): Schema.Json =>
  redactPortPayload(toPortJson(request) ?? null)

const isConnectorErrorCause = Schema.is(ConnectorErrorCause)

const bridgeError = (message: string) =>
  new ConnectorError({ cause: 'transport_failed', message, connectorId: emailConnectorId })

const fromReply = <A>(
  method: EmailBackendMethod,
  reply: EmailBackendReply,
  output: Schema.Decoder<A>
): Effect.Effect<ActionResult<A>, ConnectorError> => {
  if ('notEmulated' in reply) {
    return Effect.fail(
      bridgeError(`EmailClient.${method} is not emulated: ${reply.notEmulated.reason}`)
    )
  }

  if ('failure' in reply) {
    const { kind, code, message, status } = reply.failure

    if (kind === 'error') {
      return Effect.fail(
        new ConnectorError({
          cause: isConnectorErrorCause(code) ? code : 'transport_failed',
          message,
          connectorId: emailConnectorId
        })
      )
    }

    return Effect.succeed(
      ActionResult.failure(status === undefined ? { code, message } : { code, message, status })
    )
  }

  return Schema.decodeUnknownEffect(output)(reply.response).pipe(
    Effect.mapBoth({
      onFailure: () =>
        new ConnectorError({
          cause: 'validation_failed',
          message: `Email backend returned invalid ${method} output`,
          connectorId: emailConnectorId
        }),
      onSuccess: value => ActionResult.success(value)
    })
  )
}

const bridged =
  <A>(backend: EmailBackend, method: EmailBackendMethod, output: Schema.Decoder<A>) =>
  (request: unknown): Effect.Effect<ActionResult<A>, ConnectorError> =>
    Effect.try({
      try: () => backend.call(method, emailPortRequestJson(request)),
      catch: () => bridgeError(`Email backend failed while answering EmailClient.${method}`)
    }).pipe(Effect.flatMap(reply => fromReply(method, reply, output)))

/**
 * An `EmailClient` over a plain-JSON backend. Each call sends the credential-free JSON request,
 * then maps the reply: a `response` is schema-decoded with the method's output schema (invalid
 * output fails `validation_failed`), a `failure` becomes an `ActionResult.failure` (`expected`) or a
 * `ConnectorError` (`error`; an unknown cause becomes `transport_failed`), and `notEmulated`
 * fails `transport_failed`. `getAttachmentBytes` is not bridged. Conformance and tests only.
 */
export const emailClientFromBackend = (backend: EmailBackend): EmailClientApi => ({
  listMessages: bridged(backend, 'listMessages', EmailListMessagesOutput),
  listMessagesFiltered: bridged(backend, 'listMessagesFiltered', EmailListMessagesOutput),
  getMessage: bridged(backend, 'getMessage', EmailGetMessageOutput),
  getAttachment: bridged(backend, 'getAttachment', EmailGetAttachmentOutput),
  setRead: bridged(backend, 'setRead', EmailSetReadOutput),
  setFlag: bridged(backend, 'setFlag', EmailSetFlagOutput),
  trash: bridged(backend, 'trash', EmailMoveMessageOutput),
  untrash: bridged(backend, 'untrash', EmailMoveMessageOutput),
  move: bridged(backend, 'move', EmailMoveMessageOutput),
  modifyLabels: bridged(backend, 'modifyLabels', EmailModifyLabelsOutput),
  batchSetRead: bridged(backend, 'batchSetRead', EmailBatchOperationOutput),
  batchSetFlag: bridged(backend, 'batchSetFlag', EmailBatchOperationOutput),
  batchMove: bridged(backend, 'batchMove', EmailBatchMoveOutput),
  batchTrash: bridged(backend, 'batchTrash', EmailBatchMoveOutput),
  batchUntrash: bridged(backend, 'batchUntrash', EmailBatchMoveOutput),
  batchModifyLabels: bridged(backend, 'batchModifyLabels', EmailBatchOperationOutput),
  deletePermanently: bridged(backend, 'deletePermanently', EmailBatchOperationOutput),
  createDraft: bridged(backend, 'createDraft', EmailCreateDraftOutput),
  sendMessage: bridged(backend, 'sendMessage', EmailSendMessageOutput)
})

/**
 * `EmailClient` layer over a backend. The backend value is captured, so every build shares it
 * (build a fresh backend per case, for example inside `Layer.suspend`, when cases must not share
 * state).
 */
export const emailClientLayerFromBackend = (backend: EmailBackend): Layer.Layer<EmailClient> =>
  Layer.succeed(EmailClient, EmailClient.of(emailClientFromBackend(backend)))

/** One call a replay backend answered or refused. */
export type EmailReplayLedgerEntry = {
  readonly seq: number
  readonly method: string
  /** The credential-free request as received. */
  readonly request: Schema.Json
  readonly outcome: 'matched' | 'unmatched'
  /** The fixture that answered a matched call. */
  readonly fixtureId?: string
}

export type EmailReplay = {
  readonly backend: EmailBackend
  readonly ledger: {
    readonly entries: () => ReadonlyArray<EmailReplayLedgerEntry>
    /** Fixture ids not consumed yet, in fixture order. */
    readonly remaining: () => ReadonlyArray<string>
  }
}

const replyOf = (fixture: PortFixture): EmailBackendReply =>
  fixture.failure === undefined ? { response: fixture.response } : { failure: fixture.failure }

const requestMatches = (fixture: PortFixture, method: string, request: Schema.Json): boolean =>
  fixture.port === emailPortName &&
  fixture.method === method &&
  Equal.equals(redactPortPayload(fixture.request), request)

/**
 * A fail-closed replay backend over email `PortFixture`s. A call matches the first unconsumed
 * fixture with the same port, method, and an equal credential-free request (structural JSON
 * equality). Each fixture answers at most once, and a call takes the first unused matching fixture,
 * so fixtures with identical requests answer in fixture order while different requests may come in
 * any order. A call without an unconsumed match is refused with `notEmulated` and still written to
 * the ledger. State lives in the returned value: create one replay per case.
 */
export const makeEmailReplayBackend = (fixtures: ReadonlyArray<PortFixture>): EmailReplay => {
  const consumed = new Set<number>()
  const entries: Array<EmailReplayLedgerEntry> = []

  const call = (method: string, rawRequest: Schema.Json): EmailBackendReply => {
    const request = redactPortPayload(rawRequest)
    const seq = entries.length + 1

    const index = fixtures.findIndex(
      (fixture, position) => !consumed.has(position) && requestMatches(fixture, method, request)
    )

    const fixture = fixtures[index]

    if (fixture === undefined) {
      entries.push({ seq, method, request, outcome: 'unmatched' })

      return { notEmulated: { reason: 'no unconsumed fixture matches this request' } }
    }

    consumed.add(index)
    entries.push({ seq, method, request, outcome: 'matched', fixtureId: fixture.id })

    return replyOf(fixture)
  }

  return {
    backend: { call },
    ledger: {
      entries: () => entries.map(entry => ({ ...entry })),
      remaining: () =>
        fixtures.flatMap((fixture, position) => (consumed.has(position) ? [] : [fixture.id]))
    }
  }
}
