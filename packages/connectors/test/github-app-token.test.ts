import { generateKeyPairSync, verify } from 'node:crypto'
import { Effect, Predicate, Result } from 'effect'
import type * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from '@effect/vitest'
import { createGithubAppInstallationToken } from '../src/github/app-token.ts'
import { makeGithubHost } from './github-fake.ts'

const mintedToken = 'ghs_mintedTESTtoken456'

const mintedExpiresAt = '2026-06-01T00:00:00.000Z'

const mintedResponse = () => ({
  status: 201,
  body: { token: mintedToken, expires_at: mintedExpiresAt }
})

const makeKeys = (type: 'pkcs1' | 'pkcs8') =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type, format: 'pem' }
  })

const decodeBase64UrlJson = (part: string): unknown => {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/')

  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)))
}

const base64UrlToBytes = (part: string): Uint8Array => {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

describe('github app installation token', () => {
  it.effect('mints a verifiable RS256 JWT for PKCS#1, PKCS#8, and escaped PEMs', () =>
    Effect.gen(function* () {
      const pkcs1 = makeKeys('pkcs1')
      const pkcs8 = makeKeys('pkcs8')

      const variants = [
        { label: 'pkcs1', privateKeyPem: pkcs1.privateKey, publicKey: pkcs1.publicKey },
        { label: 'pkcs8', privateKeyPem: pkcs8.privateKey, publicKey: pkcs8.publicKey },
        {
          label: 'escaped',
          privateKeyPem: pkcs8.privateKey.replace(/\n/g, '\\n'),
          publicKey: pkcs8.publicKey
        }
      ]

      for (const variant of variants) {
        const host = makeGithubHost([mintedResponse()])

        yield* TestClock.setTime(1_700_000_000_000)

        const output = yield* createGithubAppInstallationToken({
          appId: 123,
          installationId: '987',
          privateKeyPem: variant.privateKeyPem
        }).pipe(Effect.provide(host.layer))

        expect(output).toEqual({ token: mintedToken, expiresAt: Date.parse(mintedExpiresAt) })

        const request = host.requests[0]

        expect(request?.method).toBe('POST')
        expect(request?.parsedUrl.toString()).toBe(
          'https://api.github.com/app/installations/987/access_tokens'
        )
        expect(request?.headers).toMatchObject({
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
          'user-agent': 'yolk-sdk-connectors'
        })
        expect(request?.body).toBeUndefined()

        const jwt = (request?.headers?.['authorization'] ?? '').replace(/^Bearer /, '')
        const parts = jwt.split('.')

        expect(parts).toHaveLength(3)
        expect(decodeBase64UrlJson(parts[0] ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' })

        const payload = decodeBase64UrlJson(parts[1] ?? '')

        expect(payload).toMatchObject({ iss: '123', iat: 1_699_999_940, exp: 1_700_000_540 })

        if (Predicate.isObject(payload)) {
          const exp = payload['exp']
          const iat = payload['iat']

          if (Predicate.isNumber(exp) && Predicate.isNumber(iat)) {
            expect(exp - iat).toBeLessThanOrEqual(600)
          } else {
            throw new Error('Expected numeric iat/exp in app JWT payload')
          }
        } else {
          throw new Error('Expected object app JWT payload')
        }

        const signingInput = `${parts[0]}.${parts[1]}`
        const signature = base64UrlToBytes(parts[2] ?? '')

        expect(
          verify('RSA-SHA256', new TextEncoder().encode(signingInput), variant.publicKey, signature)
        ).toBe(true)

        expect(host.resolvedSlots).toEqual([])
      }
    })
  )

  it.effect('sends only provided repository scopes and string app ids', () =>
    Effect.gen(function* () {
      const keys = makeKeys('pkcs8')
      const host = makeGithubHost([mintedResponse()])

      yield* TestClock.setTime(1_700_000_000_000)

      yield* createGithubAppInstallationToken({
        appId: 'Iv1.clientid123',
        installationId: 42,
        privateKeyPem: keys.privateKey,
        repositories: ['widgets'],
        repositoryIds: [7],
        permissions: { contents: 'read', issues: 'write' }
      }).pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.json).toEqual({
        repositories: ['widgets'],
        repository_ids: [7],
        permissions: { contents: 'read', issues: 'write' }
      })
      expect(host.requests[0]?.headers?.['content-type']).toBe('application/json')
    })
  )

  it.effect('rejects invalid keys without leaking key material', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([mintedResponse()])

      for (const privateKeyPem of [
        'not-a-key',
        '-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----',
        '-----BEGIN PRIVATE KEY-----\nZm9v\n-----END RSA PRIVATE KEY-----'
      ]) {
        const result = yield* createGithubAppInstallationToken({
          appId: 1,
          installationId: 2,
          privateKeyPem
        }).pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: 'invalid_private_key' })
          expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
        }
      }

      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('rejects invalid ids before any request', () =>
    Effect.gen(function* () {
      const keys = makeKeys('pkcs8')
      const host = makeGithubHost([mintedResponse()])

      const cases = [
        { appId: '!nope!', installationId: 2, privateKeyPem: keys.privateKey },
        { appId: 1, installationId: 'abc', privateKeyPem: keys.privateKey },
        { appId: 0, installationId: 2, privateKeyPem: keys.privateKey },
        { appId: 1, installationId: 2, privateKeyPem: '   ' }
      ]

      for (const input of cases) {
        const result = yield* createGithubAppInstallationToken(input).pipe(
          Effect.provide(host.layer),
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: 'invalid_input' })
        }
      }

      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('maps upstream statuses without leaking secrets', () =>
    Effect.gen(function* () {
      const keys = makeKeys('pkcs8')

      const cases: Array<{
        readonly status: number
        readonly headers?: Record<string, string>
        readonly body: Schema.Json
        readonly code: string
      }> = [
        { status: 401, body: { message: 'Bad credentials' }, code: 'unauthorized' },
        { status: 403, body: { message: 'Forbidden' }, code: 'forbidden' },
        {
          status: 403,
          headers: { 'X-RateLimit-Remaining': '0' },
          body: { message: 'API rate limit exceeded' },
          code: 'rate_limited'
        },
        { status: 404, body: { message: 'Not Found' }, code: 'not_found' },
        { status: 422, body: { message: 'Validation Failed' }, code: 'validation' },
        {
          status: 429,
          headers: { 'Retry-After': '12' },
          body: { message: 'Slow down' },
          code: 'rate_limited'
        },
        { status: 500, body: { message: 'boom' }, code: 'upstream_failed' }
      ]

      for (const entry of cases) {
        const host = makeGithubHost([
          { status: entry.status, headers: entry.headers, body: entry.body }
        ])

        const result = yield* createGithubAppInstallationToken({
          appId: 1,
          installationId: 2,
          privateKeyPem: keys.privateKey
        }).pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: entry.code, status: entry.status })
          expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
          expect(JSON.stringify(result)).not.toContain(mintedToken)
          expect(JSON.stringify(result)).not.toContain(
            (host.requests[0]?.headers?.['authorization'] ?? '').slice('Bearer '.length)
          )
        }
      }

      const limited = yield* createGithubAppInstallationToken({
        appId: 1,
        installationId: 2,
        privateKeyPem: keys.privateKey
      }).pipe(
        Effect.provide(
          makeGithubHost([{ status: 429, headers: { 'Retry-After': '12' }, body: {} }]).layer
        ),
        Effect.result
      )

      if (Result.isFailure(limited)) {
        expect(limited.failure).toMatchObject({ code: 'rate_limited', retryAfterMs: 12_000 })
      } else {
        throw new Error('Expected rate_limited failure')
      }
    })
  )

  it.effect('rejects malformed success payloads as invalid_response', () =>
    Effect.gen(function* () {
      const keys = makeKeys('pkcs8')

      const bodies: ReadonlyArray<Schema.Json> = [
        { token: mintedToken, expires_at: 'not-a-date' },
        { nope: true }
      ]

      for (const body of bodies) {
        const result = yield* createGithubAppInstallationToken({
          appId: 1,
          installationId: 2,
          privateKeyPem: keys.privateKey
        }).pipe(Effect.provide(makeGithubHost([{ status: 201, body }]).layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: 'invalid_response' })
          expect(JSON.stringify(result)).not.toContain(mintedToken)
        }
      }
    })
  )
})
