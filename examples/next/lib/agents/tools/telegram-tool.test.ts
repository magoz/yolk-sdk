import { Effect, Predicate, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { makeAppTelegramToolModule, makeConnectorHttpRequest } from './telegram-tool'
import { ConnectorHttpRequest } from '@yolk-sdk/connectors'

describe('telegram connector tool adapter', () => {
  it('preserves connector JSON content type on Effect HTTP requests', () => {
    const request = makeConnectorHttpRequest(
      ConnectorHttpRequest.make({
        method: 'POST',
        url: 'https://api.telegram.org/botTOKEN/sendMessage',
        headers: { 'content-type': 'application/json' },
        body: '{"text":"hello"}'
      })
    )

    const body = request.body.toJSON()
    expect(Predicate.isTagged(body, 'Uint8Array')).toBe(true)
    expect(body).toMatchObject({
      body: '{"text":"hello"}',
      contentType: 'application/json'
    })
  })

  it.effect('keeps SchemaError wrapper on invalid Telegram arguments', () =>
    Effect.gen(function* () {
      const toolModule = makeAppTelegramToolModule({
        botToken: 'token',
        chatId: '1'
      })

      const tool = toolModule.tools[0]
      const validate = tool?.validate

      expect(validate).toBeDefined()

      if (validate === undefined) {
        return
      }

      const result = yield* validate(
        ToolCall.make({
          id: 'call_1',
          name: 'telegram_send_message',
          params: { message: false }
        })
      ).pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('ToolError')
        expect(result.failure.cause).toBe('validation')
        expect(result.failure.message).toContain('Invalid Telegram message arguments: SchemaError(')
      }
    })
  )
})
