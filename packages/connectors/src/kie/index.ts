import { Effect, Match, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult, ProviderFailure } from '../result.ts'

export const kieConnectorId = 'kie'

export const kieApiKeySlotId = 'kie.api_key'

export const kieApiBaseUrl = 'https://api.kie.ai'

export const KieApiKeySlot = CredentialSlot.make({ id: kieApiKeySlotId, kind: 'api_key' })

export const kieGptImage2TextToImageModel = 'gpt-image-2-text-to-image'

export const kieGptImage2ImageToImageModel = 'gpt-image-2-image-to-image'

export const kieWan27ImageToVideoModel = 'wan/2-7-image-to-video'

const resolveKieApiKey = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, KieApiKeySlot)

    return yield* Match.value(credential).pipe(
      Match.tag('ApiKeyCredential', current => Effect.succeed(current.key)),
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('UsernamePasswordCredential', () =>
        Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Kie connector does not accept username/password credentials',
            connectorId: integration.connectorId,
            slotId: KieApiKeySlot.id
          })
        )
      ),
      Match.exhaustive
    )
  })

// Kie fetches these URLs from its own servers; only their syntax is checked here.
const isHttpUrl = Schema.makeFilter<string>(value => {
  // URL parsing tolerates surrounding whitespace that would reach Kie verbatim.
  if (/\s/u.test(value)) return 'must not contain whitespace'

  if (!URL.canParse(value)) return 'must be an absolute http or https URL'

  const url = new URL(value)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must use http or https'

  return url.username.length > 0 || url.password.length > 0
    ? 'must not carry URL credentials'
    : undefined
})

export const KieHttpUrl = Schema.String.check(isHttpUrl).annotate({
  description: 'Public http or https URL that Kie can fetch'
})

// Model-visible when exposed as a tool: hosts that must pin the webhook strip or override it.
const KieCallBackUrl = KieHttpUrl.annotate({
  description: 'Optional URL Kie POSTs the finished task to (instead of polling kie.get_task)'
})

export const KieAspectRatio = Schema.Literals([
  'auto',
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '5:4',
  '4:5',
  '16:9',
  '9:16',
  '2:1',
  '1:2',
  '3:1',
  '1:3',
  '21:9',
  '9:21'
])

export type KieAspectRatio = typeof KieAspectRatio.Type

export const KieImageResolution = Schema.Literals(['1K', '2K', '4K'])

export type KieImageResolution = typeof KieImageResolution.Type

export const KieVideoResolution = Schema.Literals(['720p', '1080p'])

export type KieVideoResolution = typeof KieVideoResolution.Type

export const KieTaskState = Schema.Literals(['waiting', 'queuing', 'generating', 'success', 'fail'])

export type KieTaskState = typeof KieTaskState.Type

export class KieCreateImageTaskInput extends Schema.Class<KieCreateImageTaskInput>(
  'KieCreateImageTaskInput'
)({
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  inputUrls: Schema.optional(
    Schema.Array(KieHttpUrl).check(Schema.isMinLength(1), Schema.isMaxLength(16)).annotate({
      description: '1-16 reference image URLs; when present the task is image-to-image'
    })
  ),
  aspectRatio: Schema.optional(KieAspectRatio),
  resolution: Schema.optional(KieImageResolution),
  callBackUrl: Schema.optional(KieCallBackUrl)
}) {}

// Wan 2.7 needs a first frame or a first clip, and a last frame only pairs with a first frame.
const wanVideoSource = Schema.makeFilter<{
  readonly firstFrameUrl?: string | undefined
  readonly lastFrameUrl?: string | undefined
  readonly firstClipUrl?: string | undefined
}>(input => {
  if (input.firstFrameUrl === undefined && input.firstClipUrl === undefined) {
    return { path: ['firstFrameUrl'], issue: 'firstFrameUrl or firstClipUrl is required' }
  }

  return input.lastFrameUrl !== undefined && input.firstFrameUrl === undefined
    ? { path: ['lastFrameUrl'], issue: 'lastFrameUrl requires firstFrameUrl' }
    : undefined
})

export class KieCreateVideoTaskInput extends Schema.Class<KieCreateVideoTaskInput>(
  'KieCreateVideoTaskInput'
)(
  Schema.Struct({
    prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
    negativePrompt: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    firstFrameUrl: Schema.optional(KieHttpUrl),
    lastFrameUrl: Schema.optional(KieHttpUrl),
    firstClipUrl: Schema.optional(KieHttpUrl),
    drivingAudioUrl: Schema.optional(KieHttpUrl),
    resolution: Schema.optional(KieVideoResolution),
    duration: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 15 })).annotate({
        description: 'Total output length in seconds (a continued clip counts toward it)'
      })
    ),
    promptExtend: Schema.optional(Schema.Boolean),
    watermark: Schema.optional(Schema.Boolean),
    seed: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2147483647 }))),
    nsfwChecker: Schema.optional(Schema.Boolean),
    callBackUrl: Schema.optional(KieCallBackUrl)
  }).check(wanVideoSource)
) {}

export class KieCreateTaskOutput extends Schema.Class<KieCreateTaskOutput>('KieCreateTaskOutput')({
  taskId: Schema.String,
  model: Schema.String
}) {}

export class KieGetTaskInput extends Schema.Class<KieGetTaskInput>('KieGetTaskInput')({
  taskId: Schema.String.check(Schema.isMinLength(1))
}) {}

export class KieGetTaskOutput extends Schema.Class<KieGetTaskOutput>('KieGetTaskOutput')({
  taskId: Schema.String,
  state: KieTaskState,
  resultUrls: Schema.Array(Schema.String),
  model: Schema.optional(Schema.String),
  resultJson: Schema.optional(Schema.String),
  failCode: Schema.optional(Schema.String),
  failMsg: Schema.optional(Schema.String),
  costTime: Schema.optional(Schema.Number),
  completeTime: Schema.optional(Schema.Number),
  createTime: Schema.optional(Schema.Number),
  updateTime: Schema.optional(Schema.Number),
  progress: Schema.optional(Schema.Number),
  creditsConsumed: Schema.optional(Schema.Number)
}) {}

// Kie answers most failures with HTTP 200 and a non-200 envelope `code`.
const KieEnvelope = Schema.Struct({
  code: Schema.Number,
  msg: Schema.optional(Schema.NullOr(Schema.String)),
  data: Schema.optional(Schema.Unknown)
})

const KieCreatedTask = Schema.Struct({ taskId: Schema.String })

const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String))

const OptionalNullableNumber = Schema.optional(Schema.NullOr(Schema.Number))

const KieTaskRecord = Schema.Struct({
  taskId: Schema.String,
  model: OptionalNullableString,
  state: KieTaskState,
  resultJson: OptionalNullableString,
  failCode: OptionalNullableString,
  failMsg: OptionalNullableString,
  costTime: OptionalNullableNumber,
  completeTime: OptionalNullableNumber,
  createTime: OptionalNullableNumber,
  updateTime: OptionalNullableNumber,
  progress: OptionalNullableNumber,
  creditsConsumed: OptionalNullableNumber
})

const KieResultUrl = Schema.optional(
  Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))
)

const KieResultJson = Schema.Struct({
  resultUrls: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  firstFrameUrl: KieResultUrl,
  lastFrameUrl: KieResultUrl
})

const kieFailureCode = (code: number) => {
  switch (code) {
    case 401:
      return 'kie_unauthorized'
    case 402:
      return 'kie_insufficient_credits'
    case 404:
      return 'kie_not_found'
    case 422:
      return 'kie_validation'
    case 429:
      return 'kie_rate_limited'
    case 455:
      return 'kie_unavailable'
    case 501:
      return 'kie_generation_failed'
    case 505:
      return 'kie_feature_disabled'
    default:
      return 'kie_request_failed'
  }
}

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const invalidResponse = (message: string, underlying: unknown) =>
  new ConnectorError({ cause: 'validation_failed', message, underlying })

/**
 * Sends one Kie request and returns the envelope `data` decoded with `schema`. Non-2xx statuses
 * and non-200 envelope codes become `ProviderFailure`s carrying the Kie `code` and `msg`.
 */
const kieRequest = <A>(
  integration: ConnectorIntegration,
  operation: string,
  makeRequest: (headers: Readonly<Record<string, string>>) => ConnectorHttpRequest,
  schema: Schema.Schema<A> & { readonly DecodingServices: never }
) =>
  Effect.gen(function* () {
    const apiKey = yield* resolveKieApiKey(integration)
    const http = yield* ConnectorHttpClient

    const response = yield* http.request(
      makeRequest({ accept: 'application/json', authorization: `Bearer ${apiKey}` })
    )

    const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(KieEnvelope))(
      response.body
    ).pipe(Effect.result)

    const failure = (code: number, msg: string | null | undefined) =>
      ActionResult.failure(
        new ProviderFailure({
          code: kieFailureCode(code),
          message: `Kie ${operation} failed${msg === undefined || msg === null || msg.length === 0 ? '' : `: ${msg}`}`,
          status: response.status,
          underlying: { kieCode: code, msg: msg ?? undefined }
        })
      )

    if (!isSuccessStatus(response.status)) {
      return Result.isSuccess(envelope)
        ? failure(envelope.success.code, envelope.success.msg)
        : failure(response.status, undefined)
    }

    if (Result.isFailure(envelope)) {
      return yield* Effect.fail(invalidResponse('Invalid Kie response', envelope.failure))
    }

    if (envelope.success.code !== 200) {
      return failure(envelope.success.code, envelope.success.msg)
    }

    const data = yield* Schema.decodeUnknownEffect(schema)(envelope.success.data).pipe(
      Effect.mapError(error => invalidResponse('Invalid Kie response shape', error))
    )

    return ActionResult.success(data)
  })

const resultUrlsFromJson = (resultJson: string | undefined) => {
  if (resultJson === undefined || resultJson.trim().length === 0) return Effect.succeed([])

  return Schema.decodeUnknownEffect(Schema.fromJsonString(KieResultJson))(resultJson).pipe(
    Effect.map(parsed =>
      Array.from(
        new Set(
          [
            ...(parsed.resultUrls ?? []),
            ...[parsed.firstFrameUrl ?? []].flat(),
            ...[parsed.lastFrameUrl ?? []].flat()
          ].flatMap(url => {
            const trimmed = url.trim()

            return trimmed.length > 0 ? [trimmed] : []
          })
        )
      )
    ),
    // `resultJson` is returned raw too, so an unexpected shape loses no information.
    Effect.orElseSucceed((): ReadonlyArray<string> => [])
  )
}

const nullToUndefined = <A>(value: A | null | undefined) => (value === null ? undefined : value)

/** Submits `input` (Kie's snake_case model input; undefined fields are omitted) to `model`. */
const submitTask = <Input extends object>(
  integration: ConnectorIntegration,
  operation: string,
  model: string,
  callBackUrl: string | undefined,
  input: Input
) =>
  kieRequest(
    integration,
    operation,
    headers =>
      ConnectorHttpRequest.make({
        method: 'POST',
        url: `${kieApiBaseUrl}/api/v1/jobs/createTask`,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model, callBackUrl, input })
      }),
    KieCreatedTask
  ).pipe(
    Effect.map(result =>
      Predicate.isTagged(result, 'Failure')
        ? ActionResult.failure(result.error)
        : ActionResult.success(KieCreateTaskOutput.make({ taskId: result.value.taskId, model }))
    )
  )

export const kieCreateImageTaskAction = defineAction({
  id: 'kie.create_image_task',
  description:
    'Submit a Kie GPT Image 2 task: text-to-image, or image-to-image when inputUrls are given. ' +
    'Returns a taskId to poll with kie.get_task; each task spends Kie credits.',
  inputSchema: KieCreateImageTaskInput,
  outputSchema: KieCreateTaskOutput,
  access: 'write',
  execute: ({ integration, input }) =>
    submitTask(
      integration,
      'create_image_task',
      input.inputUrls === undefined ? kieGptImage2TextToImageModel : kieGptImage2ImageToImageModel,
      input.callBackUrl,
      {
        prompt: input.prompt,
        input_urls: input.inputUrls,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution
      }
    )
})

export const kieCreateVideoTaskAction = defineAction({
  id: 'kie.create_video_task',
  description:
    'Submit a Kie Wan 2.7 image-to-video task from a first frame (optionally with a last frame) ' +
    'or a first clip to continue. Returns a taskId to poll with kie.get_task; each task spends ' +
    'Kie credits.',
  inputSchema: KieCreateVideoTaskInput,
  outputSchema: KieCreateTaskOutput,
  access: 'write',
  execute: ({ integration, input }) =>
    submitTask(integration, 'create_video_task', kieWan27ImageToVideoModel, input.callBackUrl, {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      first_frame_url: input.firstFrameUrl,
      last_frame_url: input.lastFrameUrl,
      first_clip_url: input.firstClipUrl,
      driving_audio_url: input.drivingAudioUrl,
      resolution: input.resolution,
      duration: input.duration,
      prompt_extend: input.promptExtend,
      watermark: input.watermark,
      seed: input.seed,
      nsfw_checker: input.nsfwChecker
    })
})

export const kieGetTaskAction = defineAction({
  id: 'kie.get_task',
  description:
    'Get a Kie task state (waiting, queuing, generating, success, fail) and, on success, its ' +
    'result URLs. Result URLs expire (Kie keeps generated files for 14 days).',
  inputSchema: KieGetTaskInput,
  outputSchema: KieGetTaskOutput,
  access: 'read',
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const result = yield* kieRequest(
        integration,
        'get_task',
        headers =>
          ConnectorHttpRequest.make({
            method: 'GET',
            url: `${kieApiBaseUrl}/api/v1/jobs/recordInfo?${new URLSearchParams({ taskId: input.taskId }).toString()}`,
            headers
          }),
        KieTaskRecord
      )

      if (Predicate.isTagged(result, 'Failure')) return ActionResult.failure(result.error)

      const task = result.value
      const resultJson = nullToUndefined(task.resultJson)

      return ActionResult.success(
        KieGetTaskOutput.make({
          taskId: task.taskId,
          state: task.state,
          resultUrls: yield* resultUrlsFromJson(resultJson),
          model: nullToUndefined(task.model),
          resultJson,
          failCode: nullToUndefined(task.failCode),
          failMsg: nullToUndefined(task.failMsg),
          costTime: nullToUndefined(task.costTime),
          completeTime: nullToUndefined(task.completeTime),
          createTime: nullToUndefined(task.createTime),
          updateTime: nullToUndefined(task.updateTime),
          progress: nullToUndefined(task.progress),
          creditsConsumed: nullToUndefined(task.creditsConsumed)
        })
      )
    })
})

export const kieActions = [kieCreateImageTaskAction, kieCreateVideoTaskAction, kieGetTaskAction]

export const KieConnector = defineConnector({
  id: kieConnectorId,
  description: 'Kie image and video generation tasks (GPT Image 2, Wan 2.7) and task status.',
  actions: kieActions
})
