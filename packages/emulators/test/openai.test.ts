import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { openAiChatUnsupportedParameterFixture } from '@yolk-sdk/agent/providers/openai/conformance'
import {
  OpenAiEmulatorInputInvalid,
  emulatorEvidenceHeader,
  makeOpenAiEmulator,
  openAiEmulatorDefaultModels,
  openAiEmulatorDefaultReasoningModels,
  openAiEmulatorRoutes,
  type OpenAiEmulator,
  type OpenAiScriptedTurn
} from '../src/openai.ts'

const base = 'https://api.openai.com'

const completionsUrl = `${base}/v1/chat/completions`

/** The chat request fields these tests send (a subset of the Chat Completions request). */
type ChatBody = {
  readonly model?: string
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly stream?: boolean
  readonly stream_options?: { readonly include_usage: boolean } | undefined
  readonly max_completion_tokens?: number
  readonly max_tokens?: number | null
  readonly reasoning_effort?: string | null
  readonly temperature?: number
  readonly top_p?: number
  readonly logprobs?: boolean
  readonly top_logprobs?: number
  readonly tools?: ReadonlyArray<{
    readonly type: 'function'
    readonly function: { readonly name: string; readonly parameters?: Schema.Json }
  }>
  readonly tool_choice?: Schema.Json
  readonly parallel_tool_calls?: boolean
}

const chat = (
  emulator: OpenAiEmulator,
  body: ChatBody,
  headers: Record<string, string> = { authorization: 'Bearer synthetic-openai-key' }
) =>
  emulator.fetch(
    new Request(completionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )

const plainRequest = (overrides: ChatBody = {}): ChatBody => ({
  model: 'gpt-4.1-nano',
  messages: [{ role: 'user', content: 'Say hello.' }],
  max_completion_tokens: 64,
  stream: true,
  stream_options: { include_usage: true },
  ...overrides
})

const control = (emulator: OpenAiEmulator, method: string, path: string, body?: Schema.Json) => {
  const init: RequestInit = { method }

  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  return emulator.fetch(new Request(`${base}${path}`, init))
}

type Delta = {
  readonly content?: string | null
  readonly reasoning_content?: string
  readonly reasoning?: string
  readonly tool_calls?: ReadonlyArray<{
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }>
}

type Usage = {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
  readonly completion_tokens_details?: { readonly reasoning_tokens: number }
}

type ChunkPayload = {
  readonly object: string
  readonly id: string
  readonly choices: ReadonlyArray<{ readonly delta: Delta; readonly finish_reason: string | null }>
  readonly usage?: Usage
}

type SseEvent = { readonly done: true } | { readonly done: false; readonly data: ChunkPayload }

const parsePayload = (data: string): ChunkPayload => JSON.parse(data)

const sseEvents = (text: string): ReadonlyArray<SseEvent> =>
  text
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => block.slice('data: '.length))
    .map(data => (data === '[DONE]' ? { done: true } : { done: false, data: parsePayload(data) }))

const payloads = (events: ReadonlyArray<SseEvent>) =>
  events.flatMap(event => (event.done ? [] : [event.data]))

const deltas = (events: ReadonlyArray<SseEvent>) =>
  payloads(events).flatMap(payload => payload.choices.map(choice => choice.delta))

describe('openai emulator defaults', () => {
  it('streams chat.completion.chunk text deltas, a stop finish, usage, and [DONE]', async () => {
    const emulator = makeOpenAiEmulator()
    const response = await chat(emulator, plainRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')

    const events = sseEvents(await response.text())
    const all = payloads(events)
    const text = deltas(events).flatMap(delta => (delta.content ? [delta.content] : []))

    expect(all.every(payload => payload.object === 'chat.completion.chunk')).toBe(true)
    expect(all.every(payload => payload.id === 'chatcmpl-synthetic-1')).toBe(true)
    expect(text.join('')).toBe('Hello from the synthetic OpenAI emulator.')
    expect(all.flatMap(payload => payload.choices.map(choice => choice.finish_reason))).toContain(
      'stop'
    )
    expect(all.at(-1)?.choices).toEqual([])
    expect(all.at(-1)?.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number)
    })
    expect(events.at(-1)).toEqual({ done: true })
  })

  it('returns one chat.completion JSON body for stream: false', async () => {
    const emulator = makeOpenAiEmulator()
    const response = await chat(emulator, plainRequest({ stream: false }))

    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toMatchObject({
      id: 'chatcmpl-synthetic-1',
      object: 'chat.completion',
      model: 'gpt-4.1-nano',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Hello from the synthetic OpenAI emulator.' }
        }
      ],
      usage: { prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) }
    })
  })

  it('reports no completion_tokens_details for a model that does not reason', async () => {
    const emulator = makeOpenAiEmulator()
    const events = sseEvents(await (await chat(emulator, plainRequest())).text())
    const usage = payloads(events).at(-1)?.usage

    expect(usage).toBeDefined()
    expect(usage).not.toHaveProperty('completion_tokens_details')
  })

  it('streams a schema-synthesized tool call in fragments', async () => {
    const emulator = makeOpenAiEmulator()

    const events = sseEvents(
      await (
        await chat(
          emulator,
          plainRequest({
            tools: [
              {
                type: 'function',
                function: {
                  name: 'lookup_weather',
                  parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city']
                  }
                }
              }
            ]
          })
        )
      ).text()
    )

    const fragments = deltas(events)
      .flatMap(delta => delta.tool_calls ?? [])
      .flatMap(call => (call.function?.arguments ? [call.function.arguments] : []))

    expect(fragments.length).toBeGreaterThan(1)
    expect(JSON.parse(fragments.join(''))).toEqual({ city: expect.any(String) })
  })

  it('answers a forced tool_choice with the named offered tool', async () => {
    const emulator = makeOpenAiEmulator()

    const cityParameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city']
    }

    // The forced tool is offered second, so the default first-tool pick cannot pass this.
    const response = await chat(
      emulator,
      plainRequest({
        tools: [
          { type: 'function', function: { name: 'lookup_time', parameters: cityParameters } },
          { type: 'function', function: { name: 'lookup_weather', parameters: cityParameters } }
        ],
        tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
        parallel_tool_calls: true
      })
    )

    expect(response.status).toBe(200)

    const events = sseEvents(await response.text())

    const names = deltas(events)
      .flatMap(delta => delta.tool_calls ?? [])
      .flatMap(call => (call.function?.name ? [call.function.name] : []))

    expect(names).toEqual(['lookup_weather'])
    expect(
      payloads(events).flatMap(payload => payload.choices.map(choice => choice.finish_reason))
    ).toContain('tool_calls')
  })

  it("answers tool_choice 'none' with text even when tools are offered", async () => {
    const emulator = makeOpenAiEmulator()

    const response = await chat(
      emulator,
      plainRequest({
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } }
            }
          }
        ],
        tool_choice: 'none'
      })
    )

    const events = sseEvents(await response.text())

    expect(deltas(events).flatMap(delta => delta.tool_calls ?? [])).toEqual([])
    expect(
      deltas(events)
        .map(delta => delta.content ?? '')
        .join('')
    ).not.toBe('')
    expect(
      payloads(events).flatMap(payload => payload.choices.map(choice => choice.finish_reason))
    ).toContain('stop')
  })

  it('rejects unknown models with a 404 OpenAI error envelope', async () => {
    const emulator = makeOpenAiEmulator({ knownModels: ['example-model-a'] })

    for (const model of ['yolk-conformance-model-does-not-exist', 'gpt-4.1-nano']) {
      const response = await chat(emulator, plainRequest({ model }))

      expect(response.status).toBe(404)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_found'
        }
      })
    }

    expect(openAiEmulatorDefaultModels).toContain('gpt-4.1-nano')
  })

  it('requires a non-empty bearer credential and never records it', async () => {
    const emulator = makeOpenAiEmulator()

    const rejected: ReadonlyArray<Record<string, string>> = [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Basic abc' }
    ]

    for (const headers of rejected) {
      const response = await chat(emulator, plainRequest(), headers)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key'
        }
      })
    }

    expect(
      (await chat(emulator, plainRequest(), { authorization: 'Bearer anything-at-all' })).status
    ).toBe(200)
    expect(JSON.stringify(emulator.ledger.entries())).not.toContain('anything-at-all')
    expect(JSON.stringify(emulator.ledger.entries()).toLowerCase()).not.toContain('authorization')
  })

  it('fails closed on unknown routes with a 404 OpenAI envelope written to the ledger', async () => {
    const emulator = makeOpenAiEmulator()
    const response = await emulator.fetch(new Request(`${base}/v1/responses`, { method: 'POST' }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found', param: null } })
    expect(emulator.ledger.entries()).toMatchObject([
      { method: 'POST', path: '/v1/responses', evidence: 'unknown-route', status: 404 }
    ])
  })
})

const reasoningModel = 'gpt-6-luna'

const reasoningRequest = (overrides: ChatBody = {}): ChatBody =>
  plainRequest({
    model: reasoningModel,
    max_completion_tokens: 1024,
    reasoning_effort: 'medium',
    ...overrides
  })

describe('openai emulator reasoning models', () => {
  it('reasons by default with gpt-6-luna, a known model', () => {
    expect(openAiEmulatorDefaultReasoningModels).toEqual([reasoningModel])
    expect(openAiEmulatorDefaultModels).toContain(reasoningModel)
  })

  it('streams text only and reports hidden reasoning as usage reasoning tokens', async () => {
    const emulator = makeOpenAiEmulator()
    const response = await chat(emulator, reasoningRequest())

    expect(response.status).toBe(200)

    const text = await response.text()
    const events = sseEvents(text)
    const usage = payloads(events).at(-1)?.usage

    expect(text).not.toContain('reasoning_content')
    expect(text).not.toContain('"reasoning"')
    expect(
      deltas(events)
        .flatMap(delta => (delta.content ? [delta.content] : []))
        .join('')
    ).toBe('Hello from the synthetic OpenAI emulator.')
    expect(usage?.completion_tokens_details?.reasoning_tokens).toBeGreaterThan(0)
    // Completion tokens include the reasoning tokens.
    expect(usage?.completion_tokens).toBeGreaterThan(
      usage?.completion_tokens_details?.reasoning_tokens ?? Number.POSITIVE_INFINITY
    )
    expect(usage?.total_tokens).toBe((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0))
    expect(emulator.ledger.entries()).toMatchObject([
      {
        model: reasoningModel,
        reasoningEffort: 'medium',
        maxCompletionTokens: 1024,
        status: 200
      }
    ])
  })

  it('answers one chat.completion JSON body without reasoning text', async () => {
    const emulator = makeOpenAiEmulator()
    const response = await chat(emulator, reasoningRequest({ stream: false }))
    const text = await response.text()

    expect(text).not.toContain('reasoning_content')
    expect(text).not.toContain('"reasoning"')
    expect(JSON.parse(text)).toMatchObject({
      object: 'chat.completion',
      model: reasoningModel,
      choices: [
        { message: { role: 'assistant', content: 'Hello from the synthetic OpenAI emulator.' } }
      ],
      usage: { completion_tokens_details: { reasoning_tokens: expect.any(Number) } }
    })
  })

  it('reasons without an effort, and reports zero reasoning tokens for effort none', async () => {
    const emulator = makeOpenAiEmulator()

    const usageOf = async (body: ChatBody) =>
      payloads(sseEvents(await (await chat(emulator, body)).text())).at(-1)?.usage

    const defaultEffort = await usageOf(reasoningRequest({ reasoning_effort: undefined }))
    const noEffort = await usageOf(reasoningRequest({ reasoning_effort: null }))
    const none = await usageOf(reasoningRequest({ reasoning_effort: 'none' }))

    expect(defaultEffort?.completion_tokens_details?.reasoning_tokens).toBeGreaterThan(0)
    expect(noEffort?.completion_tokens_details?.reasoning_tokens).toBeGreaterThan(0)
    expect(none?.completion_tokens_details).toEqual({ reasoning_tokens: 0 })
  })

  it('rejects max_tokens on a reasoning model with the OpenAI unsupported_parameter 400', async () => {
    const emulator = makeOpenAiEmulator()

    const response = await chat(
      emulator,
      reasoningRequest({ max_completion_tokens: undefined, max_tokens: 64 })
    )

    expect(response.status).toBe(400)
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    // The unsupported-parameter fixture's envelope.
    expect(await response.json()).toEqual({
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error',
        param: 'max_tokens',
        code: 'unsupported_parameter'
      }
    })
    expect(emulator.ledger.entries()).toMatchObject([
      { model: reasoningModel, status: 400, unsupportedParameter: 'max_tokens' }
    ])
  })

  it('answers the unsupported-parameter fixture request with its recorded status and body', async () => {
    // Drift test: the emulator copies this fixture's envelope as data.
    const [exchange] = openAiChatUnsupportedParameterFixture.exchanges
    const recorded = exchange.response

    if (!('body' in recorded) || !Predicate.isString(recorded.body)) {
      return expect.fail('the unsupported-parameter fixture has no text body')
    }

    const emulator = makeOpenAiEmulator()

    const response = await emulator.fetch(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers: {
          ...exchange.request.headers,
          authorization: 'Bearer synthetic-openai-key'
        },
        body: JSON.stringify(exchange.request.body)
      })
    )

    expect(response.status).toBe(recorded.status)
    expect(await response.json()).toEqual(JSON.parse(recorded.body))
  })

  it('does not emulate parameter rules no fixture backs: sampling parameters are accepted', async () => {
    const emulator = makeOpenAiEmulator()

    const response = await chat(
      emulator,
      reasoningRequest({ temperature: 0, top_p: 0.5, logprobs: true, top_logprobs: 2 })
    )

    expect(response.status).toBe(200)
    expect(emulator.ledger.entries()[0]?.unsupportedParameter).toBeUndefined()
    // A null `max_tokens` counts as absent.
    expect((await chat(emulator, reasoningRequest({ max_tokens: null }))).status).toBe(200)
  })

  it('takes max_tokens and the sampling parameters on a model that does not reason', async () => {
    const emulator = makeOpenAiEmulator()

    const response = await chat(
      emulator,
      plainRequest({ max_tokens: 64, temperature: 0, top_p: 0.5, logprobs: true, top_logprobs: 2 })
    )

    expect(response.status).toBe(200)
    expect(emulator.ledger.entries()[0]?.unsupportedParameter).toBeUndefined()
  })

  it('records and ignores reasoning_effort on a model that does not reason', async () => {
    const emulator = makeOpenAiEmulator()

    for (const stream of [true, false]) {
      const response = await chat(emulator, plainRequest({ stream, reasoning_effort: 'high' }))
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).not.toContain('reasoning_content')
      expect(text).not.toContain('"reasoning"')
      expect(text).not.toContain('completion_tokens_details')
    }

    expect(emulator.ledger.entries().map(entry => entry.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('answers the unknown model before checking parameters', async () => {
    const emulator = makeOpenAiEmulator({ knownModels: ['gpt-4.1-nano'] })

    // `gpt-6-luna` is still a reasoning model here, but not a known one.
    const response = await chat(emulator, reasoningRequest({ max_tokens: 64 }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'model_not_found' } })
  })

  it('uses up no fault on a rejected parameter; a scripted turn answers before the check', async () => {
    const emulator = makeOpenAiEmulator()

    emulator.faults.add({ kind: 'truncate-after-chunks', chunks: 1, count: 1 })

    const rejected = await chat(emulator, reasoningRequest({ max_tokens: 64 }))

    expect(rejected.status).toBe(400)
    expect(emulator.faults.list()).toMatchObject([{ remaining: 1 }])
    expect(emulator.ledger.entries()[0]?.fault).toBeUndefined()

    emulator.faults.clear()
    emulator.script.enqueue({ text: ['391'], usage: null })

    const scripted = await chat(emulator, reasoningRequest({ max_tokens: 64 }))

    expect(scripted.status).toBe(200)
    expect(emulator.ledger.entries()[1]).toMatchObject({ scripted: 'completion', status: 200 })
    expect(emulator.ledger.entries()[1]?.unsupportedParameter).toBeUndefined()
  })

  it('scripts reasoning as usage reasoning tokens, sent for any model', async () => {
    const emulator = makeOpenAiEmulator()

    emulator.script.enqueue({
      text: ['391'],
      usage: { promptTokens: 20, completionTokens: 66, reasoningTokens: 64 }
    })

    const events = sseEvents(await (await chat(emulator, reasoningRequest())).text())

    expect(payloads(events).at(-1)?.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 66,
      total_tokens: 86,
      completion_tokens_details: { reasoning_tokens: 64 }
    })
  })

  it('takes custom reasoning models', async () => {
    const emulator = makeOpenAiEmulator({
      knownModels: ['example-model-a', 'example-reasoner'],
      reasoningModels: ['example-reasoner']
    })

    expect(
      (await chat(emulator, reasoningRequest({ model: 'example-reasoner', max_tokens: 64 }))).status
    ).toBe(400)
    expect(
      (await chat(emulator, plainRequest({ model: 'example-model-a', max_tokens: 64 }))).status
    ).toBe(200)
  })
})

describe('openai emulator ledger', () => {
  it('records max_completion_tokens as maxCompletionTokens and ignores max_tokens', async () => {
    const emulator = makeOpenAiEmulator()

    await (await chat(emulator, plainRequest({ max_completion_tokens: 32 }))).text()
    await (
      await chat(emulator, plainRequest({ max_completion_tokens: undefined, max_tokens: 16 }))
    ).text()

    const [first, second] = emulator.ledger.entries()

    expect(first).toMatchObject({
      seq: 1,
      method: 'POST',
      path: '/v1/chat/completions',
      model: 'gpt-4.1-nano',
      stream: true,
      maxCompletionTokens: 32,
      evidence: 'unverified',
      status: 200
    })
    expect(second?.maxCompletionTokens).toBeUndefined()
    expect(second?.body).toMatchObject({ max_tokens: 16 })
  })
})

describe('openai emulator scripted turns and faults', () => {
  it('streams a scripted completion exactly as scripted', async () => {
    const emulator = makeOpenAiEmulator()

    emulator.script.enqueue({ text: ['A', 'B'], usage: null })

    const events = sseEvents(await (await chat(emulator, plainRequest())).text())

    expect(deltas(events).flatMap(delta => (delta.content ? [delta.content] : []))).toEqual([
      'A',
      'B'
    ])
    expect(payloads(events).some(payload => payload.usage !== undefined)).toBe(false)
    expect(emulator.ledger.entries()[0]?.scripted).toBe('completion')
  })

  it('rejects reasoning text in scripted turns (OpenAI Chat Completions sends none)', async () => {
    const emulator = makeOpenAiEmulator()

    // Held in variables (no excess-property check), as untyped JS callers would pass them: the JS
    // API decodes strictly at runtime too.
    type LooseTurn = {
      readonly text: ReadonlyArray<string>
      readonly reasoning?: ReadonlyArray<string>
      readonly reasoningField?: string
      readonly order?: string
    }

    const reasoningTurns: ReadonlyArray<LooseTurn> = [
      { text: ['x'], reasoning: ['think'] },
      { text: ['x'], reasoningField: 'reasoning' },
      { text: ['x'], order: 'text-first' }
    ]

    for (const turn of reasoningTurns) {
      expect(() => emulator.script.enqueue(turn), JSON.stringify(turn)).toThrow(
        OpenAiEmulatorInputInvalid
      )
      expect((await control(emulator, 'POST', '/_emulate/script', turn)).status).toBe(400)
    }

    expect(emulator.script.pending()).toBe(0)
  })

  it('answers a status fault with the default OpenAI envelope', async () => {
    const emulator = makeOpenAiEmulator()

    emulator.faults.add({ kind: 'status', status: 429, headers: { 'retry-after': '2' }, count: 1 })

    const limited = await chat(emulator, plainRequest())

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    expect(await limited.json()).toMatchObject({
      error: { param: null, code: 'rate_limit_exceeded' }
    })
    expect((await chat(emulator, plainRequest())).status).toBe(200)
  })

  it('answers a scripted error, even for an unknown model', async () => {
    const emulator = makeOpenAiEmulator()
    const turn: OpenAiScriptedTurn = { error: { status: 503, body: 'down' } }

    emulator.script.enqueue(turn)

    const response = await chat(emulator, plainRequest({ model: 'example-unknown' }))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('down')
  })

  it('throws OpenAiEmulatorInputInvalid for invalid faults and turns', () => {
    const emulator = makeOpenAiEmulator()

    expect(() => emulator.faults.add({ kind: 'status', status: 302 })).toThrow(
      OpenAiEmulatorInputInvalid
    )
    expect(() => emulator.script.enqueue({ error: { status: 204, body: 'x' } })).toThrow(
      'Invalid OpenAI emulator turn'
    )
  })
})

describe('openai emulator control plane', () => {
  it('reports state with the reasoning models, and coverage for the manifest', async () => {
    const emulator = makeOpenAiEmulator()

    await (await chat(emulator, plainRequest())).text()

    const state = await (await control(emulator, 'GET', '/_emulate/state')).json()

    expect(state).toEqual({
      knownModels: [...openAiEmulatorDefaultModels],
      reasoningModels: [...openAiEmulatorDefaultReasoningModels],
      pendingTurns: 0,
      faults: [],
      ledgerEntries: 1
    })

    expect(await (await control(emulator, 'GET', '/_emulate/coverage')).json()).toEqual({
      routes: openAiEmulatorRoutes.map(route =>
        JSON.parse(JSON.stringify({ ...route, requests: 1 }))
      ),
      unknownRouteRequests: 0
    })
  })
})

describe('openAiEmulatorRoutes', () => {
  it('lists the chat completions route as unverified provider evidence for the OpenAI cases', () => {
    expect(openAiEmulatorRoutes).toEqual([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        kind: 'provider',
        write: false,
        caseIds: [
          'openai.chat.stream.plain-text',
          'openai.chat.stream.tool-call-deltas',
          'openai.chat.stream.error-envelope',
          'openai.chat.json.plain-text',
          'openai.chat.stream.reasoning-effort',
          'openai.chat.json.reasoning-usage',
          'openai.chat.stream.unsupported-parameter'
        ],
        evidence: 'unverified',
        observedAt: undefined
      }
    ])
  })
})
