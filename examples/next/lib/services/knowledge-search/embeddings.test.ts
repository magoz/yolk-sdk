import { ConfigProvider, Effect, Fiber, Layer, Predicate, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { makeOpenAiKnowledgeEmbedderLayer } from './live-layer'

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: 'test-embedding-key' } })
)

const responseLayer = (body: string, onRequest: () => void = () => {}) =>
  makeOpenAiKnowledgeEmbedderLayer(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(request =>
        Effect.sync(() => {
          onRequest()

          return HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { 'content-type': 'application/json' } })
          )
        })
      )
    )
  )

describe('OpenAI knowledge embeddings', () => {
  it.effect('retries the same submitted batch after a transient provider failure', () => {
    const texts = ['first', 'second']
    const requests: Array<string> = []
    const embedding = Array.from({ length: 1536 }, () => 0.5)

    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(request =>
        Effect.sync(() => {
          if (!Predicate.isTagged(request.body, 'Uint8Array')) {
            throw new Error('Expected a JSON request body')
          }

          requests.push(new TextDecoder().decode(request.body.body))

          if (requests.length === 1) {
            texts.push('later')

            return HttpClientResponse.fromWeb(
              request,
              new Response('rate limited', { status: 429 })
            )
          }

          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                data: [
                  { index: 0, embedding },
                  { index: 1, embedding }
                ]
              })
            )
          )
        })
      )
    )

    return Effect.gen(function* () {
      const embedder = yield* KnowledgeEmbedder
      const fiber = yield* Effect.forkChild(embedder.embedTexts(texts))

      yield* TestClock.adjust('1 second')

      const vectors = yield* Fiber.join(fiber)

      expect(vectors).toEqual([embedding, embedding])
      expect(texts).toEqual(['first', 'second', 'later'])
      expect(requests).toEqual([
        '{"model":"text-embedding-3-small","input":["first","second"]}',
        '{"model":"text-embedding-3-small","input":["first","second"]}'
      ])
    }).pipe(
      Effect.provide(makeOpenAiKnowledgeEmbedderLayer(httpLayer)),
      Effect.provide(configLayer)
    )
  })

  it.effect(
    'validates against the submitted batch when the caller mutates its array in flight',
    () => {
      const texts = ['first', 'second']
      const embedding = Array.from({ length: 1536 }, () => 0.5)

      return Effect.gen(function* () {
        const embedder = yield* KnowledgeEmbedder
        const vectors = yield* embedder.embedTexts(texts)

        expect(texts).toEqual(['first', 'second', 'later'])
        expect(vectors).toEqual([embedding, embedding])
      }).pipe(
        Effect.provide(
          responseLayer(
            JSON.stringify({
              data: [
                { index: 0, embedding },
                { index: 1, embedding }
              ]
            }),
            () => {
              texts.push('later')
            }
          )
        ),
        Effect.provide(configLayer)
      )
    }
  )

  it.effect('does not send an empty batch to the provider', () => {
    let requests = 0

    return Effect.gen(function* () {
      const embedder = yield* KnowledgeEmbedder
      const vectors = yield* embedder.embedTexts([])

      expect(vectors).toEqual([])
      expect(requests).toBe(0)
    }).pipe(
      Effect.provide(
        responseLayer('{"data":[]}', () => {
          requests += 1
        })
      ),
      Effect.provide(configLayer)
    )
  })

  it.effect('rejects vectors incompatible with the 1536-dimension finite search index', () =>
    Effect.gen(function* () {
      const invalidBodies = [
        ...[0, 1535, 1537].map(length =>
          JSON.stringify({
            data: [{ index: 0, embedding: Array.from({ length }, () => 0.5) }]
          })
        ),
        `{"data":[{"index":0,"embedding":[1e999,${Array.from({ length: 1535 }, () => '0.5').join(',')}]}]}`
      ]

      for (const body of invalidBodies) {
        let requests = 0

        const result = yield* Effect.gen(function* () {
          const embedder = yield* KnowledgeEmbedder

          return yield* embedder.embedQuery('query')
        }).pipe(
          Effect.provide(
            responseLayer(body, () => {
              requests += 1
            })
          ),
          Effect.result
        )

        if (!Result.isFailure(result)) {
          expect.fail('Expected incompatible embedding vector to fail')
        }

        expect(Predicate.isTagged(result.failure, 'KnowledgeEmbeddingError')).toBe(true)
        expect(result.failure.message).toBe('Invalid OpenAI embeddings response')
        expect(requests).toBe(1)
      }
    }).pipe(Effect.provide(configLayer))
  )

  it.effect('rejects duplicate, negative, and out-of-range response indices', () =>
    Effect.gen(function* () {
      const embedding = Array.from({ length: 1536 }, () => 0.5)

      for (const indices of [
        [0, 0],
        [-1, 1],
        [0, 2]
      ]) {
        const result = yield* Effect.gen(function* () {
          const embedder = yield* KnowledgeEmbedder

          return yield* embedder.embedTexts(['first', 'second'])
        }).pipe(
          Effect.provide(
            responseLayer(
              JSON.stringify({
                data: indices.map(index => ({ index, embedding }))
              })
            )
          ),
          Effect.result
        )

        if (!Result.isFailure(result)) {
          expect.fail(`Expected invalid response indices ${indices} to fail`)
        }

        expect(Predicate.isTagged(result.failure, 'KnowledgeEmbeddingError')).toBe(true)
        expect(result.failure.message).toBe(
          'OpenAI embeddings response indices do not match inputs'
        )
      }
    }).pipe(Effect.provide(configLayer))
  )

  it.effect('fails a query with a missing embedding instead of returning an empty vector', () =>
    Effect.gen(function* () {
      const embedder = yield* KnowledgeEmbedder
      const result = yield* embedder.embedQuery('query').pipe(Effect.result)

      if (!Result.isFailure(result)) {
        expect.fail('Expected missing query embedding to fail')
      }

      expect(Predicate.isTagged(result.failure, 'KnowledgeEmbeddingError')).toBe(true)
      expect(result.failure.message).toBe(
        'OpenAI embeddings response count does not match input count'
      )
    }).pipe(Effect.provide(responseLayer('{"data":[]}')), Effect.provide(configLayer))
  )

  it.effect('matches vectors to input texts by response index rather than response order', () => {
    const first = Array.from({ length: 1536 }, () => 0.25)
    const second = Array.from({ length: 1536 }, () => 0.75)

    return Effect.gen(function* () {
      const embedder = yield* KnowledgeEmbedder
      const vectors = yield* embedder.embedTexts(['first document', 'second document'])

      expect(vectors).toEqual([first, second])
    }).pipe(
      Effect.provide(
        responseLayer(
          JSON.stringify({
            data: [
              { index: 1, embedding: second },
              { index: 0, embedding: first }
            ]
          })
        )
      ),
      Effect.provide(configLayer)
    )
  })
})
