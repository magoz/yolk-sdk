import type * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'
import {
  GatewayEmulatorInputInvalid,
  emulatorEvidenceHeader,
  gatewayEmulatorRoutes,
  makeGatewayEmulator,
  type GatewayEmulator,
  type GatewayFault,
  type GatewayScriptedTurn
} from '../src/gateway.ts'
import { EmulatorRouteUnmapped, bindRouteHandlers } from '../src/route-evidence.ts'

const base = 'https://ai-gateway.vercel.sh'

const completionsUrl = `${base}/v1/chat/completions`

const syntheticKey = 'synthetic-gateway-key'

/** The chat request fields these tests send (a subset of the OpenAI-compatible request). */
type ChatBody = {
  readonly model?: string
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly stream?: boolean
  readonly stream_options?: { readonly include_usage: boolean } | undefined
  readonly reasoning_effort?: string
  readonly thinking?: { readonly type: string }
  readonly tools?: ReadonlyArray<{
    readonly type: 'function'
    readonly function: { readonly name: string; readonly parameters?: Schema.Json }
  }>
}

const chat = (
  emulator: GatewayEmulator,
  body: ChatBody,
  headers: Record<string, string> = { authorization: `Bearer ${syntheticKey}` }
) =>
  emulator.fetch(
    new Request(completionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )

const plainRequest = (overrides: ChatBody = {}) => ({
  model: 'openai/gpt-4.1-nano',
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
  stream_options: { include_usage: true },
  ...overrides
})

type ToolCallDelta = {
  readonly index: number
  readonly id?: string
  readonly type?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

type Delta = {
  readonly role?: string
  readonly content?: string | null
  readonly reasoning_content?: string
  readonly reasoning?: string
  readonly tool_calls?: ReadonlyArray<ToolCallDelta>
}

type ChunkPayload = {
  readonly object: string
  readonly choices: ReadonlyArray<{ readonly delta: Delta; readonly finish_reason: string | null }>
  readonly usage?: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly completion_tokens_details?: { readonly reasoning_tokens: number }
  }
}

type SseEvent = { readonly done: true } | { readonly done: false; readonly data: ChunkPayload }

const parsePayload = (data: string): ChunkPayload => JSON.parse(data)

/** Parse a complete SSE body into data payloads (`[DONE]` as `{ done: true }`). */
const sseEvents = (text: string): ReadonlyArray<SseEvent> =>
  text
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => block.slice('data: '.length))
    .map(data => (data === '[DONE]' ? { done: true } : { done: false, data: parsePayload(data) }))

const finishReasons = (events: ReadonlyArray<SseEvent>) =>
  payloads(events).flatMap(payload => payload.choices.map(choice => choice.finish_reason))

const payloads = (events: ReadonlyArray<SseEvent>) =>
  events.flatMap(event => (event.done ? [] : [event.data]))

const deltas = (events: ReadonlyArray<SseEvent>) =>
  payloads(events).flatMap(payload => payload.choices.map(choice => choice.delta))

const bodyReader = (response: Response) => {
  if (response.body === null) {
    throw new Error('expected a response body')
  }

  return response.body.getReader()
}

const control = (emulator: GatewayEmulator, method: string, path: string, body?: Schema.Json) => {
  const init: RequestInit = { method }

  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  return emulator.fetch(new Request(`${base}${path}`, init))
}

describe('gateway emulator defaults', () => {
  it('streams chat.completion.chunk text deltas, a stop finish, usage, and [DONE]', async () => {
    const emulator = makeGatewayEmulator()
    const response = await chat(emulator, plainRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')

    const events = sseEvents(await response.text())
    const all = payloads(events)
    const text = deltas(events).flatMap(delta => (delta.content ? [delta.content] : []))

    expect(all.every(payload => payload.object === 'chat.completion.chunk')).toBe(true)
    expect(text.length).toBeGreaterThan(1)
    expect(text.join('')).toBe('Hello from the synthetic gateway.')
    expect(finishReasons(events)).toContain('stop')

    const usage = all.at(-1)

    expect(usage?.choices).toEqual([])
    expect(usage?.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number)
    })
    expect(events.at(-1)).toEqual({ done: true })
  })

  it('omits the usage chunk unless stream_options.include_usage is set', async () => {
    const emulator = makeGatewayEmulator()

    const events = sseEvents(
      await (await chat(emulator, plainRequest({ stream_options: undefined }))).text()
    )

    expect(payloads(events).some(payload => payload.usage !== undefined)).toBe(false)
    expect(events.at(-1)).toEqual({ done: true })
  })

  it('sends reasoning_content deltas before text for reasoning models that ask for reasoning', async () => {
    const emulator = makeGatewayEmulator()

    for (const reasoningFields of [
      { reasoning_effort: 'high' },
      { thinking: { type: 'enabled' } }
    ]) {
      const events = sseEvents(
        await (
          await chat(
            emulator,
            plainRequest({ model: 'deepseek/deepseek-v3.2', ...reasoningFields })
          )
        ).text()
      )

      const kinds = deltas(events).flatMap(delta =>
        delta.reasoning_content ? ['reasoning'] : delta.content ? ['text'] : []
      )

      expect(kinds.filter(kind => kind === 'reasoning').length).toBeGreaterThan(0)
      expect(kinds.lastIndexOf('reasoning')).toBeLessThan(kinds.indexOf('text'))
      expect(
        payloads(events).at(-1)?.usage?.completion_tokens_details?.reasoning_tokens
      ).toBeGreaterThan(0)
    }

    for (const request of [
      plainRequest({ model: 'deepseek/deepseek-v3.2' }),
      plainRequest({ model: 'deepseek/deepseek-v3.2', thinking: { type: 'disabled' } }),
      plainRequest({ reasoning_effort: 'high' })
    ]) {
      const events = sseEvents(await (await chat(emulator, request)).text())

      expect(deltas(events).some(delta => delta.reasoning_content !== undefined)).toBe(false)
    }
  })

  it('returns one tool call with schema-synthesized arguments streamed in fragments', async () => {
    const emulator = makeGatewayEmulator()

    const response = await chat(
      emulator,
      plainRequest({
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
                  days: { type: 'integer', minimum: 2 },
                  note: { type: 'string' }
                },
                required: ['city', 'unit', 'days'],
                additionalProperties: false
              }
            }
          },
          { type: 'function', function: { name: 'other_tool' } }
        ]
      })
    )

    const events = sseEvents(await response.text())
    const toolDeltas = deltas(events).flatMap(delta => delta.tool_calls ?? [])

    const fragments = toolDeltas.flatMap(call =>
      call.function?.arguments ? [call.function.arguments] : []
    )

    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      type: 'function',
      function: { name: 'lookup_weather' }
    })
    expect(toolDeltas.every(call => call.index === 0)).toBe(true)
    expect(fragments.length).toBeGreaterThan(1)

    const args: { readonly city: string } = JSON.parse(fragments.join(''))

    expect(args).toEqual({ city: expect.any(String), unit: 'celsius', days: 2 })
    expect(args.city.length).toBeGreaterThan(0)
    expect(finishReasons(events)).toContain('tool_calls')
    expect(deltas(events).some(delta => delta.content)).toBe(false)
  })

  it('returns the JSON completion shape for stream: false', async () => {
    const emulator = makeGatewayEmulator()

    const response = await chat(
      emulator,
      plainRequest({ stream: false, model: 'deepseek/deepseek-v3.2', reasoning_effort: 'low' })
    )

    expect(response.headers.get('content-type')).toBe('application/json')

    const body = await response.json()

    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'deepseek/deepseek-v3.2',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Hello from the synthetic gateway.',
            reasoning_content: expect.any(String)
          }
        }
      ],
      usage: { prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) }
    })
  })

  it('rejects unknown models with the Gateway error envelope', async () => {
    const emulator = makeGatewayEmulator({ knownModels: ['example/model-a'] })

    for (const model of ['yolk-conformance/model-does-not-exist', 'openai/gpt-4.1-nano']) {
      const response = await chat(emulator, plainRequest({ model }))

      expect(response.status).toBe(400)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          code: 'model_not_found'
        }
      })
    }
  })

  it('requires a non-empty bearer credential and never records it', async () => {
    const emulator = makeGatewayEmulator()

    const rejected: ReadonlyArray<Record<string, string>> = [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Basic abc' }
    ]

    for (const headers of rejected) {
      const response = await chat(emulator, plainRequest(), headers)

      expect(response.status).toBe(401)
      expect((await response.json()).error.type).toBe('authentication_error')
    }

    expect(
      (await chat(emulator, plainRequest(), { authorization: 'Bearer anything-at-all' })).status
    ).toBe(200)
    expect(JSON.stringify(emulator.ledger.entries())).not.toContain('anything-at-all')
    expect(JSON.stringify(emulator.ledger.entries()).toLowerCase()).not.toContain('authorization')
  })

  it('fails closed on unknown routes with a 404 JSON error written to the ledger', async () => {
    const emulator = makeGatewayEmulator()
    const response = await emulator.fetch(new Request(`${base}/v1/embeddings`, { method: 'POST' }))
    const wrongMethod = await emulator.fetch(new Request(completionsUrl))

    expect(response.status).toBe(404)
    expect(wrongMethod.status).toBe(404)
    expect((await response.json()).error.code).toBe('not_found')
    expect(
      emulator.ledger
        .entries()
        .map(entry => [entry.method, entry.path, entry.evidence, entry.status])
    ).toEqual([
      ['POST', '/v1/embeddings', 'unknown-route', 404],
      ['GET', '/v1/chat/completions', 'unknown-route', 404]
    ])
  })

  it('rejects bodies that are not JSON chat requests', async () => {
    const emulator = makeGatewayEmulator()

    const notJson = await emulator.fetch(
      new Request(completionsUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${syntheticKey}` },
        body: '{not json'
      })
    )

    expect(notJson.status).toBe(400)
    expect((await chat(emulator, { model: 'openai/gpt-4.1-nano' })).status).toBe(400)
  })
})

describe('gateway emulator ledger', () => {
  it('records method, path, parsed body, model, stream, reasoning, tools, evidence, and status', async () => {
    const emulator = makeGatewayEmulator()

    await (
      await chat(
        emulator,
        plainRequest({
          model: 'deepseek/deepseek-v3.2',
          reasoning_effort: 'high',
          thinking: { type: 'enabled' },
          tools: [{ type: 'function', function: { name: 'lookup_weather' } }]
        })
      )
    ).text()

    const [entry] = emulator.ledger.entries()

    expect(entry).toMatchObject({
      seq: 1,
      method: 'POST',
      path: '/v1/chat/completions',
      model: 'deepseek/deepseek-v3.2',
      stream: true,
      reasoningEffort: 'high',
      thinking: { type: 'enabled' },
      toolNames: ['lookup_weather'],
      evidence: 'unverified',
      status: 200
    })
    expect(entry?.body).toMatchObject({ model: 'deepseek/deepseek-v3.2', stream: true })
    expect(entry?.bodyChunks).toBeGreaterThan(1)
    expect(entry?.fault).toBeUndefined()
  })

  it('produces each body chunk only when pulled', async () => {
    const emulator = makeGatewayEmulator()
    const response = await chat(emulator, plainRequest())
    const reader = bodyReader(response)

    expect(emulator.ledger.entries()[0]?.bodyChunks).toBe(0)

    await reader.read()

    expect(emulator.ledger.entries()[0]?.bodyChunks).toBe(1)

    await reader.cancel()
  })
})

describe('gateway emulator scripted turns', () => {
  it('answers the next request with a scripted completion, exactly as scripted', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      text: ['A', 'B'],
      reasoning: ['think'],
      order: 'text-first',
      usage: null,
      finishReason: 'stop'
    })

    expect(emulator.script.pending()).toBe(1)

    const events = sseEvents(await (await chat(emulator, plainRequest())).text())

    const kinds = deltas(events).flatMap(delta =>
      delta.reasoning_content ? ['reasoning'] : delta.content ? ['text'] : []
    )

    expect(kinds).toEqual(['text', 'text', 'reasoning'])
    expect(payloads(events).some(payload => payload.usage !== undefined)).toBe(false)
    expect(emulator.script.pending()).toBe(0)
    expect(emulator.ledger.entries()[0]?.scripted).toBe('completion')

    // The queue is drained, so the next request gets the defaults again.
    const next = sseEvents(await (await chat(emulator, plainRequest())).text())

    expect(payloads(next).at(-1)?.usage).toBeDefined()
  })

  it('streams scripted tool-call fragments as given', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      toolCalls: [{ name: 'lookup_weather', argumentFragments: ['{"ci', 'ty":"Spri', 'ngfield"}'] }]
    })

    const events = sseEvents(await (await chat(emulator, plainRequest())).text())

    const fragments = deltas(events)
      .flatMap(delta => delta.tool_calls ?? [])
      .flatMap(call => (call.function?.arguments ? [call.function.arguments] : []))

    expect(fragments).toEqual(['{"ci', 'ty":"Spri', 'ngfield"}'])
    expect(finishReasons(events)).toContain('tool_calls')
  })

  it('answers with a scripted error, even for an unknown model', async () => {
    const emulator = makeGatewayEmulator()

    emulator.script.enqueue({
      error: {
        status: 503,
        body: { error: { message: 'down', type: 'api_error' } },
        headers: { 'retry-after': '1' }
      }
    })

    const response = await chat(emulator, plainRequest({ model: 'example/unknown' }))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({ error: { message: 'down', type: 'api_error' } })
    expect(emulator.ledger.entries()[0]?.scripted).toBe('error')
  })

  it('throws for an invalid turn', () => {
    const emulator = makeGatewayEmulator()

    expect(() => emulator.script.enqueue({ error: { status: 42, body: 'x' } })).toThrow(
      GatewayEmulatorInputInvalid
    )
  })
})

describe('gateway emulator faults', () => {
  it('answers a status fault with headers, a default envelope, and a count', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'status', status: 429, headers: { 'retry-after': '2' }, count: 1 })

    const limited = await chat(emulator, plainRequest())

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    expect((await limited.json()).error.code).toBe('rate_limit_exceeded')
    expect((await chat(emulator, plainRequest())).status).toBe(200)
    expect(emulator.faults.list()[0]).toMatchObject({ remaining: 0, applied: 1 })
    expect(emulator.ledger.entries().map(entry => entry.fault)).toEqual(['status', undefined])
  })

  it('matches faults by path and model', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({
      kind: 'status',
      status: 500,
      match: { model: 'deepseek/deepseek-v3.2', path: '/v1/*' }
    })

    expect((await chat(emulator, plainRequest())).status).toBe(200)
    expect((await chat(emulator, plainRequest({ model: 'deepseek/deepseek-v3.2' }))).status).toBe(
      500
    )
  })

  it('errors the body stream after N chunks', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'error-after-chunks', chunks: 2 })

    const response = await chat(emulator, plainRequest())
    const reader = bodyReader(response)

    expect((await reader.read()).done).toBe(false)
    expect((await reader.read()).done).toBe(false)
    await expect(reader.read()).rejects.toThrow('synthetic mid-stream failure')
    expect(emulator.ledger.entries()[0]).toMatchObject({
      fault: 'error-after-chunks',
      bodyChunks: 2
    })
  })

  it('truncates cleanly after N chunks without [DONE]', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'truncate-after-chunks', chunks: 3 })

    const events = sseEvents(await (await chat(emulator, plainRequest())).text())

    expect(events.length).toBe(3)
    expect(events.some(event => event.done)).toBe(false)
  })

  it('answers 500 instead of silently ignoring a chunk fault that cannot apply', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'truncate-after-chunks', chunks: 99, count: 1 })

    const response = await chat(emulator, plainRequest())

    expect(response.status).toBe(500)
    expect(emulator.ledger.entries()[0]).toMatchObject({
      status: 500,
      faultError: expect.any(String)
    })
    expect(emulator.ledger.entries()[0]?.fault).toBeUndefined()
    expect(emulator.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
  })

  it('throws for an invalid fault', () => {
    const emulator = makeGatewayEmulator()

    expect(() => emulator.faults.add({ kind: 'error-after-chunks', chunks: -1 })).toThrow(
      GatewayEmulatorInputInvalid
    )
  })

  it('rejects statuses that cannot carry a body, and redirects, for faults and turns', () => {
    const emulator = makeGatewayEmulator()

    for (const status of [101, 204, 205, 301, 302, 304, 307, 308]) {
      expect(() => emulator.faults.add({ kind: 'status', status }), String(status)).toThrow(
        GatewayEmulatorInputInvalid
      )
      expect(
        () => emulator.script.enqueue({ error: { status, body: 'x' } }),
        String(status)
      ).toThrow(GatewayEmulatorInputInvalid)
    }

    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)

    for (const status of [200, 206, 400, 429, 503]) {
      expect(() => emulator.faults.add({ kind: 'status', status, count: 1 })).not.toThrow()
    }
  })

  it('rejects location headers and invalid header names or values, for faults and turns', () => {
    const emulator = makeGatewayEmulator()

    const invalidHeaders: ReadonlyArray<Record<string, string>> = [
      { location: 'http://127.0.0.1:1/elsewhere' },
      { Location: '/relative' },
      { 'bad header': 'x' },
      { '': 'x' },
      { 'x-split': 'a\r\nset-cookie: injected=1' },
      { 'x-control': 'a\u0001b' },
      { 'x-wide': 'snowman \u2603' }
    ]

    for (const headers of invalidHeaders) {
      const label = JSON.stringify(headers)

      expect(() => emulator.faults.add({ kind: 'status', status: 429, headers }), label).toThrow(
        GatewayEmulatorInputInvalid
      )
      expect(
        () => emulator.script.enqueue({ error: { status: 503, body: 'x', headers } }),
        label
      ).toThrow(GatewayEmulatorInputInvalid)
    }

    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)
  })

  it('rejects bodyless and redirect faults through the control plane', async () => {
    const emulator = makeGatewayEmulator()

    const rejected: ReadonlyArray<Schema.Json> = [
      { kind: 'status', status: 204 },
      { kind: 'status', status: 429, headers: { location: 'http://127.0.0.1:1/' } }
    ]

    for (const fault of rejected) {
      expect((await control(emulator, 'POST', '/_emulate/faults', fault)).status).toBe(400)
    }

    expect(
      (
        await control(emulator, 'POST', '/_emulate/script', {
          error: { status: 302, body: 'x' }
        })
      ).status
    ).toBe(400)
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)
  })
})

/**
 * Run `body` while `new Response(..., { status })` throws for one status, standing in for any
 * response the emulator cannot build.
 */
const withUnbuildableStatus = async <A>(status: number, body: () => Promise<A>): Promise<A> => {
  const RealResponse = globalThis.Response

  class UnbuildableResponse extends RealResponse {
    constructor(bodyInit?: BodyInit | null, init?: ResponseInit) {
      if (init?.status === status) {
        throw new TypeError(`synthetic: cannot build a ${status} response`)
      }

      super(bodyInit, init)
    }
  }

  vi.stubGlobal('Response', UnbuildableResponse)

  try {
    return await body()
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('gateway emulator error recovery', () => {
  const recoveryCases: ReadonlyArray<{
    readonly name: string
    readonly fault: GatewayFault
    readonly turn?: GatewayScriptedTurn
  }> = [
    { name: 'a status fault', fault: { kind: 'status', status: 503, count: 1 } },
    {
      name: 'a chunk fault on a scripted error',
      fault: { kind: 'truncate-after-chunks', chunks: 0, count: 1 },
      turn: { error: { status: 503, body: 'down' } }
    }
  ]

  for (const { name, fault, turn } of recoveryCases) {
    it(`answers a tagged, ledgered 500 and keeps ${name} when its response cannot be built`, async () => {
      const emulator = makeGatewayEmulator()

      emulator.faults.add(fault)

      if (turn !== undefined) emulator.script.enqueue(turn)

      const response = await withUnbuildableStatus(503, () => chat(emulator, plainRequest()))

      expect(response.status).toBe(500)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect((await response.json()).error.type).toBe('emulator_error')

      const [entry] = emulator.ledger.entries()

      expect(entry).toMatchObject({
        status: 500,
        evidence: 'unverified',
        responseError: expect.any(String)
      })
      expect(entry?.fault).toBeUndefined()
      expect(emulator.faults.list()[0]).toMatchObject({ remaining: 1, applied: 0 })
    })
  }

  it('the kept status fault applies to the next request once its response can be built', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'status', status: 503, count: 1 })

    await withUnbuildableStatus(503, () => chat(emulator, plainRequest()))

    const next = await chat(emulator, plainRequest())

    expect(next.status).toBe(503)
    expect(emulator.ledger.entries().map(entry => [entry.status, entry.fault])).toEqual([
      [500, undefined],
      [503, 'status']
    ])
    expect(emulator.faults.list()[0]).toMatchObject({ remaining: 0, applied: 1 })
  })
})

describe('gateway emulator control plane', () => {
  it('reads and clears the ledger', async () => {
    const emulator = makeGatewayEmulator()

    await (await chat(emulator, plainRequest())).text()

    const ledger = await (await control(emulator, 'GET', '/_emulate/ledger')).json()

    expect(ledger.entries).toHaveLength(1)
    expect(await (await control(emulator, 'DELETE', '/_emulate/ledger')).json()).toEqual({
      cleared: 1
    })
    expect(emulator.ledger.entries()).toEqual([])
  })

  it('lists, adds, and clears faults', async () => {
    const emulator = makeGatewayEmulator()

    const added = await control(emulator, 'POST', '/_emulate/faults', {
      faults: [
        { kind: 'status', status: 429, headers: { 'retry-after': '1' } },
        { kind: 'truncate-after-chunks', chunks: 1 }
      ]
    })

    expect(added.status).toBe(201)
    expect(
      (await added.json()).faults.map(
        (state: { readonly fault: { readonly kind: string } }) => state.fault.kind
      )
    ).toEqual(['status', 'truncate-after-chunks'])

    const single = await control(emulator, 'POST', '/_emulate/faults', {
      kind: 'error-after-chunks',
      chunks: 1
    })

    expect(single.status).toBe(201)
    expect((await (await control(emulator, 'GET', '/_emulate/faults')).json()).faults).toHaveLength(
      3
    )

    const invalid = await control(emulator, 'POST', '/_emulate/faults', { kind: 'nope' })

    expect(invalid.status).toBe(400)
    expect(await (await control(emulator, 'DELETE', '/_emulate/faults')).json()).toEqual({
      cleared: 3
    })
    expect(emulator.faults.list()).toEqual([])
  })

  it('queues scripted turns', async () => {
    const emulator = makeGatewayEmulator()

    const single = await control(emulator, 'POST', '/_emulate/script', { text: ['x'] })

    const many = await control(emulator, 'POST', '/_emulate/script', {
      turns: [{ text: ['y'] }, { error: { status: 500, body: 'boom' } }]
    })

    expect(await single.json()).toEqual({ pending: 1 })
    expect(await many.json()).toEqual({ pending: 3 })
    expect(
      (await control(emulator, 'POST', '/_emulate/script', { turns: [{ error: { status: 1 } }] }))
        .status
    ).toBe(400)
  })

  it('reports state and coverage, and resets everything', async () => {
    const emulator = makeGatewayEmulator()

    emulator.faults.add({ kind: 'status', status: 500, match: { model: 'example/none' } })
    emulator.script.enqueue({ text: ['x'] })
    await (await chat(emulator, plainRequest())).text()
    await emulator.fetch(new Request(`${base}/v1/unknown`))

    const state = await (await control(emulator, 'GET', '/_emulate/state')).json()

    expect(state).toMatchObject({
      pendingTurns: 0,
      ledgerEntries: 2,
      knownModels: expect.arrayContaining(['openai/gpt-4.1-nano'])
    })
    expect(state.faults).toHaveLength(1)

    const coverage = await (await control(emulator, 'GET', '/_emulate/coverage')).json()

    expect(coverage).toEqual({
      routes: [{ ...gatewayEmulatorRoutes[0], observedAt: undefined, requests: 1 }].map(route =>
        JSON.parse(JSON.stringify(route))
      ),
      unknownRouteRequests: 1
    })

    expect(await (await control(emulator, 'POST', '/_emulate/reset')).json()).toEqual({
      reset: true
    })
    expect(emulator.ledger.entries()).toEqual([])
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)
  })

  it('rejects wrong methods and unknown control routes without touching the ledger', async () => {
    const emulator = makeGatewayEmulator()

    const wrong = await control(emulator, 'PUT', '/_emulate/ledger')

    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET, DELETE')
    expect((await control(emulator, 'GET', '/_emulate/unknown')).status).toBe(404)
    expect(emulator.ledger.entries()).toEqual([])
  })
})

describe('route handler binding', () => {
  const manifestRoute = gatewayEmulatorRoutes[0]

  it('maps every Gateway manifest route to its own handler', () => {
    expect(() => makeGatewayEmulator()).not.toThrow()
  })

  it('throws when a manifest route has no handler', () => {
    if (manifestRoute === undefined) throw new Error('expected a Gateway manifest route')

    const unmapped = { ...manifestRoute, path: '/v1/embeddings' }

    expect(() =>
      bindRouteHandlers(
        [manifestRoute, unmapped],
        new Map([['POST /v1/chat/completions', 'chat-handler']])
      )
    ).toThrow(EmulatorRouteUnmapped)
    expect(() => bindRouteHandlers([unmapped], new Map())).toThrow(
      'Emulator manifest route POST /v1/embeddings has no handler'
    )
  })

  it('throws when a handler has no manifest route', () => {
    expect(() =>
      bindRouteHandlers([], new Map([['POST /v1/embeddings', 'orphan-handler']]))
    ).toThrow('Emulator handler POST /v1/embeddings has no manifest route')
  })

  it('pairs each manifest route with the handler under its own key', () => {
    if (manifestRoute === undefined) throw new Error('expected a Gateway manifest route')

    const second = { ...manifestRoute, method: 'get', path: '/v1/models' }

    expect(
      bindRouteHandlers(
        [manifestRoute, second],
        new Map([
          ['GET /v1/models', 'models-handler'],
          ['POST /v1/chat/completions', 'chat-handler']
        ])
      ).map(bound => bound.handler)
    ).toEqual(['chat-handler', 'models-handler'])
  })
})

describe('gatewayEmulatorRoutes', () => {
  it('lists the chat completions route as unverified provider evidence for the Gateway cases', () => {
    expect(gatewayEmulatorRoutes).toEqual([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        kind: 'provider',
        write: false,
        caseIds: [
          'vercel-ai-gateway.stream.plain-text',
          'vercel-ai-gateway.stream.deepseek-reasoning',
          'vercel-ai-gateway.stream.tool-call-deltas',
          'vercel-ai-gateway.stream.error-envelope'
        ],
        evidence: 'unverified',
        observedAt: undefined
      }
    ])
  })
})
