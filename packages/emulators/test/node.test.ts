import { Deferred, Effect, Exit, Scope } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { EmulatorServeError, serveFetchHandler, startFetchHandlerServer } from '../src/node.ts'

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const echo = async (request: Request) =>
  new Response(
    JSON.stringify({
      method: request.method,
      url: request.url,
      probe: request.headers.get('x-probe'),
      body: await request.text()
    }),
    { status: 202, headers: { 'content-type': 'application/json', 'x-served': 'yes' } }
  )

describe('serveFetchHandler', () => {
  it.effect('serves on 127.0.0.1 with method, path, query, headers, and body', () =>
    Effect.gen(function* () {
      const server = yield* serveFetchHandler(echo)

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const response = yield* Effect.promise(() =>
        fetch(`${server.url}/v1/items?a=1`, {
          method: 'POST',
          headers: { 'x-probe': 'value' },
          body: 'payload'
        })
      )

      expect(response.status).toBe(202)
      expect(response.headers.get('x-served')).toBe('yes')
      expect(yield* Effect.promise(() => response.json())).toEqual({
        method: 'POST',
        url: `${server.url}/v1/items?a=1`,
        probe: 'value',
        body: 'payload'
      })
    }).pipe(Effect.scoped)
  )

  it.effect('refuses any host other than 127.0.0.1 and invalid ports', () =>
    Effect.gen(function* () {
      for (const options of [{ host: '0.0.0.0' }, { host: 'localhost' }, { host: '::1' }]) {
        const error = yield* serveFetchHandler(echo, options).pipe(Effect.scoped, Effect.flip)

        expect(error).toBeInstanceOf(EmulatorServeError)
        expect(error.reason).toBe('host-not-allowed')
      }

      for (const port of [-1, 70000, 1.5]) {
        const error = yield* serveFetchHandler(echo, { port }).pipe(Effect.scoped, Effect.flip)

        expect(error.reason).toBe('invalid-port')
      }
    })
  )

  it.effect('flushes streamed bodies chunk by chunk', () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()

      const handler = () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: async controller => {
                controller.enqueue(encoder.encode('data: first\n\n'))
                // The second chunk exists only after the client has seen the first.
                await Effect.runPromise(Deferred.await(release))
                controller.enqueue(encoder.encode('data: second\n\n'))
                controller.close()
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        )

      const server = yield* serveFetchHandler(handler)
      const response = yield* Effect.promise(() => fetch(server.url))
      const reader = response.body?.getReader()

      expect(reader).toBeDefined()

      if (reader === undefined) return

      const first = yield* Effect.promise(() => reader.read())

      expect(decoder.decode(first.value)).toBe('data: first\n\n')

      yield* Deferred.succeed(release, undefined)

      const second = yield* Effect.promise(() => reader.read())

      expect(decoder.decode(second.value)).toBe('data: second\n\n')
      expect((yield* Effect.promise(() => reader.read())).done).toBe(true)
    }).pipe(Effect.scoped)
  )

  it.effect('drops the connection when the body stream errors mid-response', () =>
    Effect.gen(function* () {
      const handler = () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: controller => {
                controller.enqueue(encoder.encode('data: partial\n\n'))
                controller.error(new Error('synthetic failure'))
              }
            })
          )
        )

      const server = yield* serveFetchHandler(handler)

      const exit = yield* Effect.tryPromise(() =>
        fetch(server.url).then(response => response.text())
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.scoped)
  )

  it.effect('answers 500 when the handler rejects', () =>
    Effect.gen(function* () {
      const server = yield* serveFetchHandler(() => Promise.reject(new Error('boom')))
      const response = yield* Effect.promise(() => fetch(server.url))

      expect(response.status).toBe(500)
      yield* Effect.promise(() => response.text())
    }).pipe(Effect.scoped)
  )

  it.effect('closes the server when the scope closes, and close is idempotent', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const server = yield* serveFetchHandler(echo).pipe(Scope.provide(scope))

      yield* server.close
      yield* server.close
      yield* Scope.close(scope, Exit.void)

      const exit = yield* Effect.tryPromise(() => fetch(server.url)).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    })
  )
})

describe('startFetchHandlerServer', () => {
  it('serves on 127.0.0.1 and rejects other hosts', async () => {
    const server = await startFetchHandlerServer(echo, { port: 0 })

    try {
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true)
      expect((await fetch(server.url)).status).toBe(202)
    } finally {
      await server.close()
    }

    await expect(startFetchHandlerServer(echo, { host: '0.0.0.0' })).rejects.toBeInstanceOf(
      EmulatorServeError
    )
  })
})
