import { Clock, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorHttpResponse } from '../http.ts'
import {
  githubApiBaseUrl,
  githubApiVersion,
  githubJsonMediaType,
  githubUserAgent
} from './shared.ts'

/**
 * Code-only host boundary for GitHub App installation token minting. Never carries
 * request bodies, JWTs, tokens, or private key material.
 */
export class GithubAppTokenError extends Schema.TaggedError<GithubAppTokenError>()(
  'GithubAppTokenError',
  {
    code: Schema.Literals([
      'invalid_input',
      'invalid_private_key',
      'unauthorized',
      'forbidden',
      'not_found',
      'validation',
      'rate_limited',
      'upstream_failed',
      'invalid_response'
    ]),
    status: Schema.optional(Schema.Number),
    retryAfterMs: Schema.optional(Schema.Number)
  }
) {}

export interface GithubAppInstallationTokenInput {
  readonly appId: string | number
  readonly installationId: string | number
  readonly privateKeyPem: string
  readonly repositories?: ReadonlyArray<string>
  readonly repositoryIds?: ReadonlyArray<number>
  readonly permissions?: Readonly<Record<string, 'read' | 'write' | 'admin'>>
}

export interface GithubAppInstallationTokenOutput {
  readonly token: string
  readonly expiresAt: number
}

const GithubAppTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String
})

const failAppToken = (code: GithubAppTokenError['code']) =>
  Effect.fail(new GithubAppTokenError({ code }))

const appIdPattern = /^[A-Za-z0-9._-]+$/

const numericIdPattern = /^\d+$/

const assertPositiveInt = (value: unknown) =>
  Predicate.isNumber(value) && Number.isInteger(value) && value > 0

const normalizeAppId = (appId: string | number): string | undefined => {
  if (assertPositiveInt(appId)) return String(appId)

  if (!Predicate.isString(appId) || appId.length === 0) return undefined

  if (numericIdPattern.test(appId)) {
    return Number(appId) > 0 ? String(Number(appId)) : undefined
  }

  return appIdPattern.test(appId) ? appId : undefined
}

const normalizeInstallationId = (installationId: string | number): string | undefined => {
  if (assertPositiveInt(installationId)) return String(installationId)

  if (!Predicate.isString(installationId) || !numericIdPattern.test(installationId)) {
    return undefined
  }

  return Number(installationId) > 0 ? String(Number(installationId)) : undefined
}

const assertAppTokenInput = (
  input: GithubAppInstallationTokenInput
): Effect.Effect<
  { readonly appId: string; readonly installationId: string },
  GithubAppTokenError
> => {
  if (!Predicate.isObject(input)) return failAppToken('invalid_input')

  const appId = normalizeAppId(input.appId)

  const installationId = normalizeInstallationId(input.installationId)

  if (
    appId === undefined ||
    installationId === undefined ||
    !Predicate.isString(input.privateKeyPem) ||
    input.privateKeyPem.trim() === ''
  ) {
    return failAppToken('invalid_input')
  }

  if (
    input.repositories !== undefined &&
    (!Array.isArray(input.repositories) ||
      input.repositories.some(name => !Predicate.isString(name) || name.length === 0))
  ) {
    return failAppToken('invalid_input')
  }

  if (
    input.repositoryIds !== undefined &&
    (!Array.isArray(input.repositoryIds) || input.repositoryIds.some(id => !assertPositiveInt(id)))
  ) {
    return failAppToken('invalid_input')
  }

  if (
    input.permissions !== undefined &&
    (!Predicate.isObject(input.permissions) ||
      Object.values(input.permissions).some(
        level => level !== 'read' && level !== 'write' && level !== 'admin'
      ))
  ) {
    return failAppToken('invalid_input')
  }

  return Effect.succeed({ appId, installationId })
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ''

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const base64UrlEncodeText = (text: string): string =>
  base64UrlEncode(new TextEncoder().encode(text))

const derLengthPrefix = (length: number): Array<number> => {
  if (length < 128) return [length]

  const digits: Array<number> = []

  let remaining = length

  while (remaining > 0) {
    digits.unshift(remaining & 0xff)

    remaining = Math.floor(remaining / 256)
  }

  return [0x80 | digits.length, ...digits]
}

/**
 * Wrap a PKCS#1 RSASSA DER blob in a PKCS#8 PrivateKeyInfo so WebCrypto can import it:
 * `SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }`.
 */
const wrapPkcs1InPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]
  const version = [0x02, 0x01, 0x00]
  const algorithmId = [0x30, 0x0d, 0x06, 0x09, ...rsaOid, 0x05, 0x00]
  const key = [0x04, ...derLengthPrefix(pkcs1.length), ...pkcs1]
  const body = [...version, ...algorithmId, ...key]

  return new Uint8Array([0x30, ...derLengthPrefix(body.length), ...body])
}

const importAppPrivateKey = (pem: string): Effect.Effect<CryptoKey, GithubAppTokenError> =>
  Effect.gen(function* () {
    const subtle = globalThis.crypto?.subtle

    if (subtle === undefined) {
      return yield* failAppToken('upstream_failed')
    }

    const normalized = pem.replace(/\\n/g, '\n').trim()

    const match =
      /^-----BEGIN (RSA )?PRIVATE KEY-----([\sA-Za-z0-9+/=]+)-----END (RSA )?PRIVATE KEY-----$/.exec(
        normalized
      )

    if (match === null || match[1] !== match[3]) {
      return yield* failAppToken('invalid_private_key')
    }

    const der = yield* Effect.try({
      try: () => base64ToBytes((match[2] ?? '').replace(/\s+/g, '')),
      catch: () => new GithubAppTokenError({ code: 'invalid_private_key' })
    })

    const wrapped = match[1] === 'RSA ' ? wrapPkcs1InPkcs8(der) : der
    const keyBytes = new Uint8Array(wrapped)

    return yield* Effect.tryPromise({
      try: () =>
        subtle.importKey('pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
          'sign'
        ]),
      catch: () => new GithubAppTokenError({ code: 'invalid_private_key' })
    })
  })

const mintAppJwt = (key: CryptoKey, appId: string): Effect.Effect<string, GithubAppTokenError> =>
  Effect.gen(function* () {
    const subtle = globalThis.crypto?.subtle

    if (subtle === undefined) {
      return yield* failAppToken('upstream_failed')
    }

    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)

    const signingInput = `${base64UrlEncodeText('{"alg":"RS256","typ":"JWT"}')}.${base64UrlEncodeText(
      JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })
    )}`

    const signature = yield* Effect.tryPromise({
      try: () =>
        subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput)),
      catch: () => new GithubAppTokenError({ code: 'invalid_private_key' })
    })

    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
  })

const headerValue = (headers: Readonly<Record<string, string>>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]

const retryAfterMsFromHeaders = (headers: Readonly<Record<string, string>>) => {
  const value = headerValue(headers, 'retry-after')

  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined

  const ms = Number(value.trim()) * 1000

  return Number.isSafeInteger(ms) ? ms : undefined
}

const isAppTokenRateLimited = (response: ConnectorHttpResponse) => {
  if (response.status === 429) return true

  if (response.status !== 403) return false

  return (
    headerValue(response.headers, 'x-ratelimit-remaining')?.trim() === '0' ||
    headerValue(response.headers, 'retry-after') !== undefined ||
    /rate limit/i.test(response.body)
  )
}

const appTokenStatusCode = (status: number): GithubAppTokenError['code'] => {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 422:
      return 'validation'
    default:
      return 'upstream_failed'
  }
}

const appTokenHttpError = (response: ConnectorHttpResponse): GithubAppTokenError => {
  const rateLimited = isAppTokenRateLimited(response)

  if (!rateLimited) {
    return new GithubAppTokenError({
      code: appTokenStatusCode(response.status),
      status: response.status
    })
  }

  return new GithubAppTokenError({
    code: 'rate_limited',
    status: response.status,
    retryAfterMs: retryAfterMsFromHeaders(response.headers)
  })
}

/**
 * Mint a GitHub App installation access token (host-only, not an action).
 *
 * Signs a short-lived RS256 JWT with WebCrypto (`globalThis.crypto.subtle` only, no
 * `node:` imports) and exchanges it for an installation token. No caching: callers
 * reuse `expiresAt` (epoch ms) to decide when to mint again.
 */
export const createGithubAppInstallationToken = (
  input: GithubAppInstallationTokenInput
): Effect.Effect<GithubAppInstallationTokenOutput, GithubAppTokenError, ConnectorHttpClient> =>
  Effect.gen(function* () {
    const ids = yield* assertAppTokenInput(input)

    const key = yield* importAppPrivateKey(input.privateKeyPem)

    const jwt = yield* mintAppJwt(key, ids.appId)

    const authorization = `Bearer ${jwt}`

    const baseHeaders = {
      authorization,
      accept: githubJsonMediaType,
      'x-github-api-version': githubApiVersion,
      'user-agent': githubUserAgent
    }

    const http = yield* ConnectorHttpClient

    const hasScopeRestriction =
      input.repositories !== undefined ||
      input.repositoryIds !== undefined ||
      input.permissions !== undefined

    const body = hasScopeRestriction
      ? JSON.stringify({
          repositories: input.repositories === undefined ? undefined : [...input.repositories],
          repository_ids: input.repositoryIds === undefined ? undefined : [...input.repositoryIds],
          permissions: input.permissions === undefined ? undefined : { ...input.permissions }
        })
      : undefined

    const headers =
      body === undefined ? baseHeaders : { ...baseHeaders, 'content-type': 'application/json' }

    const response = yield* http
      .request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${githubApiBaseUrl}/app/installations/${encodeURIComponent(ids.installationId)}/access_tokens`,
          headers,
          body
        })
      )
      .pipe(Effect.mapError(() => new GithubAppTokenError({ code: 'upstream_failed' })))

    if (response.status !== 201) {
      return yield* Effect.fail(appTokenHttpError(response))
    }

    const minted = yield* decodeJsonResponse(GithubAppTokenResponse, response).pipe(
      Effect.mapError(() => new GithubAppTokenError({ code: 'invalid_response' }))
    )

    const expiresAt = Date.parse(minted.expires_at)

    if (Number.isNaN(expiresAt)) {
      return yield* failAppToken('invalid_response')
    }

    return { token: minted.token, expiresAt }
  })
