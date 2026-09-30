import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  AnthropicEmulatorInputInvalid,
  anthropicEmulatorDefaultModels,
  anthropicEmulatorRoutes,
  emulatorEvidenceHeader,
  makeAnthropicEmulator,
  type AnthropicEmulator,
  type AnthropicFault,
  type AnthropicScriptedTurn
} from '../src/anthropic.ts'
import { makeMessagesEmulator } from '../src/messages.ts'
import { EmulatorRouteUnmapped } from '../src/route-evidence.ts'

const base = 'https://api.anthropic.com'

const messagesUrl = `${base}/v1/messages`

const apiKeyHeaders = { 'x-api-key': 'synthetic-anthropic-key', 'anthropic-version': '2023-06-01' }

/** The Messages request fields these tests send (a subset of the Messages request). */
type MessagesBody = {
  readonly model?: string
  readonly max_tokens?: Schema.Json
  readonly system?: Schema.Json
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly stream?: boolean
  readonly thinking?: Schema.Json
  readonly tools?: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly input_schema?: Schema.Json
  }>
  readonly tool_choice?: Schema.Json
}

const send = (
  emulator: AnthropicEmulator,
  body: MessagesBody | string,
  headers: Record<string, string> = apiKeyHeaders
) =>
  emulator.fetch(
    new Request(messagesUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: Predicate.isString(body) ? body : JSON.stringify(body)
    })
  )

const plainRequest = (overrides: MessagesBody = {}): MessagesBody => ({
  model: 'claude-haiku-4-5',
  max_tokens: 64,
  system: [{ type: 'text', text: 'Reply in one short sentence.' }],
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
  ...overrides
})

const weatherTool = {
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city']
  }
}

const control = (emulator: AnthropicEmulator, method: string, path: string, body?: Schema.Json) => {
  const init: RequestInit = { method }

  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  return emulator.fetch(new Request(`${base}${path}`, init))
}

// Loose views of the Messages SSE payloads these tests read.
type Payload = {
  readonly type: string
  readonly index?: number
  readonly message?: { readonly usage?: { readonly input_tokens: number } }
  readonly content_block?: { readonly type: string; readonly name?: string; readonly id?: string }
  readonly delta?: {
    readonly type?: string
    readonly text?: string
    readonly thinking?: string
    readonly partial_json?: string
    readonly signature?: string
    readonly stop_reason?: string
  }
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens: number }
  readonly error?: { readonly type: string; readonly message: string }
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

const deltaText = (events: ReadonlyArray<SseEvent>, type: string, field: 'text' | 'thinking') =>
  events
    .flatMap(event => (event.data.delta?.type === type ? [event.data.delta[field] ?? ''] : []))
    .join('')

describe('anthropic emulator defaults', () => {
  it('streams message_start, a text block, message_delta, and message_stop in the API order', async () => {
    const emulator = makeAnthropicEmulator()
    const response = await send(emulator, plainRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')

    const events = sseEvents(await response.text())

    // Each SSE `event:` name matches its payload `type`.
    expect(events.every(event => event.event === event.data.type)).toBe(true)
    expect(events.map(event => event.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[0]?.data.message).toMatchObject({
      id: 'msg_synthetic_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: expect.any(Number), output_tokens: 1 }
    })
    expect(deltaText(events, 'text_delta', 'text')).toBe(
      'Hello from the synthetic Anthropic emulator.'
    )
    // The committed fixtures' (unverified) usage shape: input and cache counts next to the
    // cumulative output count.
    expect(events.at(-2)?.data).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: events[0]?.data.message?.usage?.input_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: expect.any(Number)
      }
    })
  })

  it('returns one message JSON body for stream: false', async () => {
    const emulator = makeAnthropicEmulator()
    const response = await send(emulator, plainRequest({ stream: false }))

    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toMatchObject({
      id: 'msg_synthetic_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'Hello from the synthetic Anthropic emulator.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) }
    })
  })

  it('streams a thinking block (deltas, then a signature) before the text when thinking is enabled', async () => {
    const enabled = { type: 'enabled', budget_tokens: 1024 }
    const adaptive = { type: 'adaptive' }

    for (const thinking of [enabled, adaptive]) {
      const emulator = makeAnthropicEmulator()

      const events = sseEvents(
        await (await send(emulator, plainRequest({ max_tokens: 2048, thinking }))).text()
      )

      const starts = events.flatMap(event =>
        event.event === 'content_block_start' ? [event.data.content_block?.type] : []
      )

      expect(starts).toEqual(['thinking', 'text'])
      expect(deltaText(events, 'thinking_delta', 'thinking').length).toBeGreaterThan(0)

      const deltaTypes = events.flatMap(event =>
        event.data.index === 0 && event.data.delta?.type !== undefined
          ? [event.data.delta.type]
          : []
      )

      expect(deltaTypes.at(-1)).toBe('signature_delta')
      expect(emulator.ledger.entries()[0]?.thinking).toEqual(thinking)
    }

    const disabled = sseEvents(
      await (
        await send(makeAnthropicEmulator(), plainRequest({ thinking: { type: 'disabled' } }))
      ).text()
    )

    expect(deltaText(disabled, 'thinking_delta', 'thinking')).toBe('')
  })

  it('streams a schema-synthesized tool_use input as input_json_delta fragments', async () => {
    const emulator = makeAnthropicEmulator()

    const events = sseEvents(
      await (await send(emulator, plainRequest({ tools: [weatherTool] }))).text()
    )

    const start = events.find(event => event.event === 'content_block_start')

    expect(start?.data.content_block).toEqual({
      type: 'tool_use',
      id: 'toolu_synthetic_1_0',
      name: 'lookup_weather',
      input: {}
    })

    const fragments = events.flatMap(event =>
      event.data.delta?.type === 'input_json_delta' ? [event.data.delta.partial_json ?? ''] : []
    )

    expect(fragments[0]).toBe('')
    expect(fragments.length).toBeGreaterThan(2)
    expect(JSON.parse(fragments.join(''))).toEqual({ city: 'synthetic city' })
    expect(events.find(event => event.event === 'message_delta')?.data.delta?.stop_reason).toBe(
      'tool_use'
    )
  })

  it('honours tool_choice: a named tool (with or without parallel use disabled), and none', async () => {
    const otherTool = { name: 'lookup_time', input_schema: { type: 'object' } }

    const toolChoices: ReadonlyArray<Schema.Json> = [
      { type: 'tool', name: 'lookup_weather' },
      { type: 'tool', name: 'lookup_weather', disable_parallel_tool_use: true }
    ]

    for (const toolChoice of toolChoices) {
      const forced = sseEvents(
        await (
          await send(
            makeAnthropicEmulator(),
            plainRequest({ tools: [otherTool, weatherTool], tool_choice: toolChoice })
          )
        ).text()
      )

      expect(
        forced.flatMap(event =>
          event.event === 'content_block_start' ? [event.data.content_block?.name] : []
        )
      ).toEqual(['lookup_weather'])
    }

    const none = sseEvents(
      await (
        await send(
          makeAnthropicEmulator(),
          plainRequest({ tools: [weatherTool], tool_choice: { type: 'none' } })
        )
      ).text()
    )

    expect(deltaText(none, 'text_delta', 'text').length).toBeGreaterThan(0)
    expect(none.find(event => event.event === 'message_delta')?.data.delta?.stop_reason).toBe(
      'end_turn'
    )
  })

  it('cuts the answer and stops with max_tokens when it would not fit', async () => {
    const streamed = sseEvents(
      await (await send(makeAnthropicEmulator(), plainRequest({ max_tokens: 2 }))).text()
    )

    expect(deltaText(streamed, 'text_delta', 'text')).toBe('Hello fr')
    expect(streamed.find(event => event.event === 'message_delta')?.data.delta?.stop_reason).toBe(
      'max_tokens'
    )
    expect(streamed.at(-1)?.event).toBe('message_stop')

    const json = await (
      await send(makeAnthropicEmulator(), plainRequest({ max_tokens: 2, stream: false }))
    ).json()

    expect(json).toMatchObject({ stop_reason: 'max_tokens', content: [{ text: 'Hello fr' }] })
  })

  it('rejects unknown models with a 404 not_found_error envelope', async () => {
    const response = await send(
      makeAnthropicEmulator(),
      plainRequest({ model: 'yolk-conformance-model-does-not-exist' })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'Synthetic placeholder: the requested model was not found.'
      }
    })
  })

  it('rejects a missing or non-positive max_tokens with invalid_request_error', async () => {
    const emulator = makeAnthropicEmulator()

    for (const maxTokens of [undefined, 0, 1.5, '64']) {
      const { max_tokens: _omitted, ...rest } = plainRequest()

      const response = await send(
        emulator,
        maxTokens === undefined ? rest : { ...rest, max_tokens: maxTokens }
      )

      expect(response.status).toBe(400)
      expect((await response.json()).error.type).toBe('invalid_request_error')
    }

    expect(emulator.ledger.entries().map(entry => entry.maxTokens)).toEqual([
      undefined,
      0,
      1.5,
      undefined
    ])
  })

  it('rejects a missing or unsupported anthropic-version with invalid_request_error', async () => {
    const emulator = makeAnthropicEmulator()
    const { 'anthropic-version': _version, ...withoutVersion } = apiKeyHeaders

    const missing = await send(emulator, plainRequest(), withoutVersion)

    const unsupported = await send(emulator, plainRequest(), {
      ...apiKeyHeaders,
      'anthropic-version': '2099-01-01'
    })

    for (const [response, message] of [
      [missing, 'Synthetic: the anthropic-version header is required.'],
      [unsupported, 'Synthetic: the anthropic-version header value is not supported.']
    ] as const) {
      expect(response.status).toBe(400)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(await response.json()).toEqual({
        type: 'error',
        error: { type: 'invalid_request_error', message }
      })
    }

    expect(emulator.ledger.entries()).toMatchObject([
      { credentialHeader: 'x-api-key', evidence: 'unverified', status: 400 },
      {
        credentialHeader: 'x-api-key',
        anthropicVersion: '2099-01-01',
        evidence: 'unverified',
        status: 400
      }
    ])
    expect(emulator.ledger.entries()[0]?.anthropicVersion).toBeUndefined()
  })

  it('rejects thinking together with a forced tool_choice', async () => {
    const emulator = makeAnthropicEmulator()
    const thinking = { type: 'enabled', budget_tokens: 1024 }

    const forced: ReadonlyArray<Schema.Json> = [
      { type: 'tool', name: 'lookup_weather' },
      { type: 'any' }
    ]

    for (const toolChoice of forced) {
      const response = await send(
        emulator,
        plainRequest({ max_tokens: 2048, thinking, tools: [weatherTool], tool_choice: toolChoice })
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Synthetic: thinking may not be enabled when tool_choice forces tool use.'
        }
      })
    }

    const auto = await send(
      emulator,
      plainRequest({
        max_tokens: 2048,
        thinking,
        tools: [weatherTool],
        tool_choice: { type: 'auto' }
      })
    )

    expect(auto.status).toBe(200)
    await auto.text()
    expect(emulator.ledger.entries().map(entry => entry.status)).toEqual([400, 400, 200])
  })

  it('rejects bodies that are not JSON Messages requests', async () => {
    const emulator = makeAnthropicEmulator()

    for (const body of ['not json', JSON.stringify({ model: 'claude-haiku-4-5' })]) {
      const response = await send(emulator, body)

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' }
      })
    }
  })

  it('accepts x-api-key or a bearer credential, records which, and never stores either', async () => {
    const emulator = makeAnthropicEmulator()

    const native = await send(emulator, plainRequest({ stream: false }), apiKeyHeaders)

    const oauth = await send(emulator, plainRequest({ stream: false }), {
      authorization: 'Bearer synthetic-oauth-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20'
    })

    expect([native.status, oauth.status]).toEqual([200, 200])

    const noCredential = {}
    const blankApiKey = { 'x-api-key': ' ' }
    const blankBearer = { authorization: 'Bearer ' }

    for (const headers of [noCredential, blankApiKey, blankBearer]) {
      const response = await send(emulator, plainRequest(), headers)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Synthetic: an x-api-key header or a bearer credential is required.'
        }
      })
    }

    const entries = emulator.ledger.entries()

    expect(entries.map(entry => entry.credentialHeader)).toEqual([
      'x-api-key',
      'authorization',
      undefined,
      undefined,
      undefined
    ])
    expect(entries[0]?.anthropicVersion).toBe('2023-06-01')
    expect(entries[1]?.anthropicBeta).toBe('oauth-2025-04-20')

    const serialized = JSON.stringify(entries)

    expect(serialized).not.toContain('synthetic-anthropic-key')
    expect(serialized).not.toContain('synthetic-oauth-token')
  })

  it('fails closed on unknown routes with a 404 envelope written to the ledger', async () => {
    const emulator = makeAnthropicEmulator()

    const response = await emulator.fetch(
      new Request(`${base}/v1/complete`, { method: 'POST', headers: apiKeyHeaders, body: '{}' })
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'not_found_error', message: 'Synthetic: no emulated route.' }
    })
    expect(emulator.ledger.entries()).toMatchObject([
      { path: '/v1/complete', evidence: 'unknown-route', status: 404 }
    ])
  })
})

describe('anthropic emulator ledger', () => {
  it('records the request fields, evidence, status, and chunks handed over', async () => {
    const emulator = makeAnthropicEmulator()

    const body = plainRequest({
      max_tokens: 48,
      tools: [weatherTool],
      tool_choice: { type: 'tool', name: 'lookup_weather' }
    })

    await (await send(emulator, body)).text()

    const [entry] = emulator.ledger.entries()

    expect(entry).toMatchObject({
      seq: 1,
      method: 'POST',
      path: '/v1/messages',
      body,
      model: 'claude-haiku-4-5',
      stream: true,
      maxTokens: 48,
      toolChoice: { type: 'tool', name: 'lookup_weather' },
      toolNames: ['lookup_weather'],
      credentialHeader: 'x-api-key',
      evidence: 'unverified',
      status: 200
    })
    expect(entry?.bodyChunks).toBeGreaterThan(5)
  })
})

describe('anthropic emulator scripted turns', () => {
  it('streams a scripted message exactly as scripted', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.script.enqueue({
      thinking: ['Plan.'],
      text: ['Hi', ' there.'],
      toolUses: [{ name: 'lookup_weather', inputFragments: ['{"city"', ':"Springfield"}'] }],
      usage: { inputTokens: 7, outputTokens: 11 }
    })

    const events = sseEvents(await (await send(emulator, plainRequest())).text())

    expect(
      events.flatMap(event =>
        event.event === 'content_block_start' ? [event.data.content_block?.type] : []
      )
    ).toEqual(['thinking', 'text', 'tool_use'])
    expect(deltaText(events, 'text_delta', 'text')).toBe('Hi there.')
    expect(
      events.flatMap(event =>
        event.data.delta?.type === 'input_json_delta' ? [event.data.delta.partial_json] : []
      )
    ).toEqual(['{"city"', ':"Springfield"}'])
    expect(events[0]?.data.message?.usage?.input_tokens).toBe(7)
    expect(events.find(event => event.event === 'message_delta')?.data).toMatchObject({
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 11 }
    })
    expect(emulator.ledger.entries()[0]?.scripted).toBe('message')
  })

  it('orders thinking after text, drops usage, and sets any stop reason when scripted', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.script.enqueue({
      thinking: ['Late.'],
      text: ['Early.'],
      order: 'text-first',
      usage: null,
      stopReason: 'max_tokens'
    })

    const events = sseEvents(await (await send(emulator, plainRequest())).text())

    expect(
      events.flatMap(event =>
        event.event === 'content_block_start' ? [event.data.content_block?.type] : []
      )
    ).toEqual(['text', 'thinking'])
    expect(events[0]?.data.message).not.toHaveProperty('usage')
    expect(events.find(event => event.event === 'message_delta')?.data).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null }
    })
  })

  it('answers with a scripted error, even for an unknown model', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.script.enqueue({
      error: {
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'prompt is too long: synthetic' }
        }
      }
    })

    const response = await send(emulator, plainRequest({ model: 'unknown-model' }))

    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('prompt is too long')
    expect(emulator.ledger.entries()[0]?.scripted).toBe('error')
  })

  it('answers 500 for a scripted tool input that is not JSON in JSON mode', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.script.enqueue({ toolUses: [{ name: 'lookup_weather', inputFragments: ['{"ci'] }] })

    const response = await send(emulator, plainRequest({ stream: false }))

    expect(response.status).toBe(500)
    expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    expect(emulator.ledger.entries()[0]).toMatchObject({
      status: 500,
      responseError: 'the emulator could not build the planned response'
    })
  })

  it('throws AnthropicEmulatorInputInvalid for invalid faults and turns', () => {
    const emulator = makeAnthropicEmulator()
    expect(() => emulator.faults.add({ kind: 'error-event-after-chunks', chunks: -1 })).toThrow(
      AnthropicEmulatorInputInvalid
    )
    expect(() => emulator.faults.add({ kind: 'status', status: 302 })).toThrow(
      AnthropicEmulatorInputInvalid
    )
    expect(() => emulator.script.enqueue({ error: { status: 204, body: 'x' } })).toThrow(
      'Invalid Anthropic emulator turn'
    )
    expect(() => emulator.script.enqueue({ toolUses: [{ name: '', inputFragments: [] }] })).toThrow(
      AnthropicEmulatorInputInvalid
    )
  })
})

describe('anthropic emulator faults', () => {
  const statusBody = async (fault: AnthropicFault) => {
    const emulator = makeAnthropicEmulator()

    emulator.faults.add(fault)

    const response = await send(emulator, plainRequest())

    return { response, body: await response.json(), entry: emulator.ledger.entries()[0] }
  }

  it('answers 429 with retry-after and a rate_limit_error envelope', async () => {
    const { response, body, entry } = await statusBody({
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '2' }
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(body).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } })
    expect(entry).toMatchObject({ fault: 'status', status: 429 })
  })

  it('answers 529 with an overloaded_error envelope', async () => {
    const { response, body } = await statusBody({ kind: 'status', status: 529 })

    expect(response.status).toBe(529)
    expect(body).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Synthetic: overloaded.' }
    })
  })

  it('sends an error event mid-stream and closes without message_stop', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.faults.add({ kind: 'error-event-after-chunks', chunks: 3, count: 1 })

    const events = sseEvents(await (await send(emulator, plainRequest())).text())

    expect(events.map(event => event.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'error'
    ])
    expect(events.at(-1)?.data).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Synthetic: overloaded.' }
    })
    expect(emulator.ledger.entries()[0]).toMatchObject({
      fault: 'error-event-after-chunks',
      bodyChunks: 4
    })
    expect(emulator.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

    const custom = makeAnthropicEmulator()

    custom.faults.add({
      kind: 'error-event-after-chunks',
      chunks: 0,
      error: { type: 'api_error', message: 'Synthetic internal error.' }
    })

    expect(sseEvents(await (await send(custom, plainRequest())).text())).toEqual([
      {
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: 'Synthetic internal error.' } }
      }
    ])
  })

  it('answers 500 and keeps an error-event fault that cannot apply', async () => {
    const emulator = makeAnthropicEmulator()

    emulator.faults.add({ kind: 'error-event-after-chunks', chunks: 9 })

    const late = await send(emulator, plainRequest())
    const json = await send(emulator, plainRequest({ stream: false }))

    emulator.script.enqueue({ error: { status: 400, body: 'synthetic' } })

    const scripted = await send(emulator, plainRequest())

    expect([late.status, json.status, scripted.status]).toEqual([500, 500, 500])
    expect(emulator.ledger.entries().map(entry => entry.faultError)).toEqual([
      'error-event-after-chunks after 9 chunk(s) cannot apply to a response with 9 chunk(s)',
      'error-event-after-chunks cannot apply to a non-streamed response',
      'error-event-after-chunks cannot apply to a scripted error'
    ])
    expect(emulator.faults.list()[0]?.applied).toBe(0)
  })

  it('truncates cleanly before message_stop, and errors the body stream', async () => {
    const truncated = makeAnthropicEmulator()

    truncated.faults.add({ kind: 'truncate-after-chunks', chunks: 8 })

    const events = sseEvents(await (await send(truncated, plainRequest())).text())

    expect(events.at(-1)?.event).toBe('message_delta')
    expect(events.map(event => event.event)).not.toContain('message_stop')

    const dropped = makeAnthropicEmulator()

    dropped.faults.add({ kind: 'error-after-chunks', chunks: 2 })

    await expect((await send(dropped, plainRequest())).text()).rejects.toThrow(
      'synthetic mid-stream failure after 2 chunk(s)'
    )
  })
})

describe('anthropic emulator control plane', () => {
  it('adds faults and turns, reports state and coverage, and resets', async () => {
    const emulator = makeAnthropicEmulator()
    const turn: AnthropicScriptedTurn = { text: ['Scripted.'] }

    expect(
      (await control(emulator, 'POST', '/_emulate/faults', { kind: 'status', status: 529 })).status
    ).toBe(201)
    expect((await control(emulator, 'POST', '/_emulate/script', { turns: [turn] })).status).toBe(
      201
    )
    expect(
      (await control(emulator, 'POST', '/_emulate/faults', { kind: 'status', status: 302 })).status
    ).toBe(400)

    expect(await (await control(emulator, 'GET', '/_emulate/state')).json()).toMatchObject({
      knownModels: [...anthropicEmulatorDefaultModels],
      pendingTurns: 1,
      faults: [{ id: 1, fault: { kind: 'status', status: 529 } }],
      ledgerEntries: 0
    })

    await (await send(emulator, plainRequest())).text()

    expect(await (await control(emulator, 'GET', '/_emulate/coverage')).json()).toEqual({
      routes: [{ ...anthropicEmulatorRoutes[0], requests: 1 }],
      unknownRouteRequests: 0
    })

    await control(emulator, 'POST', '/_emulate/reset')

    expect(emulator.ledger.entries()).toEqual([])
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.script.pending()).toBe(0)
  })
})

describe('anthropicEmulatorRoutes', () => {
  it('lists the Messages route as unverified provider evidence for the Anthropic cases', () => {
    expect(anthropicEmulatorRoutes).toEqual([
      {
        method: 'POST',
        path: '/v1/messages',
        kind: 'provider',
        write: false,
        caseIds: [
          'anthropic.messages.stream.plain-text',
          'anthropic.messages.stream.tool-use-input-deltas',
          'anthropic.messages.stream.thinking-before-text',
          'anthropic.messages.stream.error-envelope',
          'anthropic.messages.stream.max-tokens'
        ],
        evidence: 'unverified',
        observedAt: undefined
      }
    ])
  })

  it('throws EmulatorRouteUnmapped when the manifest does not list the Messages path', () => {
    expect(() =>
      makeMessagesEmulator({
        path: '/v2/messages',
        routes: anthropicEmulatorRoutes,
        knownModels: [],
        inputInvalid: (input, reason) => new Error(`${input}: ${reason}`)
      })
    ).toThrow(EmulatorRouteUnmapped)
  })
})
