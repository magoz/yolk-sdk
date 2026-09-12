// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getAllowedDevOrigins } from './next-dev-origins'
import { getPortlessOrigin } from './portless-origin'

describe('Portless development origins', () => {
  it('preserves the existing dev allowlist without Portless', () => {
    expect(getAllowedDevOrigins()).toEqual([
      'yolk.localhost',
      '*.yolk.localhost',
      'yolk-e2e.localhost'
    ])
  })

  it('adds the exact custom-suffix worktree hostname, not its port or a wildcard', () => {
    expect(getAllowedDevOrigins('https://feature.yolk.dev.example.com:1355')).toEqual([
      'yolk.localhost',
      '*.yolk.localhost',
      'yolk-e2e.localhost',
      'feature.yolk.dev.example.com'
    ])
    expect(getPortlessOrigin('https://feature.yolk.dev.example.com:1355/')).toBe(
      'https://feature.yolk.dev.example.com:1355'
    )
  })

  it('deduplicates the main checkout hostname', () => {
    expect(getAllowedDevOrigins('https://yolk.localhost')).toEqual(getAllowedDevOrigins())
  })

  it('supports HTTP proxies as well as HTTPS', () => {
    expect(getPortlessOrigin('http://feature.yolk.localhost:1355')).toBe(
      'http://feature.yolk.localhost:1355'
    )
  })

  it.each([
    '',
    'not a URL',
    'yolk.localhost',
    'javascript:alert(1)',
    'file:///tmp/test',
    'ftp://yolk.localhost',
    'https://*.example.com',
    'https://user:secret@yolk.localhost'
  ])('rejects invalid runtime origin %s without leaking the value', value => {
    expect(() => getAllowedDevOrigins(value)).toThrow('Invalid PORTLESS_URL')
  })
})
