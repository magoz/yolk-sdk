import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { LLMError } from '@yolk-sdk/agent/loop'
import { SessionLoadError } from '@yolk-sdk/agent/runtime'
import { cloudflareRuntimeErrorToAgentError } from '../src/cloudflare-error.ts'

describe('cloudflareRuntimeErrorToAgentError', () => {
  it('delegates known runtime and loop errors', () => {
    expect(
      cloudflareRuntimeErrorToAgentError(
        new SessionLoadError({ sessionId: 'session_1', message: 'storage unavailable' })
      )
    ).toMatchObject({ code: 'store_error', message: 'storage unavailable', retryable: true })

    expect(
      cloudflareRuntimeErrorToAgentError(
        new LLMError({ cause: 'rate_limit', message: 'slow down', retryable: true })
      )
    ).toMatchObject({ code: 'rate_limit', message: 'slow down', retryable: true })
  })

  it.effect('maps schema errors to unknown', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(Schema.String)(123).pipe(Effect.result)

      if (result._tag === 'Success') {
        expect.fail('Expected schema decode failure')
      }

      expect(cloudflareRuntimeErrorToAgentError(result.failure)).toMatchObject({
        code: 'unknown',
        retryable: false
      })
    })
  )
})
