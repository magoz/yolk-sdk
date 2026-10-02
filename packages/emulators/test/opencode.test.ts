/**
 * The OpenCode Go emulator: one origin serving the fixture-only chat, Messages, Responses, and
 * usage routes under `/zen/go/v1`. Recorded requests (within the documented request-shape
 * latitude) get the recorded responses; everything else is one ledgered 400 not-emulated that
 * uses up no fault or turn. Per-part ledgers, faults, turns, and control planes, the combined
 * coverage and reset, and the manifest.
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  openCodeGoChatPlainTextFixture,
  openCodeGoMessagesPlainTextFixture,
  openCodeGoResponsesCommentaryReplayFixture,
  openCodeGoResponsesPlainTextFixture,
  openCodeGoUsageSnapshotFixture
} from '@yolk-sdk/agent/providers/opencode/conformance'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  makeOpenCodeGoEmulator,
  OpenCodeGoEmulatorInputInvalid,
  openCodeGoChatCompletionsPath,
  openCodeGoEmulatorDefaultModels,
  openCodeGoEmulatorRoutes,
  openCodeGoMessagesPath,
  openCodeGoResponsesPath,
  openCodeGoUsageDefault,
  openCodeGoUsagePath,
  type OpenCodeGoEmulator,
  type OpenCodeGoRouteEmulator
} from '../src/opencode.ts'
import { isJsonObject } from '../src/emulator-kernel.ts'
import { emulatorEvidenceHeader } from '../src/route-evidence.ts'

const origin = 'https://opencode.ai'

const bearer = { authorization: 'Bearer synthetic-go-key' }

const apiKey = { 'x-api-key': 'synthetic-go-key', 'anthropic-version': '2023-06-01' }

const recordedBody = (fixture: WireFixture): Schema.JsonObject => {
  const body = fixture.exchanges[0].request.body

  return isJsonObject(body) ? body : expect.fail(`${fixture.id} has no JSON request body`)
}

const recordedText = (fixture: WireFixture): string => {
  const response = fixture.exchanges[0].response

  if ('chunks' in response && response.chunks !== undefined) {
    return response.chunks.map(chunk => (Predicate.isString(chunk) ? chunk : '')).join('')
  }

  return 'body' in response && Predicate.isString(response.body) ? response.body : ''
}

const post = (
  emulator: OpenCodeGoEmulator,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: unknown
) =>
  emulator.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )

const get = (emulator: OpenCodeGoEmulator, path: string, headers: Record<string, string>) =>
  emulator.fetch(
    new Request(`${origin}${path}`, { headers: { accept: 'application/json', ...headers } })
  )

const control = (emulator: OpenCodeGoEmulator, method: string, path: string, body?: unknown) =>
  emulator.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )

const chatBody = recordedBody(openCodeGoChatPlainTextFixture)

const messagesBody = recordedBody(openCodeGoMessagesPlainTextFixture)

const responsesBody = recordedBody(openCodeGoResponsesPlainTextFixture)

const replayBody = recordedBody(openCodeGoResponsesCommentaryReplayFixture)

const expectNotEmulated = async (response: Response) => {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { type: 'not_emulated', message: expect.stringMatching(/^Not emulated: /) }
  })
}

/** A part with one armed fault and one pending turn, to prove a rejection uses up neither. */
const armed = (part: OpenCodeGoRouteEmulator) => {
  part.faults.add({ kind: 'status', status: 503, count: 1 })
  part.script.enqueue({ error: { status: 502, body: { error: { message: 'synthetic' } } } })
}

const expectUntouched = (part: OpenCodeGoRouteEmulator) => {
  expect(part.faults.list()).toMatchObject([{ remaining: 1, applied: 0 }])
  expect(part.script.pending()).toBe(1)
  expect(part.ledger.entries().at(-1)).toMatchObject({
    status: 400,
    notEmulated: expect.any(String)
  })
  expect(part.ledger.entries().at(-1)).not.toHaveProperty('recording')
}

describe('makeOpenCodeGoEmulator recorded answers', () => {
  it('answers each recorded request with its recorded response, evidence-tagged', async () => {
    const emulator = makeOpenCodeGoEmulator()

    const cases = [
      [
        openCodeGoChatPlainTextFixture,
        post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)
      ],
      [
        openCodeGoMessagesPlainTextFixture,
        post(emulator, openCodeGoMessagesPath, apiKey, messagesBody)
      ],
      [
        openCodeGoResponsesPlainTextFixture,
        post(emulator, openCodeGoResponsesPath, bearer, responsesBody)
      ],
      [
        openCodeGoResponsesCommentaryReplayFixture,
        post(emulator, openCodeGoResponsesPath, bearer, replayBody)
      ],
      [openCodeGoUsageSnapshotFixture, get(emulator, openCodeGoUsagePath, bearer)]
    ] as const

    for (const [fixture, pending] of cases) {
      const response = await pending

      expect(response.status, fixture.id).toBe(200)
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
      expect(response.headers.get('content-type')).toBe(
        fixture.exchanges[0].response.headers['content-type']
      )
      expect(await response.text(), fixture.id).toBe(recordedText(fixture))
    }

    expect(emulator.chat.ledger.entries()).toMatchObject([
      {
        path: openCodeGoChatCompletionsPath,
        model: 'synthetic-go-chat',
        credentialHeader: 'authorization',
        recording: openCodeGoChatPlainTextFixture.id,
        status: 200
      }
    ])
    expect(emulator.messages.ledger.entries()).toMatchObject([
      {
        credentialHeader: 'x-api-key',
        headers: { 'anthropic-version': '2023-06-01' },
        recording: openCodeGoMessagesPlainTextFixture.id
      }
    ])
    expect(emulator.responses.ledger.entries().map(entry => entry.recording)).toEqual([
      openCodeGoResponsesPlainTextFixture.id,
      openCodeGoResponsesCommentaryReplayFixture.id
    ])
    expect(emulator.usage.ledger.entries()).toMatchObject([
      { method: 'GET', recording: openCodeGoUsageSnapshotFixture.id }
    ])
    expect(openCodeGoUsageDefault).toEqual(JSON.parse(recordedText(openCodeGoUsageSnapshotFixture)))
    expect(openCodeGoEmulatorDefaultModels).toEqual([
      'synthetic-go-chat',
      'synthetic-go-messages',
      'synthetic-go-responses'
    ])
  })

  it('accepts the documented request-shape latitude', async () => {
    const emulator = makeOpenCodeGoEmulator()

    // Other text values, another positive output limit, other credential values, extra headers.
    const chat = await post(
      emulator,
      openCodeGoChatCompletionsPath,
      {
        authorization: 'Bearer other',
        'x-extra': '1',
        'content-type': 'application/json; charset=utf-8'
      },
      {
        ...chatBody,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi there.' }
        ]
      }
    )

    expect(chat.status).toBe(200)
    expect(await chat.text()).toBe(recordedText(openCodeGoChatPlainTextFixture))

    // Replay: other call ids, arguments, and texts keep the recorded kinds and discriminators.
    const replay = await post(emulator, openCodeGoResponsesPath, bearer, {
      ...replayBody,
      input: [
        { role: 'user', content: 'Weather in Shelbyville?' },
        { role: 'assistant', content: 'Checking.', phase: 'commentary' },
        {
          type: 'function_call',
          call_id: 'call_other',
          name: 'lookup_weather',
          arguments: '{"city":"Shelbyville"}'
        },
        { type: 'function_call_output', call_id: 'call_other', output: 'Rainy.' }
      ]
    })

    expect(replay.status).toBe(200)
    expect(await replay.text()).toBe(recordedText(openCodeGoResponsesCommentaryReplayFixture))
  })
})

describe('makeOpenCodeGoEmulator not-emulated requests', () => {
  const rejections: ReadonlyArray<{
    readonly label: string
    readonly part: 'chat' | 'messages' | 'responses' | 'usage'
    readonly send: (emulator: OpenCodeGoEmulator) => Promise<Response>
  }> = [
    {
      label: 'chat without a credential',
      part: 'chat',
      send: e => post(e, openCodeGoChatCompletionsPath, {}, chatBody)
    },
    {
      label: 'chat with x-api-key instead of a bearer',
      part: 'chat',
      send: e => post(e, openCodeGoChatCompletionsPath, { 'x-api-key': 'k' }, chatBody)
    },
    {
      label: 'chat with an unrecorded model',
      part: 'chat',
      send: e =>
        post(e, openCodeGoChatCompletionsPath, bearer, { ...chatBody, model: 'other-model' })
    },
    {
      label: 'chat without streaming (no JSON-body fixture)',
      part: 'chat',
      send: e => post(e, openCodeGoChatCompletionsPath, bearer, { ...chatBody, stream: false })
    },
    {
      label: 'chat with tools',
      part: 'chat',
      send: e => post(e, openCodeGoChatCompletionsPath, bearer, { ...chatBody, tools: [] })
    },
    {
      label: 'chat asking for reasoning',
      part: 'chat',
      send: e =>
        post(e, openCodeGoChatCompletionsPath, bearer, { ...chatBody, reasoning_effort: 'low' })
    },
    {
      label: 'chat with another message count',
      part: 'chat',
      send: e =>
        post(e, openCodeGoChatCompletionsPath, bearer, {
          ...chatBody,
          messages: [{ role: 'user', content: 'Hi.' }]
        })
    },
    {
      label: 'chat with a JSON accept',
      part: 'chat',
      send: e =>
        post(e, openCodeGoChatCompletionsPath, { ...bearer, accept: 'application/json' }, chatBody)
    },
    {
      label: 'Messages with a bearer only',
      part: 'messages',
      send: e =>
        post(
          e,
          openCodeGoMessagesPath,
          { ...bearer, 'anthropic-version': '2023-06-01' },
          messagesBody
        )
    },
    {
      label: 'Messages without anthropic-version',
      part: 'messages',
      send: e => post(e, openCodeGoMessagesPath, { 'x-api-key': 'k' }, messagesBody)
    },
    {
      label: 'Messages with thinking',
      part: 'messages',
      send: e =>
        post(e, openCodeGoMessagesPath, apiKey, {
          ...messagesBody,
          thinking: { type: 'enabled', budget_tokens: 1024 }
        })
    },
    {
      label: 'Messages with a zero output limit',
      part: 'messages',
      send: e => post(e, openCodeGoMessagesPath, apiKey, { ...messagesBody, max_tokens: 0 })
    },
    {
      label: 'Responses with store: true',
      part: 'responses',
      send: e => post(e, openCodeGoResponsesPath, bearer, { ...responsesBody, store: true })
    },
    {
      label: 'Responses asking for a reasoning summary',
      part: 'responses',
      send: e =>
        post(e, openCodeGoResponsesPath, bearer, {
          ...responsesBody,
          reasoning: { effort: 'low', summary: 'auto' }
        })
    },
    {
      label: 'Responses replay without the commentary phase',
      part: 'responses',
      send: e => {
        const input = replayBody.input

        return post(e, openCodeGoResponsesPath, bearer, {
          ...replayBody,
          input: Array.isArray(input)
            ? input.map((item, index) =>
                index === 1 ? { role: 'assistant', content: 'Checking.' } : item
              )
            : input
        })
      }
    },
    {
      label: 'usage without a credential',
      part: 'usage',
      send: e => get(e, openCodeGoUsagePath, {})
    },
    {
      label: 'usage with a query',
      part: 'usage',
      send: e => get(e, `${openCodeGoUsagePath}?window=weekly`, bearer)
    },
    {
      label: 'usage by POST',
      part: 'usage',
      send: e => post(e, openCodeGoUsagePath, bearer, {})
    }
  ]

  for (const rejection of rejections) {
    it(`answers 400 not-emulated for ${rejection.label}, leaving faults and turns untouched`, async () => {
      const emulator = makeOpenCodeGoEmulator()
      const part = emulator[rejection.part]

      armed(part)

      await expectNotEmulated(await rejection.send(emulator))
      expectUntouched(part)
    })
  }

  it('fails unknown routes as a ledgered 400 not-emulated through the chat part', async () => {
    const emulator = makeOpenCodeGoEmulator()

    await expectNotEmulated(await get(emulator, '/zen/go/v1/models', bearer))
    expect(emulator.chat.ledger.entries()).toMatchObject([
      { path: '/zen/go/v1/models', evidence: 'unknown-route', status: 400 }
    ])
    expect(emulator.coverage().unknownRouteRequests).toBe(1)
  })

  it('never records credential values', async () => {
    const emulator = makeOpenCodeGoEmulator()

    await post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)
    await post(emulator, openCodeGoMessagesPath, apiKey, messagesBody)
    await get(emulator, openCodeGoUsagePath, bearer)

    const recorded = JSON.stringify([
      emulator.chat.ledger.entries(),
      emulator.messages.ledger.entries(),
      emulator.usage.ledger.entries()
    ])

    expect(recorded).not.toContain('synthetic-go-key')
  })
})

describe('makeOpenCodeGoEmulator test controls', () => {
  it('applies the shared faults and scripted errors per part only', async () => {
    const emulator = makeOpenCodeGoEmulator()

    emulator.usage.faults.add({
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '3' },
      count: 1
    })

    const limited = await get(emulator, openCodeGoUsagePath, bearer)

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3')
    expect(await limited.json()).toEqual({
      error: { type: 'emulator_fault', message: 'Emulator fault: status 429.' }
    })
    expect((await post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)).status).toBe(200)

    emulator.responses.faults.add({ kind: 'truncate-after-chunks', chunks: 2, count: 1 })

    const truncated = await (
      await post(emulator, openCodeGoResponsesPath, bearer, responsesBody)
    ).text()

    expect(recordedText(openCodeGoResponsesPlainTextFixture).startsWith(truncated)).toBe(true)
    expect(truncated).not.toContain('response.completed')

    emulator.messages.script.enqueue({ error: { status: 500, body: { error: { message: 'x' } } } })

    expect((await post(emulator, openCodeGoMessagesPath, apiKey, messagesBody)).status).toBe(500)
    expect(emulator.messages.ledger.entries().at(-1)).toMatchObject({ scripted: 'error' })
  })

  it('refuses scripted turns and bodies no Go fixture records', async () => {
    const emulator = makeOpenCodeGoEmulator()

    // Stream routes take scripted errors only.
    expect(() => emulator.chat.script.enqueue({ usage: {} })).toThrow(
      OpenCodeGoEmulatorInputInvalid
    )
    expect(
      (
        await control(emulator, 'POST', '/_emulate/chat/script', {
          text: ['Hi.'],
          reasoning: ['x']
        })
      ).status
    ).toBe(400)
    expect(emulator.chat.script.pending()).toBe(0)

    // Usage bodies must keep the recorded shape: values may change, keys and kinds may not.
    expect(() =>
      emulator.usage.script.enqueue({ usage: { usage: { weekly: { percent: 5 } } } })
    ).toThrow(/recorded shape/)
    expect(() => makeOpenCodeGoEmulator({ subscriptionUsage: { usage: {} } })).toThrow(
      OpenCodeGoEmulatorInputInvalid
    )

    const otherValues = {
      usage: {
        rolling: { percent: 1, resetsAt: '2026-10-01T00:00:00.000Z' },
        weekly: { percent: 2, resetsAt: '2026-10-02T00:00:00.000Z' },
        monthly: { percent: 3, resetsAt: '2026-10-03T00:00:00.000Z' }
      }
    }

    emulator.usage.script.enqueue({ usage: otherValues })

    expect(await (await get(emulator, openCodeGoUsagePath, bearer)).json()).toEqual(otherValues)
    expect(await (await get(emulator, openCodeGoUsagePath, bearer)).json()).toEqual(
      openCodeGoUsageDefault
    )
    expect(emulator.usage.ledger.entries().map(entry => entry.scripted)).toEqual([
      'usage',
      undefined
    ])

    const custom = makeOpenCodeGoEmulator({ subscriptionUsage: otherValues })

    expect(await (await get(custom, openCodeGoUsagePath, bearer)).json()).toEqual(otherValues)
  })

  it('serves each part control plane under /_emulate/<part>, and combined coverage and reset', async () => {
    const emulator = makeOpenCodeGoEmulator()

    expect(
      (
        await control(emulator, 'POST', '/_emulate/responses/faults', {
          kind: 'status',
          status: 503,
          count: 1
        })
      ).status
    ).toBe(201)
    expect(emulator.responses.faults.list()).toHaveLength(1)
    expect((await post(emulator, openCodeGoResponsesPath, bearer, responsesBody)).status).toBe(503)
    expect(
      await (await control(emulator, 'GET', '/_emulate/responses/ledger')).json()
    ).toMatchObject({ entries: [{ status: 503, fault: 'status' }] })

    const coverage = await (await control(emulator, 'GET', '/_emulate/coverage')).json()

    expect(coverage).toEqual({
      routes: openCodeGoEmulatorRoutes.map(route => ({
        ...route,
        requests: route.path === openCodeGoResponsesPath ? 1 : 0
      })),
      unknownRouteRequests: 0
    })
    expect(emulator.coverage()).toEqual(coverage)

    expect((await control(emulator, 'GET', '/_emulate/ledger')).status).toBe(404)
    expect((await control(emulator, 'POST', '/_emulate/reset')).status).toBe(200)
    expect(emulator.responses.ledger.entries()).toEqual([])
    expect(emulator.responses.faults.list()).toEqual([])
  })
})

describe('openCodeGoEmulatorRoutes', () => {
  it('lists the four Go routes as unverified provider evidence for the Go cases', () => {
    expect(
      openCodeGoEmulatorRoutes.map(route => [
        route.method,
        route.path,
        route.evidence,
        route.caseIds
      ])
    ).toEqual([
      ['POST', '/zen/go/v1/chat/completions', 'unverified', ['opencode.go.chat.stream.plain-text']],
      ['POST', '/zen/go/v1/messages', 'unverified', ['opencode.go.messages.stream.plain-text']],
      [
        'POST',
        '/zen/go/v1/responses',
        'unverified',
        [
          'opencode.go.responses.stream.plain-text',
          'opencode.go.responses.stream.commentary-replay'
        ]
      ],
      ['GET', '/zen/go/v1/usage', 'unverified', ['opencode.go.usage.snapshot']]
    ])

    for (const route of openCodeGoEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'provider', write: false, observedAt: undefined })
    }
  })
})

describe('fault status range (fixture-only usage route)', () => {
  it('names the accepted range (400-599) when it refuses a fault status', () => {
    const emulator = makeOpenCodeGoEmulator()

    for (const status of [200, 302, 399, 600]) {
      expect(() => emulator.usage.faults.add({ kind: 'status', status }), String(status)).toThrow(
        /between 400 and 599/
      )
    }
  })
})
