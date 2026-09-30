import { describe, expect, it } from 'vitest'
import type { WireChunk, WireExchange } from '../../packages/conformance/src/fixture.ts'
import {
  accountIdentifierFields,
  isCiEnvironment,
  parseFlags,
  redactExchange,
  redactionRefusal,
  unredactedFields,
  unscannablePayloads,
  type RedactionSpec
} from '../fixture-probe-internal.ts'

const spec: RedactionSpec = {
  fields: ['signature', ...accountIdentifierFields],
  placeholder: 'redacted',
  permittedNonJson: ['[DONE]']
}

const request = { method: 'GET', url: 'https://api.example.test/usage' }

const stream = (chunks: ReadonlyArray<WireChunk>): WireExchange => ({
  request,
  response: { status: 200, headers: { 'content-type': 'text/event-stream' }, chunks }
})

const body = (text: string): WireExchange => ({
  request,
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: text }
})

const base64 = (text: string) => ({ base64: Buffer.from(text, 'utf8').toString('base64') })

describe('isCiEnvironment', () => {
  it('treats any non-empty CI value as CI, 0 and false included', () => {
    for (const CI of ['true', '1', '0', 'false', ' ']) expect(isCiEnvironment({ CI })).toBe(true)

    for (const CI of [undefined, '']) expect(isCiEnvironment({ CI })).toBe(false)
  })
})

describe('parseFlags', () => {
  it('reads --flag value and --flag=value, and refuses a missing value', () => {
    const seen: Array<[string, string]> = []

    parseFlags(['--a', 'one', '--b=two', '--c'], (flag, _argument, value) => {
      seen.push([flag, flag === '--c' ? '' : value()])
    })

    expect(seen).toEqual([
      ['--a', 'one'],
      ['--b', 'two'],
      ['--c', '']
    ])
    expect(() => parseFlags(['--a'], (_flag, _argument, value) => value())).toThrow(
      '--a requires a value'
    )
  })
})

describe('redactExchange and redactionRefusal', () => {
  it('redacts string values in a body and in each text chunk, keeping every boundary', () => {
    const redacted = redactExchange(
      body('{"user_id":"u-123","email":"someone@example.test","used_percent":3}'),
      spec
    )

    expect('body' in redacted.response ? redacted.response.body : '').toBe(
      '{"user_id":"redacted","email":"redacted","used_percent":3}'
    )
    expect(redactionRefusal([redacted], spec)).toBeUndefined()

    const chunks = ['data: {"a":1,"signature":"sig-1"}\n\n', 'data: [DONE]\n\n']
    const streamed = redactExchange(stream(chunks), spec)

    expect('chunks' in streamed.response ? streamed.response.chunks : []).toEqual([
      'data: {"a":1,"signature":"redacted"}\n\n',
      'data: [DONE]\n\n'
    ])
    expect(redactionRefusal([streamed], spec)).toBeUndefined()
    // Unchanged exchanges are returned as is.
    const clean = body('{"five_hour":{"utilization":1}}')

    expect(redactExchange(clean, spec)).toBe(clean)
  })

  it('refuses a value left in a base64 chunk or split across chunks', () => {
    const inBase64 = redactExchange(stream([base64('data: {"user":"someone"}\n\n')]), spec)

    expect(unredactedFields([inBase64], spec)).toEqual(['user'])

    const split = redactExchange(stream(['data: {"user":"some', 'one"}\n\n']), spec)

    expect(unredactedFields([split], spec)).toEqual(['user'])
    expect(redactionRefusal([split], spec)).toContain('could not redact user')
  })

  it('refuses non-string values and repeated keys, allowing null and the placeholder', () => {
    expect(unredactedFields([body('{"account_id":12345}')], spec)).toEqual(['account_id'])
    expect(unredactedFields([body('{"user":"redacted","user":"redacted"}')], spec)).toEqual([
      'user'
    ])
    expect(unredactedFields([body('{"user":null,"email":"","userId":"redacted"}')], spec)).toEqual(
      []
    )
    // Escaped keys are decoded before the check.
    expect(unredactedFields([body('{"us\\u0065r_id":"u-1"}')], spec)).toEqual(['user_id'])
  })

  it('refuses unscannable payloads, never falling back to a textual check', () => {
    expect(unscannablePayloads([body('not json')], spec)).toBe(1)
    expect(unscannablePayloads([body(`${'['.repeat(300)}${']'.repeat(300)}`)], spec)).toBe(1)
    expect(
      unscannablePayloads([stream([': comment\ndata: {"a":1}\n\n', 'data: [DONE]\n\n'])], spec)
    ).toBe(1)
    expect(redactionRefusal([body('not json')], spec)).toContain('could not check 1 response')
    // Only the permitted sentinels pass, and an empty body carries nothing to scan.
    expect(unscannablePayloads([stream(['data: [DONE]\n\n'])], spec)).toBe(0)
    expect(
      unscannablePayloads([stream(['data: [DONE]\n\n'])], { ...spec, permittedNonJson: [] })
    ).toBe(1)
    expect(unscannablePayloads([body('')], spec)).toBe(0)
  })
})
