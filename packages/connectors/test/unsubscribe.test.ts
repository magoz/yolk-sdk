import { describe, expect, it } from 'vitest'
import { parseUnsubscribeMethods, type UnsubscribeMethods } from '@yolk-sdk/connectors'

describe('parseUnsubscribeMethods', () => {
  it('returns empty methods without List-Unsubscribe headers', () => {
    expect(parseUnsubscribeMethods([])).toEqual({ mailto: [], http: [] })
    expect(parseUnsubscribeMethods([{ name: 'Subject', value: 'Hello' }])).toEqual({
      mailto: [],
      http: []
    })
  })

  it('extracts mailto and HTTP methods in header order', () => {
    const methods = parseUnsubscribeMethods([
      {
        name: 'List-Unsubscribe',
        value:
          '<mailto:leave@example.com?subject=unsubscribe>, <https://example.com/unsubscribe?id=1>'
      }
    ])

    expect(methods).toEqual({
      mailto: [
        { uri: 'mailto:leave@example.com?subject=unsubscribe', address: 'leave@example.com' }
      ],
      http: [{ url: 'https://example.com/unsubscribe?id=1', oneClick: false }]
    })
  })

  it('strips folding whitespace inside bracketed URLs per RFC 2369', () => {
    const methods = parseUnsubscribeMethods([
      { name: 'List-Unsubscribe', value: '<https://example.com/\r\nunsubscribe?id=1>' }
    ])

    expect(methods.http).toEqual([{ url: 'https://example.com/unsubscribe?id=1', oneClick: false }])
  })

  it('matches header names case-insensitively and tolerates folding whitespace', () => {
    const methods = parseUnsubscribeMethods([
      { name: 'list-unsubscribe', value: ' <https://example.com/a> ,\r\n <mailto:a@example.com> ' }
    ])

    expect(methods).toEqual({
      mailto: [{ uri: 'mailto:a@example.com', address: 'a@example.com' }],
      http: [{ url: 'https://example.com/a', oneClick: false }]
    })
  })

  it('marks HTTP methods one-click from the List-Unsubscribe-Post header', () => {
    const methods: UnsubscribeMethods = parseUnsubscribeMethods([
      { name: 'List-Unsubscribe', value: '<https://example.com/one-click>' },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
    ])

    expect(methods.http).toEqual([{ url: 'https://example.com/one-click', oneClick: true }])
    expect(methods.mailto).toEqual([])
  })

  it('collects repeated headers and dedupes case-insensitively', () => {
    const methods = parseUnsubscribeMethods([
      { name: 'List-Unsubscribe', value: '<https://example.com/a>' },
      { name: 'List-Unsubscribe', value: '<HTTPS://example.com/a>, <mailto:b@example.com>' }
    ])

    expect(methods.http).toEqual([{ url: 'https://example.com/a', oneClick: false }])
    expect(methods.mailto).toEqual([{ uri: 'mailto:b@example.com', address: 'b@example.com' }])
  })

  it('ignores unknown schemes, bare addresses, and empty values', () => {
    const methods = parseUnsubscribeMethods([
      {
        name: 'List-Unsubscribe',
        value: '<ftp://example.com/x>, leave@example.com, <mailto:>, <>'
      }
    ])

    expect(methods).toEqual({ mailto: [], http: [] })
  })
})
