/**
 * The OpenCode Go emulator: one origin serving Chat Completions, Messages, Responses, and usage
 * under `/zen/go/v1`, per-protocol auth, per-part ledgers, faults, turns, and control planes, the
 * combined coverage and reset, and the manifest.
 */
import { describe, expect, it } from 'vitest'
import { emulatorEvidenceHeader, EmulatorRouteUnmapped } from '../src/route-evidence.ts'
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
  type OpenCodeGoEmulator
} from '../src/opencode.ts'
import { makeSubscriptionUsageEmulator } from '../src/subscription-usage.ts'

const origin = 'https://opencode.ai'

const bearer = { authorization: 'Bearer synthetic-go-key' }

const post = (
  emulator: OpenCodeGoEmulator,
  path: string,
  headers: Record<string, string>,
  body: unknown
) =>
  emulator.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )

const get = (emulator: OpenCodeGoEmulator, path: string, headers: Record<string, string>) =>
  emulator.fetch(new Request(`${origin}${path}`, { headers }))

const control = (emulator: OpenCodeGoEmulator, method: string, path: string, body?: unknown) =>
  emulator.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )

const chatBody = { model: 'synthetic-go-chat', messages: [], stream: false, max_tokens: 16 }

const messagesBody = { model: 'synthetic-go-messages', messages: [], stream: false, max_tokens: 16 }

const responsesBody = {
  model: 'synthetic-go-responses',
  input: 'Hi',
  stream: false,
  max_output_tokens: 16
}

const anthropicVersion = { 'anthropic-version': '2023-06-01' }

describe('makeOpenCodeGoEmulator', () => {
  it('answers each protocol on its own path with evidence-tagged bodies', async () => {
    const emulator = makeOpenCodeGoEmulator()

    const chat = await post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)

    const messages = await post(
      emulator,
      openCodeGoMessagesPath,
      { 'x-api-key': 'synthetic-go-key', ...anthropicVersion },
      messagesBody
    )

    const responses = await post(emulator, openCodeGoResponsesPath, bearer, responsesBody)
    const usage = await get(emulator, openCodeGoUsagePath, bearer)

    expect(chat.status).toBe(200)
    expect((await chat.json()).object).toBe('chat.completion')
    expect(messages.status).toBe(200)
    expect((await messages.json()).type).toBe('message')
    expect(responses.status).toBe(200)
    expect((await responses.json()).status).toBe('completed')
    expect(usage.status).toBe(200)
    expect(await usage.json()).toEqual(openCodeGoUsageDefault)

    for (const response of [chat, messages, responses, usage]) {
      expect(response.headers.get(emulatorEvidenceHeader)).toBe('unverified')
    }

    // Each part has its own ledger, with the protocol's own fields.
    expect(emulator.chat.ledger.entries()).toMatchObject([
      { path: openCodeGoChatCompletionsPath, model: 'synthetic-go-chat', maxCompletionTokens: 16 }
    ])
    expect(emulator.messages.ledger.entries()).toMatchObject([
      { path: openCodeGoMessagesPath, credentialHeader: 'x-api-key', maxTokens: 16 }
    ])
    expect(emulator.responses.ledger.entries()).toMatchObject([
      { path: openCodeGoResponsesPath, maxOutputTokens: 16 }
    ])
    expect(emulator.usage.ledger.entries()).toMatchObject([
      { method: 'GET', path: openCodeGoUsagePath, credentialHeader: 'authorization', status: 200 }
    ])
  })

  it('enforces the credential each protocol sends: Bearer, or x-api-key for Messages', async () => {
    const emulator = makeOpenCodeGoEmulator()

    expect((await post(emulator, openCodeGoChatCompletionsPath, {}, chatBody)).status).toBe(401)
    expect((await post(emulator, openCodeGoResponsesPath, {}, responsesBody)).status).toBe(401)
    expect((await get(emulator, openCodeGoUsagePath, {})).status).toBe(401)

    // Messages takes an API key only: a bearer alone (a Claude OAuth shape) is refused.
    const bearerMessages = await post(
      emulator,
      openCodeGoMessagesPath,
      { ...bearer, ...anthropicVersion },
      messagesBody
    )

    expect(bearerMessages.status).toBe(401)
    expect(await bearerMessages.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Synthetic: an x-api-key header is required.'
      }
    })

    // Chat and Responses do not take x-api-key.
    expect(
      (
        await post(
          emulator,
          openCodeGoChatCompletionsPath,
          { 'x-api-key': 'synthetic-go-key' },
          chatBody
        )
      ).status
    ).toBe(401)

    // Credential values are never recorded.
    const recorded = JSON.stringify([
      emulator.chat.ledger.entries(),
      emulator.messages.ledger.entries(),
      emulator.responses.ledger.entries(),
      emulator.usage.ledger.entries()
    ])

    expect(recorded).not.toContain('synthetic-go-key')
  })

  it('uses the Go model list on every protocol and rejects unknown models', async () => {
    const emulator = makeOpenCodeGoEmulator()

    expect(openCodeGoEmulatorDefaultModels).toEqual([
      'synthetic-go-chat',
      'synthetic-go-messages',
      'synthetic-go-responses'
    ])

    const unknownChat = await post(emulator, openCodeGoChatCompletionsPath, bearer, {
      ...chatBody,
      model: 'nope'
    })

    expect(unknownChat.status).toBe(404)
    expect(await unknownChat.json()).toMatchObject({ error: { code: 'model_not_found' } })

    const unknownResponses = await post(emulator, openCodeGoResponsesPath, bearer, {
      ...responsesBody,
      model: 'nope'
    })

    expect(unknownResponses.status).toBe(400)

    const custom = makeOpenCodeGoEmulator({ knownModels: ['custom-go'] })

    expect(
      (
        await post(custom, openCodeGoChatCompletionsPath, bearer, {
          ...chatBody,
          model: 'custom-go'
        })
      ).status
    ).toBe(200)
  })

  it('streams each protocol with its framing', async () => {
    const emulator = makeOpenCodeGoEmulator()

    const chat = await (
      await post(emulator, openCodeGoChatCompletionsPath, bearer, {
        ...chatBody,
        stream: true,
        stream_options: { include_usage: true }
      })
    ).text()

    expect(chat.trim().endsWith('data: [DONE]')).toBe(true)
    expect(chat).toContain('"usage":')

    const messages = await (
      await post(
        emulator,
        openCodeGoMessagesPath,
        { 'x-api-key': 'synthetic-go-key', ...anthropicVersion },
        { ...messagesBody, stream: true }
      )
    ).text()

    expect(messages).toContain('event: message_start')
    expect(messages.trim().endsWith('data: {"type":"message_stop"}')).toBe(true)

    const responses = await (
      await post(emulator, openCodeGoResponsesPath, bearer, { ...responsesBody, stream: true })
    ).text()

    expect(responses).toContain('event: response.created')
    expect(responses).toContain('event: response.completed')
  })

  it('scripts reasoning_content for chat and usage bodies per part', async () => {
    const emulator = makeOpenCodeGoEmulator()

    emulator.chat.script.enqueue({ reasoning: ['Think.'], text: ['Done.'] })
    emulator.usage.script.enqueue({ usage: { usage: { weekly: { percent: 5 } } } })

    const chat = await (
      await post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)
    ).json()

    expect(chat.choices[0].message).toEqual({
      role: 'assistant',
      content: 'Done.',
      reasoning_content: 'Think.'
    })
    expect(await (await get(emulator, openCodeGoUsagePath, bearer)).json()).toEqual({
      usage: { weekly: { percent: 5 } }
    })
    expect(await (await get(emulator, openCodeGoUsagePath, bearer)).json()).toEqual(
      openCodeGoUsageDefault
    )
    expect(emulator.usage.ledger.entries().map(entry => entry.scripted)).toEqual([
      'usage',
      undefined
    ])

    const custom = makeOpenCodeGoEmulator({ usage: { usage: { rolling: null } } })

    expect(await (await get(custom, openCodeGoUsagePath, bearer)).json()).toEqual({
      usage: { rolling: null }
    })
  })

  it('applies faults per part only', async () => {
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
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    expect((await post(emulator, openCodeGoChatCompletionsPath, bearer, chatBody)).status).toBe(200)

    emulator.usage.faults.add({ kind: 'error-after-chunks', chunks: 0, count: 1 })

    const dropped = await get(emulator, openCodeGoUsagePath, bearer)

    await expect(dropped.text()).rejects.toThrow()
    expect(() => emulator.usage.faults.add({ kind: 'status', status: 302 })).toThrow(
      OpenCodeGoEmulatorInputInvalid
    )
    expect(
      (await control(emulator, 'POST', '/_emulate/messages/script', { text: [1] })).status
    ).toBe(400)
    expect(emulator.messages.script.pending()).toBe(0)
  })

  it('fails unknown routes closed through the chat part', async () => {
    const emulator = makeOpenCodeGoEmulator()

    const unknown = await get(emulator, '/zen/go/v1/models', bearer)

    expect(unknown.status).toBe(404)
    expect(emulator.chat.ledger.entries()).toMatchObject([
      { path: '/zen/go/v1/models', evidence: 'unknown-route', status: 404 }
    ])
    expect(emulator.coverage().unknownRouteRequests).toBe(1)
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
    expect(
      (await control(emulator, 'POST', '/_emulate/usage/script', { usage: { usage: {} } })).status
    ).toBe(201)
    expect(emulator.responses.faults.list()).toHaveLength(1)
    expect(emulator.usage.script.pending()).toBe(1)

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
    expect(emulator.usage.script.pending()).toBe(0)
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

  it('throws EmulatorRouteUnmapped when a usage manifest does not list its path', () => {
    expect(() =>
      makeSubscriptionUsageEmulator({
        path: '/elsewhere',
        routes: openCodeGoEmulatorRoutes.filter(route => route.path === openCodeGoUsagePath),
        usage: {},
        errorEnvelope: error => ({ error: { message: error.message } }),
        unauthorized: { message: 'no', type: 'auth', code: 'no' },
        headers: [],
        query: [],
        inputInvalid: (input, reason) => new Error(`${input}: ${reason}`)
      })
    ).toThrow(EmulatorRouteUnmapped)
  })
})
