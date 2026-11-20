/**
 * Kie conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Kie connector relies on, running the REAL connector actions
 * (`kie.get_task`, `kie.create_image_task`, `kie.create_video_task`) over the connector ports
 * (`ConnectorHttpClient`, `CredentialResolver`) plus the host-supplied `KieConformanceConfig`
 * seeds. The actions return only their decoded output, so claims about the envelope (`code`, the
 * HTTP status) are observed at the `ConnectorHttpClient` port the host provides; the cases send no
 * request of their own. The same cases run on replay fixtures, an emulator, or by hand against a
 * practice Kie account. None is observed live yet (`observed` absent = unverified); sub-claims no
 * live run has settled are marked "(unverified: ...)" in their `wire`.
 *
 * Irreversible writes. Every created task spends Kie credits and the connector cannot cancel or
 * delete one, so both create cases are `write-irreversible`: a runner starts each only when a
 * person names its exact id. Their prompts name the `runId` seed, a per-invocation `run-<hex>`
 * value, so a created task can be told apart. The create, its classification, and the decoding of
 * its observed answer run uninterruptibly together. Kie answers most failures with HTTP 200 and a
 * non-200 envelope `code`, so the classification reads the envelope code too: a definitive
 * rejection (an HTTP 4xx, or at HTTP 2xx an envelope 4xx, other than 408 and Kie's 455 "service
 * unavailable") created nothing; anything else that is not a 2xx with envelope `code` 200 (a
 * transport or decoding failure, no status, a 408, 455, or 5xx) is ambiguous: the case fails with
 * `KieConformanceActionFailed` (`taskOutcome: 'unknown'`) naming the run id to look for in the Kie
 * task log, and hands it to the `ConformanceCleanupReporter` when the case is being interrupted.
 * There is nothing to clean up, and no leftover lookup: the connector reads no task listing.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { failReporting } from '../../conformance/cleanup-reporter.ts'
import { ApiKeyCredential, CredentialResolver, makeCredentialBinding } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import {
  ConnectorHttpClient,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse
} from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  KieCreateImageTaskInput,
  KieCreateVideoTaskInput,
  KieGetTaskInput,
  KieHttpUrl,
  type KieCreateTaskOutput,
  kieApiKeySlotId,
  kieConnectorId,
  kieCreateImageTaskAction,
  kieCreateVideoTaskAction,
  kieGetTaskAction,
  kieGptImage2TextToImageModel,
  kieWan27ImageToVideoModel
} from '../index.ts'
import { kieCreateImageTaskFixture } from './create-image-task.ts'
import { kieCreateVideoTaskFixture } from './create-video-task.ts'
import { kieGetFailedTaskFixture } from './get-failed-task.ts'
import { kieGetSuccessTaskFixture } from './get-success-task.ts'
import { kieTaskNotFoundFixture } from './task-not-found.ts'
import { kieUnauthorizedFixture } from './unauthorized.ts'

/** A Kie task id, in the characters the cases send (a query value). */
const TaskId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(40)
)

/** An absolute https URL Kie can fetch (no credentials, no whitespace), at most 2048 characters. */
const HttpsImageUrl = KieHttpUrl.check(Schema.isPattern(/^https:\/\//u), Schema.isMaxLength(2048))

/**
 * Host-supplied seeds for the practice account. Cases never hard-code account data. A case whose
 * required seed is missing fails with a `precondition:` `ConformanceMismatch` before any request.
 */
export const KieConformanceSeeds = Schema.Struct({
  /** A finished GPT Image 2 task of the practice account whose state is `success`. */
  successTaskId: Schema.optionalKey(TaskId),
  /** A finished task of the practice account whose state is `fail`. */
  failedTaskId: Schema.optionalKey(TaskId),
  /**
   * A public https image (a small still) Kie fetches as the video case's first frame. Kie, not the
   * host, fetches it, so it must be reachable from the internet.
   */
  firstFrameUrl: Schema.optionalKey(HttpsImageUrl),
  /**
   * Invocation-unique segment of the create cases' prompts. Replay uses the fixed synthetic id of
   * the fixtures; the live runner generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type KieConformanceSeeds = typeof KieConformanceSeeds.Type

export type KieConformanceSeedKey = keyof KieConformanceSeeds

/** Host-supplied seeds for the Kie conformance cases. */
export class KieConformanceConfig extends Context.Service<
  KieConformanceConfig,
  KieConformanceSeeds
>()('@yolk-sdk/connectors/kie/conformance/KieConformanceConfig') {}

/**
 * Credential reference the cases bind to the `kie.api_key` slot. A host `CredentialResolver` (for
 * example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves it to
 * the practice account's API key.
 */
export const kieConformanceCredentialRef = 'kie.conformance'

/** The integration a Kie conformance case invokes the connector with: the API key binding. */
export const kieConformanceIntegration = () =>
  makeIntegration({
    connectorId: kieConnectorId,
    config: {},
    credentialBindings: [
      makeCredentialBinding({ slotId: kieApiKeySlotId, credentialRef: kieConformanceCredentialRef })
    ]
  })

/** Synthetic marker every case-created task's prompt starts with. */
export const kieConformanceMarker = 'yolk-conformance'

/** A task id no account holds (synthetic; the not-found and unauthorized cases read it). */
export const kieConformanceAbsentTaskId = 'yolk_conformance_absent_task_0000'

/** An API key Kie cannot accept (synthetic, public, never valid anywhere). */
export const kieConformanceInvalidApiKey = 'yolk-conformance-invalid-kie-key'

/**
 * A connector action failed where the case needed success. `code` and `status` keep the underlying
 * classification (a `ConnectorError` cause such as `transport_failed`, or a provider failure code
 * such as `kie_insufficient_credits`); `kieCode` is the envelope `code` when one was read.
 *
 * `taskOutcome: 'unknown'` marks an ambiguous create (see the module header): a task may have been
 * created anyway, and may spend credits, so the message names the run id its prompt carries.
 */
export class KieConformanceActionFailed extends Data.TaggedError('KieConformanceActionFailed')<{
  readonly actionId: string
  readonly code: string
  readonly status?: number | undefined
  readonly kieCode?: number | undefined
  readonly taskOutcome?: 'unknown'
  readonly runId?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`
    const kieCode = this.kieCode === undefined ? '' : ` (Kie code ${this.kieCode})`

    const advice =
      this.taskOutcome === 'unknown'
        ? `; task outcome unknown: a task may exist and spend credits; look for a prompt naming ${this.runId ?? kieConformanceMarker} in the Kie task log (the connector cannot cancel it)`
        : ''

    return `${this.actionId} failed: ${this.code}${status}${kieCode}${advice}`
  }
}

export type KieConformanceError = ConformanceMismatch | ConnectorError | KieConformanceActionFailed

/** What every Kie conformance case requires from the host. */
export type KieConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | KieConformanceConfig

export type KieConformanceCase = ConformanceCase<KieConformanceError, KieConformanceRequirements>

const requireSeed = <K extends KieConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* KieConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: KieConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

/** The provider failure of a result, or `undefined` for a success. */
const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

const KieUnderlying = Schema.Struct({ kieCode: Schema.Number })

const decodeUnderlying = Schema.decodeUnknownOption(KieUnderlying)

/** The envelope `code` a provider failure carries (`underlying.kieCode`), or `undefined`. */
const kieCodeOf = (failure: ProviderFailure): number | undefined =>
  Option.getOrUndefined(Option.map(decodeUnderlying(failure.underlying), parsed => parsed.kieCode))

const actionFailed = (actionId: string, failure: ProviderFailure) =>
  new KieConformanceActionFailed({
    actionId,
    code: failure.code,
    status: failure.status,
    kieCode: kieCodeOf(failure)
  })

const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, KieConformanceActionFailed> =>
    Predicate.isTagged(result, 'Success')
      ? Effect.succeed(result.value)
      : Effect.fail(actionFailed(actionId, result.error))

/** `code status kieCode` of a result for mismatch details (`success` for a success). */
const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined
    ? 'success'
    : `${failure.code} ${failure.status ?? 'no-status'} ${kieCodeOf(failure) ?? 'no-kie-code'}`
}

// The Kie envelope, reduced to the one field the claims read: `code`.
const decodeEnvelopeCode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ code: Schema.Number }))
)

/** The envelope `code` of a JSON text body, or `undefined`. */
const envelopeCodeOf = (body: string | undefined): Effect.Effect<number | undefined> =>
  body === undefined
    ? Effect.succeed(undefined)
    : decodeEnvelopeCode(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success.code : undefined))
      )

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

/** `METHOD path?query` per observed exchange (never the origin), for request-shape checks. */
const sentRequests = (exchanges: ReadonlyArray<ObservedExchange>) =>
  exchanges.map(({ request }) => {
    if (!URL.canParse(request.url)) return `${request.method} <unparseable>`

    const url = new URL(request.url)

    return `${request.method} ${url.pathname}${url.search}`
  })

const recordInfoRequest = (taskId: string) =>
  `GET /api/v1/jobs/recordInfo?${new URLSearchParams({ taskId }).toString()}`

const getTask = (taskId: string) =>
  kieGetTaskAction.executeTyped({
    integration: kieConformanceIntegration(),
    input: KieGetTaskInput.make({ taskId })
  })

const invalidKeyResolver = CredentialResolver.of({
  resolve: () => Effect.succeed(ApiKeyCredential.make({ key: kieConformanceInvalidApiKey }))
})

/** The last observed answer's HTTP status and envelope code. */
const answerCodes = (exchanges: ReadonlyArray<ObservedExchange>) =>
  Effect.gen(function* () {
    const response = exchanges.at(-1)?.response

    return {
      status: response?.status ?? null,
      code: (yield* envelopeCodeOf(response?.body)) ?? null
    }
  })

// Read cases.

export const kieGetSuccessTaskCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.tasks.get-success',
  title: 'recordInfo of a finished task answers state success with result URLs in resultJson',
  safety: 'read',
  docs: '`kie.get_task` sends GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id> with `Authorization: Bearer <key>`, decodes the envelope `{ code, msg, data }`, and requires `code` 200 and a `data` record with `taskId` and `state` (`waiting`, `queuing`, `generating`, `success`, `fail`). It returns `resultJson` raw and parses its `resultUrls` (and Wan `firstFrameUrl`/`lastFrameUrl`) into `resultUrls`; a `resultJson` it cannot parse yields no URLs.',
  wire: '`kie.get_task` of the seeded finished GPT Image 2 task sends exactly one GET `recordInfo` with the seeded `taskId` as its only query parameter, and Kie answers HTTP 200 with envelope `code` 200 (observed at the `ConnectorHttpClient` port) and the task record: the same `taskId`, `state` `success`, and a `resultJson` string whose `resultUrls` the connector parses into at least one absolute https URL (unverified: that GPT Image 2 results are listed under `resultUrls`, not another key), so the connector reports them.',
  fixtures: [kieGetSuccessTaskFixture.id],
  run: Effect.gen(function* () {
    const taskId = yield* requireSeed('successTaskId')
    const { value, exchanges } = yield* observed(getTask(taskId))
    const output = yield* successValue(kieGetTaskAction.id)(value)

    yield* expectEqual(
      sentRequests(exchanges),
      [recordInfoRequest(taskId)],
      'expected kie.get_task to send exactly one GET recordInfo with the taskId'
    )
    yield* expectEqual(
      yield* answerCodes(exchanges),
      { status: 200, code: 200 },
      'expected the recordInfo answer to be HTTP 200 with envelope code 200'
    )
    yield* expectEqual(
      [output.taskId, output.state],
      [taskId, 'success'],
      'expected the seeded task to read back with its taskId and state success'
    )
    yield* expectConformance(
      output.resultJson !== undefined && output.resultUrls.length > 0,
      'expected a successful task to carry resultJson with at least one result URL',
      { actual: output.resultUrls.length }
    )
    yield* expectConformance(
      output.resultUrls.every(url => URL.canParse(url) && new URL(url).protocol === 'https:'),
      'expected every result URL to be an absolute https URL'
    )
  })
})

export const kieGetFailedTaskCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.tasks.get-failed',
  title: 'recordInfo of a failed task is a successful read with state fail and a failure detail',
  safety: 'read',
  docs: '`kie.get_task` returns a task whose `state` is `fail` as a successful read (a `fail` task state is not an action failure), with `failCode` and `failMsg` when Kie sends them, and no `resultUrls` unless `resultJson` names some.',
  wire: '`kie.get_task` of the seeded failed task sends exactly one GET `recordInfo`; Kie answers HTTP 200 with envelope `code` 200 (a failed generation is not an envelope error) and the record with `state` `fail`, no result URLs, and a non-empty `failMsg` or `failCode` (unverified: which of the two Kie fills, and whether `resultJson` is null or empty), so the connector reports a successful read with `state: fail`.',
  fixtures: [kieGetFailedTaskFixture.id],
  run: Effect.gen(function* () {
    const taskId = yield* requireSeed('failedTaskId')
    const { value, exchanges } = yield* observed(getTask(taskId))
    const output = yield* successValue(kieGetTaskAction.id)(value)

    yield* expectEqual(
      sentRequests(exchanges),
      [recordInfoRequest(taskId)],
      'expected kie.get_task to send exactly one GET recordInfo with the taskId'
    )
    yield* expectEqual(
      yield* answerCodes(exchanges),
      { status: 200, code: 200 },
      'expected the recordInfo answer of a failed task to be HTTP 200 with envelope code 200'
    )
    yield* expectEqual(
      [output.taskId, output.state, output.resultUrls.length],
      [taskId, 'fail', 0],
      'expected the seeded task to read back with state fail and no result URLs'
    )
    yield* expectConformance(
      (output.failMsg ?? '').length > 0 || (output.failCode ?? '').length > 0,
      'expected a failed task to carry a non-empty failMsg or failCode'
    )
  })
})

/** A code in the 4xx range. */
const isClientErrorCode = (code: number | undefined): boolean =>
  code !== undefined && code >= 400 && code < 500

export const kieTaskNotFoundCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.errors.task-not-found',
  title: 'recordInfo of an unknown task id is an envelope 4xx, never a success',
  safety: 'read',
  docs: 'Kie answers most failures with HTTP 200 and a non-200 envelope `code`. The connector maps a non-200 envelope `code` (and any non-2xx status) through `kieFailureCode` to a `ProviderFailure` (`kie_not_found` for 404, `kie_validation` for 422, `kie_request_failed` for an unlisted code) with `underlying: { kieCode, msg }`, never a success; a 200 envelope without a task record would be a `validation_failed` connector error.',
  wire: '`kie.get_task` of a synthetic task id no account holds sends one GET `recordInfo`, and Kie answers with a 4xx envelope `code` (unverified: 422 `recordInfo is null` at HTTP 200, or 404), so the connector reports a provider failure whose `kieCode` is 4xx and whose code is neither `kie_unauthorized` nor `kie_insufficient_credits`. The HTTP status is not checked: the connector maps both forms.',
  fixtures: [kieTaskNotFoundFixture.id],
  run: Effect.gen(function* () {
    const { value, exchanges } = yield* observed(getTask(kieConformanceAbsentTaskId))
    const failure = failureOf(value)

    yield* expectEqual(
      sentRequests(exchanges),
      [recordInfoRequest(kieConformanceAbsentTaskId)],
      'expected kie.get_task to send exactly one GET recordInfo with the taskId'
    )

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected kie.get_task of an unknown task id to fail'
      })
    }

    yield* expectConformance(
      isClientErrorCode(kieCodeOf(failure)) &&
        failure.code !== 'kie_unauthorized' &&
        failure.code !== 'kie_insufficient_credits',
      'expected an unknown task id to answer a 4xx Kie code other than 401 and 402',
      { actual: outcomeOf(value) }
    )
  })
})

export const kieUnauthorizedCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.errors.unauthorized',
  title: 'an API key Kie does not accept answers code 401 (kie_unauthorized)',
  safety: 'read',
  docs: 'Kie documents code 401 for missing or invalid credentials. The connector sends the `kie.api_key` credential as `Authorization: Bearer <key>` and maps an envelope or HTTP 401 to `kie_unauthorized`.',
  wire: '`kie.get_task` with a synthetic API key Kie does not know sends one GET `recordInfo`, and Kie answers with code 401 (unverified: HTTP 401 with envelope `code` 401, or HTTP 200 with envelope `code` 401), so the connector reports `kie_unauthorized` with `kieCode` 401, never a success. The authorization header is never recorded.',
  fixtures: [kieUnauthorizedFixture.id],
  run: Effect.gen(function* () {
    const { value, exchanges } = yield* observed(
      getTask(kieConformanceAbsentTaskId).pipe(
        Effect.provideService(CredentialResolver, invalidKeyResolver)
      )
    )

    const failure = failureOf(value)

    yield* expectEqual(
      sentRequests(exchanges),
      [recordInfoRequest(kieConformanceAbsentTaskId)],
      'expected kie.get_task to send exactly one GET recordInfo with the taskId'
    )
    yield* expectConformance(
      failure !== undefined && failure.code === 'kie_unauthorized' && kieCodeOf(failure) === 401,
      'expected an API key Kie does not accept to answer code 401 (kie_unauthorized)',
      { actual: outcomeOf(value) }
    )
  })
})

// Irreversible write cases.

/** The image case's prompt: the marker and the run id, so each invocation's task is distinct. */
export const kieConformanceImagePrompt = (runId: string) =>
  `${kieConformanceMarker} ${runId}: a plain grey square, synthetic conformance test, safe to ignore`

/** The video case's prompt. */
export const kieConformanceVideoPrompt = (runId: string) =>
  `${kieConformanceMarker} ${runId}: the still image, unchanged, synthetic conformance test, safe to ignore`

/** What one create established (see the module header). */
type CreateOutcome =
  | { readonly kind: 'created'; readonly output: KieCreateTaskOutput }
  | { readonly kind: 'rejected' | 'ambiguous'; readonly error: KieConformanceActionFailed }

/** A definitive rejection code: a 4xx other than 408 (a timeout) and Kie's 455 (unavailable). */
const isDefinitiveRejection = (code: number): boolean =>
  code >= 400 && code < 500 && code !== 408 && code !== 455

type ObservedCreate = {
  readonly value: ActionResult<KieCreateTaskOutput>
  readonly exchanges: ReadonlyArray<ObservedExchange>
}

/**
 * Classify a create from its exit and its observed answer. A definitive rejection is an HTTP 4xx
 * or, at HTTP 2xx, an envelope 4xx (other than 408 and 455); a success is a 2xx with envelope
 * `code` 200 that the connector decoded. Everything else is ambiguous.
 */
const classifyCreate = (
  actionId: string,
  runId: string,
  exit: Exit.Exit<ObservedCreate, ConnectorError>
): Effect.Effect<CreateOutcome> =>
  Effect.gen(function* () {
    const unknown = (fields: {
      readonly code: string
      readonly status?: number | undefined
      readonly kieCode?: number | undefined
    }): CreateOutcome => ({
      kind: 'ambiguous',
      error: new KieConformanceActionFailed({
        actionId,
        code: fields.code,
        status: fields.status,
        kieCode: fields.kieCode,
        taskOutcome: 'unknown',
        runId
      })
    })

    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)

      return unknown({ code: Option.isSome(error) ? error.value.cause : 'defect' })
    }

    const { value, exchanges } = exit.value
    const failure = failureOf(value)

    if (failure !== undefined) {
      const kieCode = kieCodeOf(failure)
      const status = failure.status

      const definitive =
        status !== undefined &&
        (status >= 200 && status < 300
          ? kieCode !== undefined && isDefinitiveRejection(kieCode)
          : isDefinitiveRejection(status))

      return definitive
        ? { kind: 'rejected', error: actionFailed(actionId, failure) }
        : unknown({ code: failure.code, status, kieCode })
    }

    const answer = exchanges.at(-1)?.response

    if (answer === undefined) return unknown({ code: 'unobserved_answer' })

    // A success the connector decoded: the observed answer must still be HTTP 2xx and code 200.
    const code = yield* envelopeCodeOf(answer.body)

    if (!Predicate.isTagged(value, 'Success') || answer.status < 200 || answer.status >= 300) {
      return unknown({ code: 'undecodable_answer', status: answer.status })
    }

    return code === 200
      ? { kind: 'created', output: value.value }
      : unknown({ code: 'undecodable_answer', status: answer.status })
  })

/** Run one create uninterruptibly with its classification (see the module header). */
const createOnce = (
  actionId: string,
  runId: string,
  create: Effect.Effect<
    ActionResult<KieCreateTaskOutput>,
    ConnectorError,
    ConnectorHttpClient | CredentialResolver
  >
) =>
  Effect.uninterruptibleMask(unmask =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(observed(create))
      const outcome = yield* classifyCreate(actionId, runId, exit)

      if (outcome.kind === 'created') {
        return {
          output: outcome.output,
          exchanges: Exit.isSuccess(exit) ? exit.value.exchanges : []
        }
      }

      // An interruption may replace an ambiguous failure, and with it the advice to check the log.
      return yield* outcome.kind === 'ambiguous'
        ? failReporting(unmask, outcome.error)
        : Effect.fail(outcome.error)
    })
  )

const decodeCreateBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ model: Schema.String, input: Schema.Record(Schema.String, Schema.Json) })
  )
)

/** The JSON body of the last observed request (model and input only), or `null`. */
const sentBody = (exchanges: ReadonlyArray<ObservedExchange>) => {
  const body = exchanges.at(-1)?.request.body

  return Predicate.isString(body) ? Option.getOrNull(decodeCreateBody(body)) : null
}

export const kieCreateImageTaskCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.tasks.create-image-task',
  title: 'createTask of a GPT Image 2 text-to-image task answers code 200 with a taskId',
  safety: 'write-irreversible',
  docs: '`kie.create_image_task` without `inputUrls` sends POST https://api.kie.ai/api/v1/jobs/createTask with `{ model: "gpt-image-2-text-to-image", input: { prompt, aspect_ratio, resolution } }` (undefined fields omitted) and returns `{ taskId, model }` from an envelope `code` 200 whose `data.taskId` is a string. Each task spends Kie credits, and the connector cannot cancel or delete one.',
  wire: '`kie.create_image_task` of a short synthetic prompt naming the run id, square (`1:1`) at `1K`, sends exactly one POST `createTask` with that model and input, and Kie answers HTTP 200 with envelope `code` 200 and a non-empty `data.taskId` (observed at the `ConnectorHttpClient` port and decoded inside the uninterruptible create, so a 2xx without `code` 200 is reported as an unknown task outcome), so the connector reports the task id and the text-to-image model (unverified: that Kie accepts the task before generating it, so a later generation failure shows only in `kie.get_task`). The task stays in the account: this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: [kieCreateImageTaskFixture.id],
  run: Effect.gen(function* () {
    const runId = yield* requireSeed('runId')
    const prompt = kieConformanceImagePrompt(runId)

    const created = yield* createOnce(
      kieCreateImageTaskAction.id,
      runId,
      kieCreateImageTaskAction.executeTyped({
        integration: kieConformanceIntegration(),
        input: KieCreateImageTaskInput.make({ prompt, aspectRatio: '1:1', resolution: '1K' })
      })
    )

    yield* expectEqual(
      sentRequests(created.exchanges),
      ['POST /api/v1/jobs/createTask'],
      'expected kie.create_image_task to send exactly one POST createTask'
    )
    yield* expectEqual(
      sentBody(created.exchanges),
      {
        model: kieGptImage2TextToImageModel,
        input: { prompt, aspect_ratio: '1:1', resolution: '1K' }
      },
      'expected kie.create_image_task to send the text-to-image model and input'
    )
    yield* expectConformance(
      created.output.taskId.length > 0 && created.output.model === kieGptImage2TextToImageModel,
      'expected a non-empty taskId and the text-to-image model'
    )
  })
})

export const kieCreateVideoTaskCase: KieConformanceCase = defineConformanceCase({
  id: 'kie.tasks.create-video-task',
  title: 'createTask of a Wan 2.7 image-to-video task answers code 200 with a taskId',
  safety: 'write-irreversible',
  docs: '`kie.create_video_task` sends POST https://api.kie.ai/api/v1/jobs/createTask with `{ model: "wan/2-7-image-to-video", input: { prompt, first_frame_url, resolution, duration } }` (undefined fields omitted; a first frame or a first clip is required) and returns `{ taskId, model }` from an envelope `code` 200. Kie, not the host, fetches `first_frame_url`. Each task spends Kie credits, and the connector cannot cancel or delete one.',
  wire: '`kie.create_video_task` of a short synthetic prompt naming the run id with the seeded public first frame, `720p` for 5 seconds, sends exactly one POST `createTask` with that model and input, and Kie answers HTTP 200 with envelope `code` 200 and a non-empty `data.taskId` (observed and decoded inside the uninterruptible create), so the connector reports the task id and the Wan 2.7 model (unverified: that Kie accepts the task before fetching the first frame, so an unreachable frame fails the task later rather than the create). The task stays in the account: this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: [kieCreateVideoTaskFixture.id],
  run: Effect.gen(function* () {
    const firstFrameUrl = yield* requireSeed('firstFrameUrl')
    const runId = yield* requireSeed('runId')
    const prompt = kieConformanceVideoPrompt(runId)

    const created = yield* createOnce(
      kieCreateVideoTaskAction.id,
      runId,
      kieCreateVideoTaskAction.executeTyped({
        integration: kieConformanceIntegration(),
        input: KieCreateVideoTaskInput.make({
          prompt,
          firstFrameUrl,
          resolution: '720p',
          duration: 5
        })
      })
    )

    yield* expectEqual(
      sentRequests(created.exchanges),
      ['POST /api/v1/jobs/createTask'],
      'expected kie.create_video_task to send exactly one POST createTask'
    )
    yield* expectEqual(
      sentBody(created.exchanges),
      {
        model: kieWan27ImageToVideoModel,
        input: { prompt, first_frame_url: firstFrameUrl, resolution: '720p', duration: 5 }
      },
      'expected kie.create_video_task to send the Wan 2.7 model and input'
    )
    yield* expectConformance(
      created.output.taskId.length > 0 && created.output.model === kieWan27ImageToVideoModel,
      'expected a non-empty taskId and the Wan 2.7 model'
    )
  })
})

/** Every Kie conformance case, in fixture order. */
export const kieConformanceCases: ReadonlyArray<KieConformanceCase> = [
  kieGetSuccessTaskCase,
  kieGetFailedTaskCase,
  kieTaskNotFoundCase,
  kieUnauthorizedCase,
  kieCreateImageTaskCase,
  kieCreateVideoTaskCase
]
