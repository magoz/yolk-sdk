import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  CodexEmulatorInputInvalid,
  codexEmulatorDefaultModels,
  codexEmulatorRoutes,
  codexResponsesPath,
  emulatorEvidenceHeader,
  makeCodexEmulator,
  type CodexEmulator
} from '../src/codex.ts'
import { makeResponsesEmulator } from '../src/responses.ts'
import { EmulatorRouteUnmapped } from '../src/route-evidence.ts'
import {
  XAiGrokEmulatorInputInvalid,
  makeXAiGrokEmulator,
  xAiGrokEmulatorDefaultModels,
  xAiGrokEmulatorRoutes,
  xAiGrokResponsesPath,
  type XAiGrokEmulator
} from '../src/xai.ts'

const codexBase = 'https://chatgpt.com'

const grokBase = 'https://cli-chat-proxy.grok.com'

const bearer = { authorization: 'Bearer synthetic-oauth-token' }

const codexHeaders = { ...bearer, originator: 'opencode' }

const grokHeaders = (model = 'grok-build') => ({
  ...bearer,
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-model-override': model,
  'x-grok-client-version': '0.0.0-synthetic'
})

/** The Responses request fields these tests send (a subset of the Responses request). */
type ResponsesBody = {
  readonly model?: string
  readonly instructions?: string
  readonly input?: Schema.Json
  readonly stream?: boolean
  readonly store?: boolean
  readonly reasoning?: Schema.Json
  readonly tools?: ReadonlyArray<Schema.Json>
  readonly tool_choice?: Schema.Json
  readonly max_output_tokens?: Schema.Json
  readonly parallel_tool_calls?: boolean
}

type AnyEmulator = CodexEmulator | XAiGrokEmulator

const send = (
  emulator: AnyEmulator,
  url: string,
  body: ResponsesBody | string,
  headers: Record<string, string>
) =>
  emulator.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: Predicate.isString(body) ? body : JSON.stringify(body)
    })
  )

const codexRequest = (overrides: ResponsesBody = {}): ResponsesBody => ({
  model: 'gpt-5.4',
  instructions: 'Reply in one short sentence.',
  input: [{ role: 'user', content: 'Say hello.' }],
  store: false,
  stream: true,
  reasoning: { effort: 'low', summary: 'auto' },
  ...overrides
})

const grokRequest = (overrides: ResponsesBody = {}): ResponsesBody => ({
  model: 'grok-build',
  instructions: 'Reply in one short sentence.',
  input: [{ role: 'user', content: 'Say hello.' }],
  store: false,
  stream: true,
  max_output_tokens: 64,
  ...overrides
})

const sendCodex = (
  emulator: CodexEmulator,
  body: ResponsesBody | string = codexRequest(),
  headers: Record<string, string> = codexHeaders
) => send(emulator, `${codexBase}${codexResponsesPath}`, body, headers)

const sendGrok = (
  emulator: XAiGrokEmulator,
  body: ResponsesBody | string = grokRequest(),
  headers: Record<string, string> = grokHeaders()
) => send(emulator, `${grokBase}${xAiGrokResponsesPath}`, body, headers)

const weatherTool = {
  type: 'function',
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false
  }
}

const otherTool = {
  type: 'function',
  name: 'lookup_time',
  parameters: { type: 'object', properties: {}, required: [] }
}

const control = (emulator: AnyEmulator, method: string, path: string, body?: Schema.Json) => {
  const init: RequestInit = { method }

  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  return emulator.fetch(new Request(`${codexBase}${path}`, init))
}

// Loose views of the Responses SSE payloads these tests read.
type Item = {
  readonly id: string
  readonly type: string
  readonly status?: string
  readonly call_id?: string
  readonly name?: string
  readonly arguments?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text: string }>
  readonly summary?: ReadonlyArray<{ readonly type: string; readonly text: string }>
}

type ResponseObject = {
  readonly id: string
  readonly object: string
  readonly status: string
  readonly model: string
  readonly output: ReadonlyArray<Item>
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly output_tokens_details: { readonly reasoning_tokens: number }
    readonly total_tokens: number
  } | null
  readonly error?: { readonly code: string; readonly message: string } | null
}

type Payload = {
  readonly type: string
  readonly sequence_number: number
  readonly response?: ResponseObject
  readonly item?: Item
  readonly item_id?: string
  readonly output_index?: number
  readonly delta?: string
  readonly text?: string
  readonly arguments?: string
  readonly code?: string
  readonly message?: string
}

type SseEvent = { readonly event: string; readonly data: Payload }

const sseEvents = (text: string): ReadonlyArray<SseEvent> =>
  text
    .split('\n\n')
    .filter(block => block.length > 0)
    .map(block => {
      const [eventLine, dataLine] = block.split('\n')

      return {
        event: eventLine?.slice('event: '.length) ?? '',
        data: JSON.parse(dataLine?.slice('data: '.length) ?? 'null')
      }
    })

const deltas = (events: ReadonlyArray<SseEvent>, type: string) =>
  events.flatMap(event => (event.data.type === type ? [event.data.delta ?? ''] : []))

const completedOf = (events: ReadonlyArray<SseEvent>) =>
  events.find(event => event.data.type === 'response.completed')?.data.response

describe('responses emulator defaults', () => {
  it('streams response.created, the output items, and response.completed in the API order', async () => {
    const emulator = makeCodexEmulator()
    const response = await sendCodex(emulator)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')

    const events = sseEvents(await response.text())

    expect(events.map(event => event.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed'
    ])

    // Typed event names match the payload types, and sequence numbers count up from 0.
    expect(events.every(event => event.event === event.data.type)).toBe(true)
    expect(events.map(event => event.data.sequence_number)).toEqual(events.map((_, index) => index))
    expect(events[0]?.data.response).toMatchObject({
      id: 'resp_synthetic_1',
      object: 'response',
      status: 'in_progress',
      model: 'gpt-5.4',
      output: [],
      usage: null
    })

    const text = deltas(events, 'response.output_text.delta').join('')

    expect(text).toBe('Hello from the synthetic Codex emulator.')

    const completed = completedOf(events)

    expect(completed?.status).toBe('completed')
    expect(completed?.output.map(item => item.type)).toEqual(['reasoning', 'message'])
    expect(completed?.output[1]?.content).toEqual([{ type: 'output_text', text, annotations: [] }])
    expect(completed?.usage).toMatchObject({ input_tokens: expect.any(Number) })
    expect(completed?.usage?.output_tokens_details.reasoning_tokens).toBeGreaterThan(0)
    expect(completed?.usage?.output_tokens).toBeGreaterThanOrEqual(
      completed?.usage?.output_tokens_details.reasoning_tokens ?? Infinity
    )
    expect(emulator.ledger.entries()[0]?.bodyChunks).toBe(events.length)
  })

  it('streams no reasoning item without a reasoning summary request', async () => {
    const emulator = makeXAiGrokEmulator()
    const events = sseEvents(await (await sendGrok(emulator)).text())

    expect(events.some(event => event.data.type.includes('reasoning'))).toBe(false)
    expect(deltas(events, 'response.output_text.delta').join('')).toBe(
      'Hello from the synthetic Grok emulator.'
    )
    expect(completedOf(events)?.usage?.output_tokens_details.reasoning_tokens).toBe(0)
  })

  it('returns one completed response JSON body for stream: false', async () => {
    const emulator = makeCodexEmulator()
    const response = await sendCodex(emulator, codexRequest({ stream: false }))

    expect(response.headers.get('content-type')).toBe('application/json')

    const body: ResponseObject = await response.json()

    expect(body).toMatchObject({ object: 'response', status: 'completed', model: 'gpt-5.4' })
    expect(body.output.map(item => item.type)).toEqual(['reasoning', 'message'])
    expect(body.usage?.total_tokens).toBeGreaterThan(0)
    expect(emulator.ledger.entries()[0]).toMatchObject({ stream: false, bodyChunks: 1 })
  })

  it('streams a schema-synthesized function_call with argument deltas', async () => {
    const emulator = makeXAiGrokEmulator()

    const events = sseEvents(
      await (await sendGrok(emulator, grokRequest({ tools: [weatherTool] }))).text()
    )

    const added = events.find(event => event.data.type === 'response.output_item.added')

    expect(added?.data.item).toMatchObject({
      type: 'function_call',
      status: 'in_progress',
      name: 'lookup_weather',
      call_id: 'call_synthetic_1_0',
      arguments: ''
    })

    const fragments = deltas(events, 'response.function_call_arguments.delta')

    expect(fragments.length).toBeGreaterThan(1)
    expect(JSON.parse(fragments.join(''))).toEqual({ city: 'synthetic city' })
    expect(
      events.find(event => event.data.type === 'response.function_call_arguments.done')?.data
        .arguments
    ).toBe(fragments.join(''))
    expect(completedOf(events)?.output).toEqual([
      expect.objectContaining({ type: 'function_call', arguments: fragments.join('') })
    ])
    expect(events.some(event => event.data.type === 'response.output_text.delta')).toBe(false)
  })

  it('honours tool_choice: a named function, and none', async () => {
    const emulator = makeXAiGrokEmulator()

    const named = sseEvents(
      await (
        await sendGrok(
          emulator,
          grokRequest({
            tools: [weatherTool, otherTool],
            tool_choice: { type: 'function', name: 'lookup_time' }
          })
        )
      ).text()
    )

    expect(completedOf(named)?.output.map(item => item.name)).toEqual(['lookup_time'])

    const none = sseEvents(
      await (
        await sendGrok(emulator, grokRequest({ tools: [weatherTool], tool_choice: 'none' }))
      ).text()
    )

    expect(completedOf(none)?.output.map(item => item.type)).toEqual(['message'])
    expect(emulator.ledger.entries().map(entry => entry.toolNames)).toEqual([
      ['lookup_weather', 'lookup_time'],
      ['lookup_weather']
    ])
  })

  it('rejects unknown models with a 400 model_not_found envelope', async () => {
    const invalid = 'yolk-conformance-model-does-not-exist'
    const codex = makeCodexEmulator()
    const grok = makeXAiGrokEmulator()

    const answers: ReadonlyArray<readonly [AnyEmulator, Response]> = [
      [codex, await sendCodex(codex, codexRequest({ model: invalid }))],
      [grok, await sendGrok(grok, grokRequest({ model: invalid }), grokHeaders(invalid))]
    ]

    for (const [emulator, response] of answers) {
      expect(response.status).toBe(400)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      })
      expect(emulator.ledger.entries()[0]?.status).toBe(400)
    }
  })

  it('rejects bodies that are not JSON Responses requests', async () => {
    const emulator = makeCodexEmulator()

    for (const body of ['not json', JSON.stringify({ model: 'gpt-5.4' }), '[]']) {
      const response = await sendCodex(emulator, body)

      const payload: { readonly error: { readonly type: string } } = await response.json()

      expect(response.status).toBe(400)
      expect(payload.error.type).toBe('invalid_request_error')
    }

    expect(
      await (await sendCodex(emulator, codexRequest({ input: 'Say hello.' }))).text()
    ).toContain('response.completed')
  })

  it('fails closed on unknown routes with a 404 envelope written to the ledger', async () => {
    const emulator = makeCodexEmulator()

    const response = await emulator.fetch(
      new Request(`${codexBase}/v1/responses`, {
        method: 'POST',
        headers: codexHeaders,
        body: '{}'
      })
    )

    expect(response.status).toBe(404)
    expect(emulator.ledger.entries()).toMatchObject([
      { path: '/v1/responses', evidence: 'unknown-route', status: 404 }
    ])
    expect(emulator.coverage().unknownRouteRequests).toBe(1)
  })
})

describe('responses emulator authentication and headers', () => {
  it('requires a non-empty bearer credential and never stores it', async () => {
    const emulator = makeCodexEmulator()

    const unauthorized: ReadonlyArray<Record<string, string>> = [
      {},
      { authorization: 'Bearer ' },
      { authorization: 'Basic abc' }
    ]

    for (const headers of unauthorized) {
      const response = await sendCodex(emulator, codexRequest(), headers)

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    }

    expect((await sendCodex(emulator)).status).toBe(200)
    expect(JSON.stringify(emulator.ledger.entries())).not.toContain('synthetic-oauth-token')
    expect(emulator.ledger.entries().at(-1)?.headers).toEqual({ originator: 'opencode' })
  })

  it('enforces the Grok CLI proxy headers in order: token auth 401, client version 426, model override 400', async () => {
    const emulator = makeXAiGrokEmulator()
    const complete = grokHeaders()

    const without = (name: keyof typeof complete) =>
      Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name))

    const cases: ReadonlyArray<readonly [Record<string, string>, number, string]> = [
      [without('X-XAI-Token-Auth'), 401, 'missing_token_auth'],
      [without('x-grok-client-version'), 426, 'upgrade_required'],
      [{ ...complete, 'x-grok-client-version': ' ' }, 426, 'upgrade_required'],
      [without('x-grok-model-override'), 400, 'missing_model_override'],
      [{ ...bearer }, 401, 'missing_token_auth'],
      [{ ...complete, 'X-XAI-Token-Auth': '' }, 401, 'missing_token_auth']
    ]

    for (const [headers, status, code] of cases) {
      const response = await sendGrok(emulator, grokRequest(), headers)

      expect(response.status, code).toBe(status)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await response.json()).toMatchObject({ error: { code } })
    }

    expect((await sendGrok(emulator)).status).toBe(200)

    const entries = emulator.ledger.entries()

    expect(entries.map(entry => entry.status)).toEqual([401, 426, 426, 400, 401, 401, 200])
    // The client version and model override are recorded; the token-auth marker and the bearer
    // never are.
    expect(entries.at(-1)?.headers).toEqual({
      'x-grok-client-version': '0.0.0-synthetic',
      'x-grok-model-override': 'grok-build'
    })
    expect(JSON.stringify(entries)).not.toContain('xai-grok-cli')
    expect(JSON.stringify(entries)).not.toContain('synthetic-oauth-token')
  })
})

describe('responses emulator output limit policy', () => {
  it('Codex rejects any max_output_tokens with unsupported_parameter', async () => {
    const emulator = makeCodexEmulator()
    const response = await sendCodex(emulator, codexRequest({ max_output_tokens: 64 }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'unsupported_parameter', param: 'max_output_tokens' }
    })
    expect(emulator.ledger.entries()[0]).toMatchObject({ maxOutputTokens: 64, status: 400 })
  })

  it('Grok records a positive max_output_tokens and rejects a non-positive one', async () => {
    const emulator = makeXAiGrokEmulator()

    expect((await sendGrok(emulator)).status).toBe(200)
    expect((await sendGrok(emulator, grokRequest({ max_output_tokens: 0 }))).status).toBe(400)
    expect((await sendGrok(emulator, grokRequest({ max_output_tokens: 1.5 }))).status).toBe(400)
    expect((await sendGrok(emulator, grokRequest({ max_output_tokens: null }))).status).toBe(200)
    expect(emulator.ledger.entries().map(entry => entry.maxOutputTokens)).toEqual([
      64,
      0,
      1.5,
      undefined
    ])
  })
})

describe('responses emulator ledger', () => {
  it('records the request fields, evidence, status, and chunks handed over', async () => {
    const emulator = makeCodexEmulator()

    await (
      await sendCodex(
        emulator,
        codexRequest({ tools: [weatherTool], parallel_tool_calls: true }),
        codexHeaders
      )
    ).text()

    const [entry] = emulator.ledger.entries()

    expect(entry).toMatchObject({
      seq: 1,
      method: 'POST',
      path: codexResponsesPath,
      model: 'gpt-5.4',
      stream: true,
      store: false,
      reasoning: { effort: 'low', summary: 'auto' },
      toolNames: ['lookup_weather'],
      headers: { originator: 'opencode' },
      evidence: 'unverified',
      status: 200
    })
    expect(entry?.bodyChunks).toBeGreaterThan(5)
    expect(entry?.maxOutputTokens).toBeUndefined()
    expect(emulator.coverage().routes[0]?.requests).toBe(1)
  })
})

describe('responses emulator scripted turns', () => {
  it('streams a scripted response exactly as scripted', async () => {
    const emulator = makeCodexEmulator()

    emulator.script.enqueue({
      reasoning: ['Plan.'],
      text: ['Hi', ' there.'],
      functionCalls: [
        { name: 'lookup_weather', argumentFragments: ['{"ci', 'ty":"X"}'], callId: 'call_x' }
      ],
      usage: { inputTokens: 7, outputTokens: 9, reasoningTokens: 2 }
    })

    const events = sseEvents(await (await sendCodex(emulator)).text())
    const completed = completedOf(events)

    expect(completed?.output.map(item => item.type)).toEqual([
      'reasoning',
      'message',
      'function_call'
    ])
    expect(deltas(events, 'response.reasoning_summary_text.delta')).toEqual(['Plan.'])
    expect(deltas(events, 'response.output_text.delta')).toEqual(['Hi', ' there.'])
    expect(deltas(events, 'response.function_call_arguments.delta')).toEqual(['{"ci', 'ty":"X"}'])
    expect(completed?.output[2]).toMatchObject({ call_id: 'call_x', arguments: '{"city":"X"}' })
    expect(completed?.usage).toEqual({
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 16
    })
    expect(emulator.ledger.entries()[0]?.scripted).toBe('response')
  })

  it('orders reasoning after text, drops usage, and answers JSON for a stream request when scripted', async () => {
    const emulator = makeXAiGrokEmulator()

    emulator.script.enqueue({
      reasoning: ['Plan.'],
      text: ['Hi.'],
      order: 'text-first',
      usage: null
    })
    emulator.script.enqueue({ text: ['Hi.'], format: 'json' })

    const events = sseEvents(await (await sendGrok(emulator)).text())
    const completed = completedOf(events)

    expect(completed?.output.map(item => item.type)).toEqual(['message', 'reasoning'])
    expect(completed).not.toHaveProperty('usage')

    const json = await sendGrok(emulator)

    expect(json.headers.get('content-type')).toBe('application/json')
    const body: ResponseObject = await json.json()

    expect(body.status).toBe('completed')
  })

  it('answers with a scripted error, even for an unknown model', async () => {
    const emulator = makeCodexEmulator()

    emulator.script.enqueue({
      error: {
        status: 503,
        body: { error: { message: 'synthetic' } },
        headers: { 'retry-after': '1' }
      }
    })

    const response = await sendCodex(emulator, codexRequest({ model: 'unknown-model' }))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(emulator.ledger.entries()[0]).toMatchObject({ scripted: 'error', status: 503 })
  })

  it('throws the subpath input-invalid error for invalid faults and turns', () => {
    const codex = makeCodexEmulator()
    const grok = makeXAiGrokEmulator()

    expect(() => codex.faults.add({ kind: 'status', status: 302 })).toThrow(
      CodexEmulatorInputInvalid
    )
    expect(() => codex.faults.add({ kind: 'error-event-after-chunks', chunks: -1 })).toThrow(
      'Invalid Codex emulator fault'
    )
    expect(() => codex.script.enqueue({ error: { status: 204, body: 'x' } })).toThrow(
      CodexEmulatorInputInvalid
    )
    expect(() =>
      grok.script.enqueue({ functionCalls: [{ name: '', argumentFragments: [] }] })
    ).toThrow(XAiGrokEmulatorInputInvalid)
    expect(() =>
      grok.faults.add({
        kind: 'error-event-after-chunks',
        chunks: 1,
        error: { code: '', message: 'x' }
      })
    ).toThrow('Invalid xAI Grok emulator fault')
  })
})

describe('responses emulator faults', () => {
  it('answers 429 with retry-after and the default error envelope', async () => {
    const emulator = makeCodexEmulator()

    emulator.faults.add({ kind: 'status', status: 429, headers: { 'retry-after': '2' }, count: 1 })

    const response = await sendCodex(emulator)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    expect(emulator.ledger.entries()[0]).toMatchObject({ fault: 'status', status: 429 })
    expect((await sendCodex(emulator)).status).toBe(200)
  })

  it('sends an error event mid-stream (default) and closes without response.completed', async () => {
    const emulator = makeXAiGrokEmulator()

    emulator.faults.add({ kind: 'error-event-after-chunks', chunks: 3 })

    const events = sseEvents(await (await sendGrok(emulator)).text())

    expect(events).toHaveLength(4)
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: {
        type: 'error',
        sequence_number: 3,
        code: 'server_error',
        message: expect.any(String),
        param: null
      }
    })
    expect(completedOf(events)).toBeUndefined()
    expect(emulator.ledger.entries()[0]).toMatchObject({
      fault: 'error-event-after-chunks',
      bodyChunks: 4
    })
  })

  it('sends a response.failed event mid-stream with the given error', async () => {
    const emulator = makeCodexEmulator()

    emulator.faults.add({
      kind: 'error-event-after-chunks',
      chunks: 2,
      event: 'response.failed',
      error: { code: 'rate_limit_exceeded', message: 'Synthetic rate limit.' }
    })

    const events = sseEvents(await (await sendCodex(emulator)).text())

    expect(events.map(event => event.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.failed'
    ])
    expect(events.at(-1)?.data.response).toMatchObject({
      status: 'failed',
      error: { code: 'rate_limit_exceeded', message: 'Synthetic rate limit.' }
    })
  })

  it('answers 500 and keeps an error-event fault that cannot apply', async () => {
    const emulator = makeCodexEmulator()

    emulator.faults.add({ kind: 'error-event-after-chunks', chunks: 100 })

    const response = await sendCodex(emulator)

    expect(response.status).toBe(500)
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(emulator.ledger.entries()[0]?.faultError).toContain('cannot apply')

    const json = await sendCodex(emulator, codexRequest({ stream: false }))

    expect(json.status).toBe(500)
    expect(emulator.ledger.entries()[1]?.faultError).toContain('JSON response')
    expect(emulator.faults.list()[0]?.applied).toBe(0)
  })

  it('truncates cleanly before response.completed, and errors the body stream', async () => {
    const emulator = makeXAiGrokEmulator()

    emulator.faults.add({ kind: 'truncate-after-chunks', chunks: 5, count: 1 })
    emulator.faults.add({ kind: 'error-after-chunks', chunks: 2, count: 1 })

    const truncated = sseEvents(await (await sendGrok(emulator)).text())

    expect(truncated).toHaveLength(5)
    expect(completedOf(truncated)).toBeUndefined()

    const dropped = await sendGrok(emulator)

    await expect(dropped.text()).rejects.toThrow(/synthetic mid-stream failure/)
    expect(emulator.ledger.entries().map(entry => entry.fault)).toEqual([
      'truncate-after-chunks',
      'error-after-chunks'
    ])
  })
})

describe('responses emulator control plane', () => {
  it('adds faults and turns, reports state and coverage, and resets', async () => {
    const emulator = makeCodexEmulator()

    expect(
      (await control(emulator, 'POST', '/_emulate/faults', { kind: 'status', status: 503 })).status
    ).toBe(201)
    expect(
      (await control(emulator, 'POST', '/_emulate/script', { turns: [{ text: ['Hi.'] }] })).status
    ).toBe(201)
    expect((await control(emulator, 'POST', '/_emulate/faults', { kind: 'bogus' })).status).toBe(
      400
    )

    const state = await (await control(emulator, 'GET', '/_emulate/state')).json()

    expect(state).toMatchObject({
      knownModels: [...codexEmulatorDefaultModels],
      pendingTurns: 1,
      ledgerEntries: 0
    })

    expect((await sendCodex(emulator)).status).toBe(503)

    const coverage = await (await control(emulator, 'GET', '/_emulate/coverage')).json()

    expect(coverage).toMatchObject({
      routes: [{ method: 'POST', path: codexResponsesPath, requests: 1 }],
      unknownRouteRequests: 0
    })

    expect((await control(emulator, 'POST', '/_emulate/reset')).status).toBe(200)
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)
    expect(emulator.ledger.entries()).toEqual([])
  })
})

describe('responses emulator route manifests', () => {
  it('list each Responses route as unverified provider evidence for its cases', () => {
    expect(codexEmulatorRoutes).toEqual([
      {
        method: 'POST',
        path: '/backend-api/codex/responses',
        kind: 'provider',
        write: false,
        caseIds: [
          'openai.codex.stream.plain-text',
          'openai.codex.stream.function-call-arguments',
          'openai.codex.stream.error-envelope',
          'openai.codex.stream.terminal-event'
        ],
        evidence: 'unverified',
        observedAt: undefined
      }
    ])
    expect(xAiGrokEmulatorRoutes.map(route => [route.method, route.path, route.evidence])).toEqual([
      ['POST', '/v1/responses', 'unverified']
    ])
    expect(xAiGrokEmulatorRoutes[0]?.caseIds).toEqual([
      'xai.grok.stream.plain-text',
      'xai.grok.stream.function-call-arguments',
      'xai.grok.stream.error-envelope',
      'xai.grok.stream.terminal-event'
    ])
    expect(xAiGrokEmulatorDefaultModels).toContain('grok-build')
  })

  it('throws EmulatorRouteUnmapped when the manifest does not list the Responses path', () => {
    expect(() =>
      makeResponsesEmulator({
        path: '/v1/responses',
        routes: codexEmulatorRoutes,
        knownModels: [],
        errorEnvelope: error => ({ error: { message: error.message } }),
        unknownModel: {
          status: 400,
          error: { message: 'x', type: 'invalid_request_error', code: 'model_not_found' }
        },
        unauthorized: { message: 'x', type: 'invalid_request_error', code: 'invalid_api_key' },
        headers: [],
        outputTokenLimit: 'optional',
        defaultText: ['x'],
        inputInvalid: (input, reason) => new Error(`${input}: ${reason}`)
      })
    ).toThrow(EmulatorRouteUnmapped)
  })
})
