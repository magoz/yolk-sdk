import { Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { propertyOptions } from '../../../../../../../test/property/options'
import { forwardedHeaders, forwardHeaderNames } from './route-model'

const headersArbitrary = Schema.toArbitrary(Schema.Record(Schema.String, Schema.String))

describe('Cloudflare Codex responses proxy', () => {
  it('forwards only allowlisted Codex headers', () => {
    expect(
      forwardedHeaders({
        accept: 'application/json',
        authorization: 'Bearer token',
        'content-type': 'application/json',
        originator: 'opencode',
        'chatgpt-account-id': 'account_1',
        cookie: 'secret',
        'x-yolk-cloudflare-secret': 'bridge-secret'
      })
    ).toEqual({
      accept: 'application/json',
      authorization: 'Bearer token',
      'content-type': 'application/json',
      originator: 'opencode',
      'chatgpt-account-id': 'account_1'
    })
  })

  it.prop(
    'forwarded headers are always a subset of the allowlist',
    [headersArbitrary],
    ([headers]) => {
      const forwarded = forwardedHeaders(headers)
      const forwardedNames = Object.keys(forwarded)

      expect(forwardedNames.every(name => forwardHeaderNames.includes(name))).toBe(true)
      for (const name of forwardHeaderNames) {
        if (headers[name] === undefined) {
          expect(forwarded[name]).toBeUndefined()
        } else {
          expect(forwarded[name]).toBe(headers[name])
        }
      }
    },
    propertyOptions
  )
})
