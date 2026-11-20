import { describe, expect, it } from '@effect/vitest'
import { ProviderErrorInfo } from '@yolk-sdk/agent/protocol'
import {
  classifyProviderFailure,
  echoedParamValues,
  providerErrorInfo,
  providerFailureKind,
  providerFailureRetryable
} from '../../src/providers/provider-error.ts'

describe('providerErrorInfo omission', () => {
  it('omits absent status, providerCode, and retryAfterMs', () => {
    const info = providerErrorInfo({ provider: 'openai', kind: 'unknown' })

    expect(info).toBeInstanceOf(ProviderErrorInfo)
    expect(Object.keys(info)).toEqual(['provider', 'kind'])
    expect(JSON.stringify(info)).toBe('{"provider":"openai","kind":"unknown"}')
    expect(Object.hasOwn(info, 'retryAfterMs')).toBe(false)
  })

  it('keeps present and zero optional fields in constructor order', () => {
    const present = providerErrorInfo({
      provider: 'openai',
      kind: 'rate_limit',
      status: 429,
      providerCode: 'rate_limit_exceeded',
      retryAfterMs: 250
    })

    expect(Object.keys(present)).toEqual([
      'provider',
      'kind',
      'status',
      'providerCode',
      'retryAfterMs'
    ])
    expect(JSON.stringify(present)).toBe(
      '{"provider":"openai","kind":"rate_limit","status":429,"providerCode":"rate_limit_exceeded","retryAfterMs":250}'
    )

    const zero = providerErrorInfo({
      provider: 'openai',
      kind: 'rate_limit',
      status: 0,
      retryAfterMs: 0
    })

    expect(Object.keys(zero)).toEqual(['provider', 'kind', 'status', 'retryAfterMs'])
    expect(JSON.stringify(zero)).toBe(
      '{"provider":"openai","kind":"rate_limit","status":0,"retryAfterMs":0}'
    )
  })
})

describe('classifyProviderFailure omission', () => {
  it('omits retryAfterMs when headers are absent', () => {
    const info = classifyProviderFailure({ provider: 'openai', status: 500 })

    expect(Object.keys(info)).toEqual(['provider', 'kind', 'status'])
    expect(JSON.stringify(info)).toBe('{"provider":"openai","kind":"server_error","status":500}')
    expect(Object.hasOwn(info, 'retryAfterMs')).toBe(false)
  })

  it('reads defined headers even when delay is undefined and omits the outer retryAfterMs key', () => {
    const reads: Array<string> = []

    const headers = {
      get 'content-type'() {
        reads.push('content-type')

        return 'text/plain'
      }
    }

    const info = classifyProviderFailure({
      provider: 'openai',
      status: 429,
      headers
    })

    expect(reads).toEqual(['content-type', 'content-type'])
    expect(Object.keys(info)).toEqual(['provider', 'kind', 'status'])
    expect(JSON.stringify(info)).toBe('{"provider":"openai","kind":"rate_limit","status":429}')
    expect(Object.hasOwn(info, 'retryAfterMs')).toBe(false)
  })

  it('assigns retryAfterMs from defined headers when a delay is present', () => {
    const reads: Array<string> = []

    const headers = {
      get 'retry-after-ms'() {
        reads.push('retry-after-ms')

        return '1500'
      }
    }

    const info = classifyProviderFailure({
      provider: 'openai',
      status: 429,
      headers
    })

    expect(reads).toEqual(['retry-after-ms'])
    expect(Object.keys(info)).toEqual(['provider', 'kind', 'status', 'retryAfterMs'])
    expect(JSON.stringify(info)).toBe(
      '{"provider":"openai","kind":"rate_limit","status":429,"retryAfterMs":1500}'
    )
  })

  it('keeps the headers-present path when retry-after cannot be parsed', () => {
    const reads: Array<string> = []

    const headers = {
      get 'retry-after'() {
        reads.push('retry-after')

        return 'nope'
      }
    }

    const info = classifyProviderFailure({
      provider: 'openai',
      status: 500,
      headers
    })

    expect(reads).toEqual(['retry-after', 'retry-after'])
    expect(Object.keys(info)).toEqual(['provider', 'kind', 'status'])
    expect(JSON.stringify(info)).toBe('{"provider":"openai","kind":"server_error","status":500}')
    expect(Object.hasOwn(info, 'retryAfterMs')).toBe(false)
  })

  it('never copies echoed values into the failure info', () => {
    const info = classifyProviderFailure({
      provider: 'openai',
      status: 404,
      providerCode: 'model_not_found',
      echoedValues: ['acme/overloaded']
    })

    expect(JSON.stringify(info)).toBe(
      '{"provider":"openai","kind":"unknown","status":404,"providerCode":"model_not_found"}'
    )
  })
})

type KindInput = Omit<Parameters<typeof providerFailureKind>[0], 'provider'>

const kindOf = (input: KindInput) => providerFailureKind({ provider: 'openai', ...input })

describe('providerFailureKind precedence', () => {
  it('takes a code that names a kind before the status and the text', () => {
    expect(kindOf({ status: 400, providerCode: 'context_length_exceeded' })).toBe(
      'context_overflow'
    )
    expect(kindOf({ status: 529, providerCode: 'overloaded_error', body: 'rate limit' })).toBe(
      'overloaded'
    )
    expect(kindOf({ providerCode: 'rate_limit_exceeded' })).toBe('rate_limit')
  })

  it('never lets text make a status that is not retryable retryable', () => {
    for (const status of [400, 401, 404, 413, 422]) {
      for (const body of ['overloaded', 'rate_limit', 'Too many requests', 'service unavailable']) {
        expect(providerFailureRetryable(kindOf({ status, body })), `${status} ${body}`).toBe(false)
      }
    }

    expect(kindOf({ status: 404, providerCode: 'model_not_found', body: 'overloaded' })).toBe(
      'unknown'
    )
    expect(kindOf({ status: 401, body: 'rate limit' })).toBe('auth')
    expect(kindOf({ status: 413, body: 'overloaded' })).toBe('context_overflow')
  })

  it('lets text name a non-retryable kind, or a retryable one for a retryable status', () => {
    expect(
      kindOf({
        status: 400,
        providerCode: 'invalid_request_error',
        message: 'prompt is too long'
      })
    ).toBe('context_overflow')
    expect(kindOf({ status: 503, body: 'Service Unavailable' })).toBe('overloaded')
    expect(kindOf({ status: 500, message: 'rate limit reached' })).toBe('rate_limit')
    expect(kindOf({ status: 500, message: 'context length exceeded' })).toBe('context_overflow')
    expect(kindOf({ status: 429, message: 'too many tokens' })).toBe('context_overflow')
  })

  it('falls back to the text when there is no status (stream error events)', () => {
    expect(kindOf({ message: 'backend overloaded' })).toBe('overloaded')
    expect(kindOf({ providerCode: 'server_error', message: 'The server is overloaded' })).toBe(
      'overloaded'
    )
    expect(kindOf({ providerCode: 'server_error', message: 'An error occurred' })).toBe('unknown')
    expect(kindOf({ providerCode: 'max_output_tokens', fallbackKind: 'invalid_response' })).toBe(
      'invalid_response'
    )
  })

  it('removes echoed request values from the text before scanning it', () => {
    const model = 'acme/Overloaded-rate_limit-context_length'
    const message = `model ${model} failed`

    expect(kindOf({ message })).toBe('rate_limit')
    expect(kindOf({ message, echoedValues: [model] })).toBe('unknown')
    expect(
      kindOf({
        status: 503,
        body: JSON.stringify({ error: { message: `Model '${model}'`, param: { modelId: model } } }),
        echoedValues: [model]
      })
    ).toBe('server_error')
    expect(kindOf({ message: 'overloaded', echoedValues: ['', '  '] })).toBe('overloaded')
  })

  it('removes echoed values from the decoded JSON body, whatever its escapes', () => {
    const model = 'acme/context_length-preview'

    for (const body of [
      '{"error":{"message":"Model acme\\/context_length-preview unavailable"}}',
      '{"error":{"message":"Model acme\\u002fcontext_length-preview unavailable"}}'
    ]) {
      expect(kindOf({ status: 503, body, echoedValues: [model] }), body).toBe('server_error')
    }
  })

  it('reads the decoded strings of a JSON body and the text of any other body', () => {
    expect(kindOf({ status: 503, body: '{"error":{"message":"Service\\u0020Unavailable"}}' })).toBe(
      'overloaded'
    )
    expect(kindOf({ status: 503, body: 'Service Unavailable' })).toBe('overloaded')
    expect(kindOf({ status: 503, body: '{"error":{"param":{"modelId":"overloaded"}}}' })).toBe(
      'server_error'
    )
  })

  it('keeps a string param and ignores echoed values shorter than three characters', () => {
    const body = JSON.stringify({
      error: { message: 'input is too long', type: 'invalid_request_error', param: 'input' }
    })

    expect(
      kindOf({
        status: 400,
        body,
        providerCode: 'invalid_request_error',
        echoedValues: echoedParamValues('input')
      })
    ).toBe('context_overflow')
    expect(kindOf({ status: 400, message: 'input is too long', echoedValues: ['n', 'in'] })).toBe(
      'context_overflow'
    )
  })

  it('classifies a further structured code when the provider code names no kind', () => {
    expect(
      kindOf({ status: 400, providerCode: 'specific_error_code', kindCodes: ['overloaded_error'] })
    ).toBe('overloaded')
    expect(kindOf({ providerCode: 'specific_error_code', kindCodes: ['rate_limit_error'] })).toBe(
      'rate_limit'
    )
    expect(
      kindOf({ status: 529, providerCode: 'rate_limit_error', kindCodes: ['overloaded_error'] })
    ).toBe('rate_limit')
  })

  it('treats a 408 request timeout as a retryable network failure', () => {
    expect(kindOf({ status: 408 })).toBe('network')
    expect(providerFailureRetryable(kindOf({ status: 408 }))).toBe(true)
    expect(kindOf({ status: 409 })).toBe('unknown')
    expect(kindOf({ status: 425 })).toBe('unknown')
  })
})

describe('echoedParamValues', () => {
  it('reads the string fields of a param object, never a parameter name', () => {
    expect(echoedParamValues('model')).toEqual([])
    expect(echoedParamValues('input')).toEqual([])
    expect(echoedParamValues({ modelId: 'acme/model', retries: 2, nested: { id: 'x' } })).toEqual([
      'acme/model'
    ])
    expect(echoedParamValues(['model'])).toEqual([])
    expect(echoedParamValues(null)).toEqual([])
    expect(echoedParamValues(undefined)).toEqual([])
  })
})
