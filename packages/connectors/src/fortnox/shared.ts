import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { resolveCredential } from '../credential.ts'
import type { CredentialSlot } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import type { ConnectorHttpResponse } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import { FortnoxPagination } from './schemas.ts'

export const fortnoxApiBaseUrl = 'https://api.fortnox.se/3'

export const FortnoxMetaInformation = Schema.Struct({
  '@CurrentPage': Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  '@TotalPages': Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  '@TotalResources': Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export const paginationFromApi = (meta: typeof FortnoxMetaInformation.Type) =>
  FortnoxPagination.make({
    currentPage: meta['@CurrentPage'],
    totalPages: meta['@TotalPages'],
    totalResources: meta['@TotalResources'],
    ...(meta['@CurrentPage'] < meta['@TotalPages'] ? { nextPage: meta['@CurrentPage'] + 1 } : {})
  })

export const listPath = (
  resource: string,
  input: {
    readonly page?: number
    readonly limit?: number
    readonly lastModified?: string
    readonly search?: { readonly field: string; readonly value: string }
    readonly filter?: string
    readonly fromDate?: string
    readonly toDate?: string
  }
) => {
  const query = new URLSearchParams()
  if (input.page !== undefined) query.set('page', String(input.page))
  if (input.limit !== undefined) query.set('limit', String(input.limit))
  if (input.lastModified !== undefined) query.set('lastmodified', input.lastModified)
  if (input.search !== undefined) query.set(input.search.field, input.search.value)
  if (input.filter !== undefined) query.set('filter', input.filter)
  if (input.fromDate !== undefined) query.set('fromdate', input.fromDate)
  if (input.toDate !== undefined) query.set('todate', input.toDate)
  const suffix = query.toString()
  return suffix === '' ? resource : `${resource}?${suffix}`
}

const ErrorEnvelope = Schema.Struct({
  ErrorInformation: Schema.Struct({
    // The responses guide uses lowercase; the OpenAPI schema uses PascalCase.
    code: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
    message: Schema.optional(Schema.String),
    Code: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
    Message: Schema.optional(Schema.String)
  })
})

const failureCode = (status: number) => {
  switch (status) {
    case 401:
      return 'fortnox_unauthorized'
    case 403:
      return 'fortnox_forbidden'
    case 404:
      return 'fortnox_not_found'
    case 429:
      return 'fortnox_rate_limited'
    default:
      return 'fortnox_request_failed'
  }
}

const providerFailure = (response: ConnectorHttpResponse) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      response.body
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ErrorEnvelope)), Effect.result)
    const detail = Result.isSuccess(parsed) ? parsed.success.ErrorInformation : undefined
    const message = detail?.message ?? detail?.Message
    const providerCode = detail?.code ?? detail?.Code
    const retryAfter = Object.entries(response.headers).find(
      ([key]) => key.toLowerCase() === 'retry-after'
    )?.[1]
    // Delta-seconds only. Hosts own HTTP-date handling, scheduling, and retry policy.
    const seconds =
      retryAfter !== undefined && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
    const retryAfterMs =
      seconds !== undefined && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined
    return ActionResult.failure({
      code: failureCode(response.status),
      message: message?.trim() ? message : `Fortnox request failed (HTTP ${response.status})`,
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(providerCode === undefined ? {} : { underlying: { providerCode } })
    })
  })

export const readFortnox = <A, B>(
  integration: ConnectorIntegration,
  slot: CredentialSlot,
  path: string,
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  map: (value: A) => B
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)
    if (
      credential._tag !== 'OAuthCredential' ||
      credential.provider !== 'fortnox' ||
      !/^[\x21-\x7e]+$/.test(credential.accessToken)
    ) {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'credential_invalid',
          message: 'Fortnox requires a Fortnox OAuth credential with a non-empty access token',
          connectorId: integration.connectorId,
          slotId: slot.id
        })
      )
    }
    const http = yield* ConnectorHttpClient
    const response = yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url: `${fortnoxApiBaseUrl}/${path}`,
        headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' }
      })
    )
    if (response.status < 200 || response.status >= 300) return yield* providerFailure(response)
    const decoded = yield* decodeJsonResponse(schema, response)
    return ActionResult.success(map(decoded))
  })
