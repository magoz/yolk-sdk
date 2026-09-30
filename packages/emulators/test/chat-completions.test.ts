/**
 * The shared Chat Completions core, through both emulators that use it: the same framing and
 * control behaviour, with the per-emulator parameters (envelope, unknown-model status, auth
 * error, completion-token field, reasoning) kept apart.
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
    unknownModelStatus: 400
  },
  {
    name: 'openai',
    origin: 'https://api.openai.com',
    make: () => makeOpenAiEmulator(),
    model: 'gpt-4.1-nano',
    field: 'max_completion_tokens',
    otherField: 'max_tokens',
    unknownModelStatus: 404
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
      } = JSON.parse(data)

      return {
        deltaKeys: payload.choices.map(choice => Object.keys(choice.delta).sort()),
        finish: payload.choices.map(choice => choice.finish_reason),
        usage: payload.usage !== undefined
      }
    })

describe('shared chat completions core', () => {
  it('frames the same SSE events for both emulators', async () => {
    const framings = await Promise.all(
      emulators.map(async emulator => {
        const response = await post(emulator.make(), emulator.origin, {
          model: emulator.model,
          messages: [{ role: 'user', content: 'Say hello.' }],
          stream: true,
          stream_options: { include_usage: true }
        })

        return eventFraming(await response.text())
      })
    )

    expect(framings[0]).toEqual(framings[1])
    expect(framings[0]?.at(-1)).toBe('[DONE]')
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
      expect((await response.json()).error.code).toBe('model_not_found')
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
