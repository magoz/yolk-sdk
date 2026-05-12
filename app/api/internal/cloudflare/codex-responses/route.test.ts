import { describe, expect, it } from '@effect/vitest'
import { forwardedHeaders } from './route-model'

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
})
