/**
 * Kie emulator API: the route table (evidence, request-shape checks, and state-reading plans), the
 * fixture error bodies, and answer rendering (internal; re-exported by `src/kie.ts`).
 *
 * Only the two Market API routes the six Kie conformance cases send are emulated, on the recorded
 * origin `https://api.kie.ai`: the task read (`GET /api/v1/jobs/recordInfo`) and the task create
 * (`POST /api/v1/jobs/createTask`, a connector write). A read plan answers a fixture's response or
 * refuses (400 not-emulated, no fault used up); the create plan refuses or returns the commit that
 * mints the task id and records the task.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactBodyKeys,
  exactQuery,
  isNotEmulated,
  mediaType,
  notEmulated,
  statefulRoute,
  type Commit,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import {
  kieEmulatorCreatedId,
  kieEmulatorMaxCreated,
  kieEmulatorOrigin,
  kieTaskIdPattern,
  type KieEmulatorState,
  type KieEmulatorTask
} from './state.ts'

/** Content type of every answer, as the fixtures record it. */
const contentType = 'application/json'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type KieEmulatorDrills = {
  /** A `success` record answers a `resultJson` that lists no result URL. */
  readonly successWithoutResultUrls?: boolean
  /** A `fail` record answers the envelope error `code` 501 instead of the record. */
  readonly failedTaskAsEnvelopeError?: boolean
  /** An absent task id answers envelope `code` 200 with no record. */
  readonly absentTaskAsSuccess?: boolean
  /** A rejected key answers HTTP 500 with envelope `code` 500 instead of the recorded 401. */
  readonly unauthorizedAs5xx?: boolean
  /** The image create answers envelope `code` 402 (insufficient credits) and records nothing. */
  readonly imageCreateInsufficientCredits?: boolean
  /** The video create answers an empty `taskId` (the task is still recorded). */
  readonly videoCreateEmptyTaskId?: boolean
}

export const kieEmulatorDrillKnobs: ReadonlyArray<keyof KieEmulatorDrills> = [
  'successWithoutResultUrls',
  'failedTaskAsEnvelopeError',
  'absentTaskAsSuccess',
  'unauthorizedAs5xx',
  'imageCreateInsufficientCredits',
  'videoCreateEmptyTaskId'
]

export type KieApiEnv = {
  readonly drills: Readonly<Record<keyof KieEmulatorDrills, boolean>>
}

/**
 * The fixtures' error bodies, byte for byte (`JSON.stringify` keeps this key order): the unknown
 * task (answered HTTP 200) and the rejected key (answered HTTP 401).
 */
export const kieEmulatorErrorBodies = {
  taskNotFound: { code: 422, msg: 'recordInfo is null', data: null },
  unauthorized: { code: 401, msg: 'Unauthorized', data: null }
} as const satisfies Readonly<Record<string, Schema.Json>>

type Route = StatefulRoute<KieEmulatorState, KieApiEnv>

const getSuccessCase = 'kie.tasks.get-success'

const getFailedCase = 'kie.tasks.get-failed'

const taskNotFoundCase = 'kie.errors.task-not-found'

const unauthorizedCase = 'kie.errors.unauthorized'

const createImageCase = 'kie.tasks.create-image-task'

const createVideoCase = 'kie.tasks.create-video-task'

const evidence = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>
) => ({
  method,
  path,
  kind: 'connector' as const,
  write,
  caseIds,
  evidence: 'unverified' as const,
  origin: kieEmulatorOrigin,
  // No route has a path parameter: every raw path is matched exactly.
  params: {}
})

const json = (status: number, body: Schema.Json): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })

/** A read-only commit. */
const answer =
  (response: () => Response): Commit =>
  () =>
    response()

/** Whether the request's bearer digest is one a seed marks as rejected. */
const rejected = (state: KieEmulatorState, digest: string | undefined): boolean =>
  digest !== undefined && state.rejectedKeyDigests.includes(digest)

// recordInfo.

type RecordInput = { readonly taskId: string; readonly bearerDigest: string | undefined }

/** The record fields, in the fixtures' key order. */
const renderTask = (task: KieEmulatorTask, env: KieApiEnv): Schema.JsonObject => ({
  taskId: task.taskId,
  model: task.model,
  state: task.state,
  resultJson:
    env.drills.successWithoutResultUrls && task.state === 'success'
      ? JSON.stringify({ resultUrls: [] })
      : task.resultJson,
  failCode: task.failCode,
  failMsg: task.failMsg,
  costTime: task.costTime,
  completeTime: task.completeTime,
  createTime: task.createTime,
  updateTime: task.updateTime
})

const recordInfo: Route = statefulRoute(
  evidence('GET', '/api/v1/jobs/recordInfo', false, [
    getSuccessCase,
    getFailedCase,
    taskNotFoundCase,
    unauthorizedCase
  ]),
  'none',
  (request): RecordInput | NotEmulated => {
    const query = exactQuery(request, ['taskId'], [], { rawNames: true })

    if (isNotEmulated(query)) return query

    const taskId = query['taskId'] ?? ''

    if (!kieTaskIdPattern.test(taskId)) {
      return notEmulated('taskId must be 1 to 128 letters, digits, underscores, or hyphens')
    }

    return { taskId, bearerDigest: request.bearerDigest }
  },
  (state, input, { env }) => {
    if (rejected(state, input.bearerDigest)) {
      // The unauthorized fixture's 401, whatever the (well-formed) task id.
      return answer(() =>
        env.drills.unauthorizedAs5xx
          ? json(500, { code: 500, msg: 'Server error', data: null })
          : json(401, kieEmulatorErrorBodies.unauthorized)
      )
    }

    const task = state.tasks.find(held => held.taskId === input.taskId)

    if (task !== undefined) {
      if (task.state === 'fail' && env.drills.failedTaskAsEnvelopeError) {
        return answer(() =>
          json(200, { code: 501, msg: 'synthetic generation failure', data: null })
        )
      }

      return answer(() => json(200, { code: 200, msg: 'success', data: renderTask(task, env) }))
    }

    if (state.absentTaskIds.includes(input.taskId)) {
      return answer(() =>
        json(
          200,
          env.drills.absentTaskAsSuccess
            ? { code: 200, msg: 'success', data: null }
            : kieEmulatorErrorBodies.taskNotFound
        )
      )
    }

    return notEmulated(
      'a task id the state holds neither as a finished task nor as absent is not emulated'
    )
  }
)

// createTask.

/** The recorded create flows: the model and the exact input keys each sends. */
const imageModel = 'gpt-image-2-text-to-image'

const videoModel = 'wan/2-7-image-to-video'

/** The longest prompt a model takes (the connector's input limits). */
const promptLimitOf = (model: string): number => (model === imageModel ? 20_000 : 5000)

type CreateInput = {
  readonly model: string
  readonly input: Schema.JsonObject
  readonly bearerDigest: string | undefined
}

/** A non-empty prompt within the model's limit. */
const promptProblem = (value: Schema.Json | undefined, model: string): NotEmulated | undefined =>
  Predicate.isString(value) && value.length > 0 && value.length <= promptLimitOf(model)
    ? undefined
    : notEmulated('prompt must be a non-empty string within the model limit')

/** An absolute https URL without credentials or whitespace, at most 2048 characters. */
const isHttpsUrl = (value: Schema.Json | undefined): boolean => {
  if (!Predicate.isString(value) || value.length > 2048 || /\s/u.test(value)) return false

  if (!URL.canParse(value)) return false

  const url = new URL(value)

  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

const imageInput = (input: Schema.Json | undefined): Schema.JsonObject | NotEmulated => {
  const fields = exactBodyKeys(input, 'the image input', ['prompt', 'aspect_ratio', 'resolution'])

  if (isNotEmulated(fields)) return fields

  const prompt = promptProblem(fields['prompt'], imageModel)

  if (prompt !== undefined) return prompt

  // The recorded values: a square at 1K.
  return fields['aspect_ratio'] === '1:1' && fields['resolution'] === '1K'
    ? fields
    : notEmulated('an aspect_ratio or resolution other than the recorded 1:1 at 1K is not emulated')
}

const videoInput = (input: Schema.Json | undefined): Schema.JsonObject | NotEmulated => {
  const fields = exactBodyKeys(input, 'the video input', [
    'prompt',
    'first_frame_url',
    'resolution',
    'duration'
  ])

  if (isNotEmulated(fields)) return fields

  const prompt = promptProblem(fields['prompt'], videoModel)

  if (prompt !== undefined) return prompt

  if (!isHttpsUrl(fields['first_frame_url'])) {
    return notEmulated('first_frame_url must be an absolute https URL without credentials')
  }

  // The recorded values: 720p for 5 seconds.
  return fields['resolution'] === '720p' && fields['duration'] === 5
    ? fields
    : notEmulated('a resolution or duration other than the recorded 720p for 5 s is not emulated')
}

const createTask: Route = statefulRoute(
  evidence('POST', '/api/v1/jobs/createTask', true, [createImageCase, createVideoCase]),
  'json',
  (request): CreateInput | NotEmulated => {
    const query = exactQuery(request, [], [], { rawNames: true })

    if (isNotEmulated(query)) return query

    if (mediaType(request.header('content-type')) !== 'application/json') {
      return notEmulated('a content type other than application/json is not emulated')
    }

    const body = exactBodyKeys(request.json, 'the create body', ['model', 'input'])

    if (isNotEmulated(body)) return body

    const model = body['model']

    const input =
      model === imageModel
        ? imageInput(body['input'])
        : model === videoModel
          ? videoInput(body['input'])
          : notEmulated('a model no create fixture records is not emulated')

    if (isNotEmulated(input)) return input

    return model === imageModel || model === videoModel
      ? { model, input, bearerDigest: request.bearerDigest }
      : notEmulated('a model no create fixture records is not emulated')
  },
  (state, input, { env }) => {
    // No fixture records a create with a rejected key.
    if (rejected(state, input.bearerDigest)) {
      return notEmulated('a create with a key the seed marks as rejected is not emulated')
    }

    if (input.model === imageModel && env.drills.imageCreateInsufficientCredits) {
      return answer(() => json(200, { code: 402, msg: 'Credits insufficient', data: null }))
    }

    const counter = state.nextCreated

    if (counter > kieEmulatorMaxCreated) {
      return notEmulated('the emulator has minted every created-task id it takes')
    }

    const taskId = kieEmulatorCreatedId(counter)

    return () => {
      state.nextCreated = counter + 1
      state.createdTasks = [
        ...state.createdTasks,
        { taskId, model: input.model, input: input.input }
      ]

      const answered = input.model === videoModel && env.drills.videoCreateEmptyTaskId ? '' : taskId

      return json(200, { code: 200, msg: 'success', data: { taskId: answered } })
    }
  }
)

/** Every emulated route, in manifest order. */
export const kieApiRoutes: ReadonlyArray<Route> = [recordInfo, createTask]
