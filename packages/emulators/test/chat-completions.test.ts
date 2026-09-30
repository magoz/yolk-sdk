/**
 * The shared Chat Completions core, through both emulators that use it: the same control
 * behaviour, with the per-emulator parameters (envelope, unknown-model status, auth error,
 * completion-token field, reasoning, and the wire profile: chunk packing, usage placement, and
 * extra chunk fields) kept apart.
 */
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  ChatScriptedReasoningTurn,
  makeChatCompletionsEmulator,
  type ChatCompletionsEmulator
} from '../src/chat-completions.ts'
import { gatewayEmulatorRoutes, makeGatewayEmulator } from '../src/gateway.ts'
import { makeOpenAiEmulator } from '../src/openai.ts'
import { EmulatorRouteUnmapped } from '../src/route-evidence.ts'

type Emulator = Pick<ChatCompletionsEmulator<never>, 'fetch' | 'ledger'>

const post = (emulator: Emulator, origin: string, body: Schema.JsonObject) =>
  emulator.fetch(
    new Request(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

const emulators = [
  {
    name: 'gateway',
    origin: 'https://ai-gateway.vercel.sh',
    make: () => makeGatewayEmulator(),
    model: 'openai/gpt-4.1-nano',
    field: 'max_tokens',
    otherField: 'max_completion_tokens',
    unknownModelStatus: 404,
    // The recorded Gateway envelope has no `code`; its `type` names the error.
    unknownModelError: {
      message: "Model 'yolk-conformance/model-does-not-exist' not found",
      type: 'model_not_found',
      param: { modelId: 'yolk-conformance/model-does-not-exist' }
    }
  },
  {
    name: 'openai',
    origin: 'https://api.openai.com',
    make: () => makeOpenAiEmulator(),
    model: 'gpt-4.1-nano',
    field: 'max_completion_tokens',
    otherField: 'max_tokens',
    unknownModelStatus: 404,
    unknownModelError: {
      message: expect.any(String),
      type: 'invalid_request_error',
      param: null,
      code: 'model_not_found'
    }
  }
] as const

/** The SSE event framing with volatile values (ids, models, text) stripped. */
const eventFraming = (text: string) =>
  text
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => block.slice('data: '.length))
    .map(data => {
      if (data === '[DONE]') return '[DONE]'

      const payload: {
        readonly choices: ReadonlyArray<{
          readonly delta: Schema.JsonObject
          readonly finish_reason: string | null
        }>
        readonly usage?: unknown
      } & Schema.JsonObject = JSON.parse(data)

      return {
        keys: Object.keys(payload).sort(),
        deltaKeys: payload.choices.map(choice => Object.keys(choice.delta).sort()),
        finish: payload.choices.map(choice => choice.finish_reason),
        usage: payload.usage !== undefined
      }
    })

const streamedPlainText = async (emulator: (typeof emulators)[number]) => {
  const response = await post(emulator.make(), emulator.origin, {
    model: emulator.model,
    messages: [{ role: 'user', content: 'Say hello.' }],
    stream: true,
    stream_options: { include_usage: true }
  })

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  const chunks: Array<string> = []

  for (let next = await reader?.read(); next !== undefined && !next.done;) {
    chunks.push(decoder.decode(next.value))
    next = await reader?.read()
  }

  return { chunks, framing: eventFraming(chunks.join('')) }
}

const chunkKeys = ['choices', 'created', 'id', 'model', 'object']

describe('shared chat completions core', () => {
  it('openai: frames the plain OpenAI wire, one event per chunk and a separate usage chunk', async () => {
    const [, openai] = emulators
    const { chunks, framing } = await streamedPlainText(openai)
    const textEvent = { keys: chunkKeys, deltaKeys: [['content']], finish: [null], usage: false }

    expect(framing).toEqual([
      { keys: chunkKeys, deltaKeys: [['content', 'role']], finish: [null], usage: false },
      textEvent,
      textEvent,
      textEvent,
      { keys: chunkKeys, deltaKeys: [[]], finish: ['stop'], usage: false },
      { keys: [...chunkKeys, 'usage'].sort(), deltaKeys: [], finish: [], usage: true },
      '[DONE]'
    ])
    expect(chunks).toHaveLength(framing.length)
  })

  it('gateway: frames the recorded Gateway wire, packed events and usage on the finish event', async () => {
    const [gateway] = emulators
    const { chunks, framing } = await streamedPlainText(gateway)
    const keys = [...chunkKeys, 'system_fingerprint'].sort()
    const textEvent = { keys, deltaKeys: [['content']], finish: [null], usage: false }

    expect(framing).toEqual([
      { keys, deltaKeys: [['role']], finish: [null], usage: false },
      textEvent,
      textEvent,
      textEvent,
      {
        keys: [...keys, 'generationId', 'service_tier', 'usage'].sort(),
        deltaKeys: [['provider_metadata']],
        finish: ['stop'],
        usage: true
      },
      '[DONE]'
    ])
    expect(chunks).toHaveLength(framing.length / 2)
  })

  for (const emulator of emulators) {
    it(`${emulator.name}: records ${emulator.field} as maxCompletionTokens, never validated`, async () => {
      const instance = emulator.make()
      const request = { model: emulator.model, messages: [], stream: false }

      await (await post(instance, emulator.origin, { ...request, [emulator.field]: 48 })).text()
      await (
        await post(instance, emulator.origin, { ...request, [emulator.otherField]: 48 })
      ).text()

      const invalid = await post(instance, emulator.origin, { ...request, [emulator.field]: 'x' })

      expect(invalid.status).toBe(200)
      expect(instance.ledger.entries().map(entry => entry.maxCompletionTokens)).toEqual([
        48,
        undefined,
        undefined
      ])
    })

    it(`${emulator.name}: answers an unknown model with ${emulator.unknownModelStatus}`, async () => {
      const response = await post(emulator.make(), emulator.origin, {
        model: 'yolk-conformance/model-does-not-exist',
        messages: []
      })

      expect(response.status).toBe(emulator.unknownModelStatus)
      expect(await response.json()).toEqual({ error: emulator.unknownModelError })
    })
  }

  it('throws EmulatorRouteUnmapped when the manifest does not list the chat path', () => {
    expect(() =>
      makeChatCompletionsEmulator({
        path: '/v2/chat/completions',
        routes: gatewayEmulatorRoutes,
        knownModels: [],
        reasoningModels: undefined,
        errorEnvelope: error => ({ error: { ...error } }),
        unknownModel: { status: 404, error: { message: 'x', type: 'x', code: 'x' } },
        auth: { unauthorized: { message: 'x', type: 'x', code: 'x' } },
        completionTokenField: 'max_tokens',
        responseIdPrefix: 'synthetic',
        defaultText: ['x'],
        turnSchema: ChatScriptedReasoningTurn,
        inputInvalid: (input, reason) => new Error(`${input}: ${reason}`)
      })
    ).toThrow(EmulatorRouteUnmapped)
  })
})
