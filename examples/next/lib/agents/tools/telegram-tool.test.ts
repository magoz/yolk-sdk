import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeConnectorHttpRequest } from './telegram-tool'
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
})
