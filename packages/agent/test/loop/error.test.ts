import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AbortError,
  agentLoopErrorToAgentError,
  FauxExhaustedError,
  LLMError,
  ToolError
} from '../../src/loop'
import { AgentError, ProviderErrorInfo, ProviderStreamDiagnostics } from '@yolk-sdk/agent/protocol'

describe('agentLoopErrorToAgentError', () => {
  it('maps LLM errors directly to wire codes', () => {
    expect(
      agentLoopErrorToAgentError(
        new LLMError({
          cause: 'validation_error',
          message: 'bad input',
          retryable: false
        })
      )
    ).toMatchObject({ code: 'validation_error', message: 'bad input', retryable: false })
  })

  it('preserves LLM provider metadata on wire errors', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'openai',
      kind: 'overloaded',
      status: 529,
      providerCode: 'overloaded_error',
      retryAfterMs: 250
    })

    expect(
      agentLoopErrorToAgentError(
        new LLMError({
          cause: 'overloaded',
          message: 'provider overloaded',
          retryable: true,
          provider
        })
      )
    ).toMatchObject({
      code: 'overloaded',
      message: 'provider overloaded',
      retryable: true,
      provider
    })
  })

  it('maps tool causes to canonical wire codes', () => {
    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'bad args', cause: 'invalid_input' })
      )
    ).toMatchObject({ code: 'validation_error', message: 'bad args', retryable: false })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'blocked', cause: 'denied' })
      )
    ).toMatchObject({ code: 'tool_denied', message: 'blocked', retryable: false })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'late', cause: 'timeout' })
      )
    ).toMatchObject({ code: 'tool_timeout', message: 'late', retryable: true })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'missing', cause: 'not_found' })
      )
    ).toMatchObject({ code: 'tool_error', message: 'missing', retryable: false })
  })

  it('maps abort and faux exhaustion errors', () => {
    expect(agentLoopErrorToAgentError(new AbortError({ reason: 'system' }))).toMatchObject({
      code: 'aborted',
      message: 'Agent run aborted: system',
      retryable: true
    })

    expect(
      agentLoopErrorToAgentError(new FauxExhaustedError({ message: 'no more faux responses' }))
    ).toMatchObject({
      code: 'provider_error',
      message: 'no more faux responses',
      retryable: false
    })
  })
})

describe('LLMError', () => {
  it.effect('round-trips without responseIssue for existing payloads', () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(LLMError)({
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'truncated',
        retryable: false
      })

      expect(decoded.responseIssue).toBeUndefined()

      const encoded = yield* Schema.encodeUnknownEffect(LLMError)(
        new LLMError({
          cause: 'invalid_response',
          message: 'truncated',
          retryable: false
        })
      )

      expect(encoded).toMatchObject({
        _tag: 'LLMError',
        cause: 'invalid_response',
        retryable: false
      })
      expect(
        Predicate.isObjectOrArray(encoded) && 'responseIssue' in encoded
          ? encoded.responseIssue
          : undefined
      ).toBeUndefined()
    })
  )

  it.effect('round-trips missing_done responseIssue', () =>
    Effect.gen(function* () {
      const error = new LLMError({
        cause: 'invalid_response',
        message: 'Expected exactly one LLM done event, received 0',
        retryable: false,
        responseIssue: 'missing_done'
      })

      const encoded = yield* Schema.encodeUnknownEffect(LLMError)(error)
      const decoded = yield* Schema.decodeUnknownEffect(LLMError)(encoded)
      expect(Predicate.isTagged(decoded, 'LLMError')).toBe(true)
      expect(decoded).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        responseIssue: 'missing_done'
      })
      expect(agentLoopErrorToAgentError(decoded)).toMatchObject({
        code: 'invalid_response',
        retryable: false
      })
      expect('responseIssue' in agentLoopErrorToAgentError(decoded)).toBe(false)
    })
  )

  it.effect('round-trips provider stream diagnostics through LLMError and AgentError', () =>
    Effect.gen(function* () {
      const error = new LLMError({
        cause: 'invalid_response',
        message: 'stream ended before a terminal chunk',
        retryable: false,
        provider: ProviderErrorInfo.make({
          provider: 'opencode_go',
          kind: 'invalid_response',
          providerCode: 'incomplete_stream',
          stream: ProviderStreamDiagnostics.make({
            protocol: 'chat-completions',
            responseFormat: 'sse',
            receivedBytes: 128,
            bufferedChars: 0,
            outputStarted: true,
            terminalSeen: false
          })
        })
      })

      const encoded = yield* Schema.encodeUnknownEffect(LLMError)(error)
      const decoded = yield* Schema.decodeUnknownEffect(LLMError)(encoded)

      expect(Predicate.isTagged(decoded, 'LLMError')).toBe(true)
      expect(decoded).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        provider: {
          provider: 'opencode_go',
          providerCode: 'incomplete_stream',
          stream: {
            protocol: 'chat-completions',
            responseFormat: 'sse',
            receivedBytes: 128,
            bufferedChars: 0,
            outputStarted: true,
            terminalSeen: false
          }
        }
      })

      const agentError = agentLoopErrorToAgentError(decoded)

      expect(agentError).toMatchObject({
        code: 'invalid_response',
        retryable: false,
        provider: {
          providerCode: 'incomplete_stream',
          stream: { receivedBytes: 128, terminalSeen: false }
        }
      })

      const encodedAgentError = yield* Schema.encodeUnknownEffect(AgentError)(agentError)

      const decodedAgentError = yield* Schema.decodeUnknownEffect(AgentError)(encodedAgentError)

      expect(decodedAgentError).toMatchObject({
        code: 'invalid_response',
        provider: { stream: { receivedBytes: 128, responseFormat: 'sse' } }
      })
    })
  )

  it.effect('decodes legacy provider errors without stream diagnostics unchanged', () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(LLMError)({
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'truncated',
        retryable: false,
        provider: {
          provider: 'openai',
          kind: 'invalid_response',
          providerCode: 'incomplete_stream'
        }
      })

      expect(decoded.provider?.stream).toBeUndefined()
      expect(Object.hasOwn(decoded.provider ?? {}, 'stream')).toBe(false)
    })
  )

  it.effect('rejects invalid provider stream diagnostics', () =>
    Effect.gen(function* () {
      const base = {
        _tag: 'LLMError',
        cause: 'invalid_response',
        message: 'truncated',
        retryable: false,
        provider: {
          provider: 'openai',
          kind: 'invalid_response',
          providerCode: 'incomplete_stream'
        }
      }

      const invalid = [
        {
          protocol: 'chat-completions',
          responseFormat: 'xml',
          receivedBytes: 1,
          bufferedChars: 1,
          outputStarted: false,
          terminalSeen: false
        },
        {
          protocol: 'smtp',
          responseFormat: 'sse',
          receivedBytes: 1,
          bufferedChars: 1,
          outputStarted: false,
          terminalSeen: false
        },
        {
          protocol: 'chat-completions',
          responseFormat: 'sse',
          receivedBytes: -1,
          bufferedChars: 1,
          outputStarted: false,
          terminalSeen: false
        },
        {
          protocol: 'chat-completions',
          responseFormat: 'sse',
          receivedBytes: 1.5,
          bufferedChars: 1,
          outputStarted: false,
          terminalSeen: false
        },
        {
          protocol: 'chat-completions',
          responseFormat: 'sse',
          receivedBytes: 1,
          bufferedChars: -2,
          outputStarted: false,
          terminalSeen: false
        },
        {
          protocol: 'chat-completions',
          responseFormat: 'sse',
          receivedBytes: 1,
          bufferedChars: 1,
          outputStarted: 'yes',
          terminalSeen: false
        }
      ]

      for (const stream of invalid) {
        const decoded = Schema.decodeUnknownOption(LLMError)({
          ...base,
          provider: { ...base.provider, stream }
        })

        expect(Option.isNone(decoded)).toBe(true)
      }
    })
  )

  it('omits provider on LLM wire errors when absent', () => {
    const omitted = agentLoopErrorToAgentError(
      new LLMError({
        cause: 'provider_error',
        message: 'down',
        retryable: true
      })
    )

    expect(Object.keys(omitted)).toEqual(['_tag', 'code', 'message', 'retryable'])
    expect(JSON.stringify(omitted)).toBe(
      '{"_tag":"AgentError","code":"provider_error","message":"down","retryable":true}'
    )
    expect(Object.hasOwn(omitted, 'provider')).toBe(false)
  })
})
