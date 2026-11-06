import { Effect, Layer, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { toolJsonSchemaFromSchema } from '@yolk-sdk/agent/tools'
import {
  ApiKeyCredential,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import {
  KieConnector,
  KieGetTaskOutput,
  kieActions,
  kieApiKeySlotId,
  kieCreateImageTaskAction,
  kieCreateVideoTaskAction,
  kieGetTaskAction
} from '@yolk-sdk/connectors/kie'

const integration = makeIntegration({
  connectorId: 'kie',
  credentialBindings: [
    makeCredentialBinding({ slotId: kieApiKeySlotId, credentialRef: 'host-kie-ref' })
  ]
})

const isJson = Schema.is(Schema.Json)

const response = (body: Schema.Json, status = 200) => {
  if (!isJson(body)) throw new TypeError('JSON fixture requires a finite JSON value')

  return ConnectorHttpResponse.make({ status, headers: {}, body: JSON.stringify(body) })
}

const makeHarness = (responses: ReadonlyArray<ConnectorHttpResponse>) => {
  const requests: Array<ConnectorHttpRequest> = []

  const layer = Layer.mergeAll(
    Layer.succeed(
      CredentialResolver,
      CredentialResolver.of({
        resolve: request => {
          expect(request.binding.credentialRef).toBe('host-kie-ref')
          expect(request.slot.id).toBe(kieApiKeySlotId)

          return Effect.succeed(ApiKeyCredential.make({ key: 'kie-test-key' }))
        }
      })
    ),
    Layer.succeed(
      ConnectorHttpClient,
      ConnectorHttpClient.of({
        request: request => {
          requests.push(request)
          const next = responses.at(requests.length - 1)

          return next === undefined
            ? Effect.die(new Error('Unexpected Kie HTTP request'))
            : Effect.succeed(next)
        }
      })
    )
  )

  return { layer, requests }
}

const bodyOf = (request: ConnectorHttpRequest | undefined) =>
  request?.body === undefined ? undefined : JSON.parse(request.body)

const created = response({ code: 200, msg: 'success', data: { taskId: 'task_1' } })

describe('Kie connector', () => {
  it('exports its actions in stable order with access metadata', () => {
    expect(KieConnector.id).toBe('kie')
    expect(kieActions.map(action => [action.id, action.access])).toEqual([
      ['kie.create_image_task', 'write'],
      ['kie.create_video_task', 'write'],
      ['kie.get_task', 'read']
    ])
  })

  it('lowers every input and output schema to JSON Schema', () => {
    for (const action of kieActions) {
      expect(toolJsonSchemaFromSchema(action.inputSchema)).toMatchObject({ type: 'object' })
      expect(toolJsonSchemaFromSchema(action.outputSchema)).toMatchObject({ type: 'object' })
    }
  })

  it.effect('submits a text-to-image task with the bearer key', () =>
    Effect.gen(function* () {
      const harness = makeHarness([created])

      const result = yield* kieCreateImageTaskAction
        .execute({
          integration,
          input: { prompt: 'A forest classroom', aspectRatio: '16:9', resolution: '2K' }
        })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://api.kie.ai/api/v1/jobs/createTask',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer kie-test-key',
          'content-type': 'application/json'
        }
      })
      expect(bodyOf(harness.requests[0])).toEqual({
        model: 'gpt-image-2-text-to-image',
        input: { prompt: 'A forest classroom', aspect_ratio: '16:9', resolution: '2K' }
      })
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { taskId: 'task_1', model: 'gpt-image-2-text-to-image' }
      })
    })
  )

  it.effect('switches to image-to-image when input URLs are given', () =>
    Effect.gen(function* () {
      const harness = makeHarness([created])

      yield* kieCreateImageTaskAction
        .execute({
          integration,
          input: {
            prompt: 'Restyle it',
            inputUrls: ['https://assets.example/source.png'],
            callBackUrl: 'https://hooks.example/kie'
          }
        })
        .pipe(Effect.provide(harness.layer))

      expect(bodyOf(harness.requests[0])).toEqual({
        model: 'gpt-image-2-image-to-image',
        callBackUrl: 'https://hooks.example/kie',
        input: { prompt: 'Restyle it', input_urls: ['https://assets.example/source.png'] }
      })
    })
  )

  it.effect('rejects non-http and credential-bearing URLs before any request', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const url of ['ftp://assets.example/a.png', 'https://user:pass@assets.example/a.png']) {
        const error = yield* kieCreateImageTaskAction
          .execute({ integration, input: { prompt: 'x', inputUrls: [url] } })
          .pipe(Effect.provide(harness.layer), Effect.flip)

        expect(error).toMatchObject({ cause: 'validation_failed' })
      }

      expect(harness.requests).toEqual([])
    })
  )

  it.effect('submits a Wan 2.7 video task with snake_case input', () =>
    Effect.gen(function* () {
      const harness = makeHarness([created])

      const result = yield* kieCreateVideoTaskAction
        .execute({
          integration,
          input: {
            prompt: 'The cat turns its head',
            firstFrameUrl: 'https://assets.example/first.png',
            lastFrameUrl: 'https://assets.example/last.png',
            duration: 5,
            resolution: '720p',
            promptExtend: false,
            seed: 42
          }
        })
        .pipe(Effect.provide(harness.layer))

      expect(bodyOf(harness.requests[0])).toEqual({
        model: 'wan/2-7-image-to-video',
        input: {
          prompt: 'The cat turns its head',
          first_frame_url: 'https://assets.example/first.png',
          last_frame_url: 'https://assets.example/last.png',
          resolution: '720p',
          duration: 5,
          prompt_extend: false,
          seed: 42
        }
      })
      expect(result).toMatchObject({
        _tag: 'Success',
        value: { taskId: 'task_1', model: 'wan/2-7-image-to-video' }
      })
    })
  )

  it.effect('requires a video source and a first frame for a last frame', () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      for (const input of [
        { prompt: 'x' },
        {
          prompt: 'x',
          firstClipUrl: 'https://a.example/c.mp4',
          lastFrameUrl: 'https://a.example/l.png'
        },
        { prompt: 'x', firstFrameUrl: 'https://a.example/f.png', duration: 1 }
      ]) {
        const error = yield* kieCreateVideoTaskAction
          .execute({ integration, input })
          .pipe(Effect.provide(harness.layer), Effect.flip)

        expect(error).toMatchObject({ cause: 'validation_failed' })
      }

      expect(harness.requests).toEqual([])
    })
  )

  it.effect('maps a non-200 envelope code on HTTP 200 to a provider failure', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({ code: 402, msg: 'Credits insufficient', data: null })
      ])

      const result = yield* kieCreateImageTaskAction
        .execute({ integration, input: { prompt: 'x' } })
        .pipe(Effect.provide(harness.layer))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: {
          code: 'kie_insufficient_credits',
          message: 'Kie create_image_task failed: Credits insufficient',
          status: 200,
          underlying: { kieCode: 402, msg: 'Credits insufficient' }
        }
      })
    })
  )

  it.effect('maps a non-2xx status without a JSON body by its status', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        ConnectorHttpResponse.make({ status: 429, headers: {}, body: 'Too Many Requests' })
      ])

      const result = yield* kieGetTaskAction
        .execute({ integration, input: { taskId: 'task_1' } })
        .pipe(Effect.provide(harness.layer))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'kie_rate_limited', status: 429 }
      })
    })
  )

  it.effect('fails with validation_failed on an unreadable 2xx body', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        ConnectorHttpResponse.make({ status: 200, headers: {}, body: '<html>' })
      ])

      const error = yield* kieGetTaskAction
        .execute({ integration, input: { taskId: 'task_1' } })
        .pipe(Effect.provide(harness.layer), Effect.flip)

      expect(error).toMatchObject({ cause: 'validation_failed' })
    })
  )

  it.effect('polls a task, normalizes nulls, and collects unique result URLs', () =>
    Effect.gen(function* () {
      const resultJson = JSON.stringify({
        resultUrls: ['https://files.example/a.png', 'https://files.example/a.png'],
        firstFrameUrl: 'https://files.example/first.png',
        lastFrameUrl: ['https://files.example/last.png']
      })

      const harness = makeHarness([
        response({
          code: 200,
          msg: 'success',
          data: {
            taskId: 'task 1',
            model: null,
            state: 'success',
            resultJson,
            failCode: '',
            failMsg: null,
            progress: null,
            creditsConsumed: 1.25
          }
        })
      ])

      const result = yield* kieGetTaskAction
        .execute({ integration, input: { taskId: 'task 1' } })
        .pipe(Effect.provide(harness.layer))

      expect(harness.requests[0]).toMatchObject({
        method: 'GET',
        url: 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task+1',
        headers: { accept: 'application/json', authorization: 'Bearer kie-test-key' }
      })
      expect(harness.requests[0]?.body).toBeUndefined()

      if (!Predicate.isTagged(result, 'Success') || !(result.value instanceof KieGetTaskOutput))
        throw new Error('Expected a task')

      expect(result.value).toEqual(
        KieGetTaskOutput.make({
          taskId: 'task 1',
          state: 'success',
          resultUrls: [
            'https://files.example/a.png',
            'https://files.example/first.png',
            'https://files.example/last.png'
          ],
          resultJson,
          failCode: '',
          creditsConsumed: 1.25
        })
      )
    })
  )

  it.effect('returns a failed task as a successful read with its failure detail', () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        response({
          code: 200,
          msg: 'success',
          data: { taskId: 'task_2', state: 'fail', failCode: '500', failMsg: 'Bad input image' }
        })
      ])

      const result = yield* kieGetTaskAction
        .execute({ integration, input: { taskId: 'task_2' } })
        .pipe(Effect.provide(harness.layer))

      expect(result).toMatchObject({
        _tag: 'Success',
        value: { state: 'fail', resultUrls: [], failCode: '500', failMsg: 'Bad input image' }
      })
    })
  )
})
