import { describe, expect, it } from '@effect/vitest'
import { ProviderErrorInfo } from '@yolk-sdk/agent/protocol'
import { classifyProviderFailure, providerErrorInfo } from '../../src/providers/provider-error.ts'

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
})
