import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, decodeJsonResponse } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const linkedInSearchConnectorId = 'linkedin-search'
export const exaApiKeySlotId = 'linkedin-search.exa_api_key'
export const enrichLayerApiKeySlotId = 'linkedin-search.enrich_layer_api_key'
export const exaApiBaseUrl = 'https://api.exa.ai'
export const enrichLayerApiBaseUrl = 'https://enrichlayer.com/api/v2'

export const ExaApiKeySlot = CredentialSlot.make({ id: exaApiKeySlotId, kind: 'api_key' })
export const EnrichLayerApiKeySlot = CredentialSlot.make({
  id: enrichLayerApiKeySlotId,
  kind: 'api_key'
})

const resolveApiToken = (integration: ConnectorIntegration, slot: CredentialSlot) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
    }
  })

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const linkedInProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  ActionResult.failure(
    new ProviderFailure({
      code: input.code,
      message: input.message,
      status: input.status,
      underlying: input.body
    })
  )

export class LinkedInSearchInput extends Schema.Class<LinkedInSearchInput>('LinkedInSearchInput')({
  query: Schema.String,
  numResults: Schema.optional(Schema.Number)
}) {}

export const LinkedInSearchResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  publishedDate: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String)
})

export class LinkedInSearchOutput extends Schema.Class<LinkedInSearchOutput>('LinkedInSearchOutput')({
  results: Schema.Array(LinkedInSearchResult),
  totalResults: Schema.optional(Schema.Number)
}) {}

export class LinkedInProfileInput extends Schema.Class<LinkedInProfileInput>('LinkedInProfileInput')({
  linkedinUrl: Schema.String
}) {}

export class LinkedInProfileOutput extends Schema.Class<LinkedInProfileOutput>('LinkedInProfileOutput')({
  profile: Schema.Unknown
}) {}

export class LinkedInEmailOutput extends Schema.Class<LinkedInEmailOutput>('LinkedInEmailOutput')({
  email: Schema.NullOr(Schema.String),
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
}) {}

const LinkedInEmailApiOutput = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  email_queue_count: Schema.optional(Schema.Number)
})

const linkedInEmailStatus = (email: string | null | undefined) => {
  if (email === undefined) return 'unknown'
  if (email === null) return 'not_found'
  return 'found'
}

const missingEnrichLayer = (integration: ConnectorIntegration) =>
  new ConnectorError({
    cause: 'credential_binding_missing',
    message: 'Missing Enrich Layer credential binding',
    connectorId: integration.connectorId,
    slotId: EnrichLayerApiKeySlot.id
  })

export const linkedInSearchAction = defineAction({
  id: 'linkedin_search.search',
  description: 'Search LinkedIn people results through Exa.',
  inputSchema: LinkedInSearchInput,
  outputSchema: LinkedInSearchOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveApiToken(integration, ExaApiKeySlot)
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${exaApiBaseUrl}/search`,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            query: input.query,
            category: 'people',
            numResults: input.numResults ?? 10,
            type: 'auto',
            contents: { text: true }
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return linkedInProviderFailure({
          code: 'linkedin_search_failed',
          message: 'LinkedIn search failed',
          status: response.status,
          body: response.body
        })
      }

      const decoded = yield* decodeJsonResponse(
        Schema.Struct({ results: Schema.Array(LinkedInSearchResult), totalResults: Schema.optional(Schema.Number) }),
        response
      )
      return ActionResult.success(LinkedInSearchOutput.make(decoded))
    })
})

export const linkedInProfileAction = defineAction({
  id: 'linkedin_search.profile',
  description: 'Fetch a LinkedIn profile through Enrich Layer.',
  inputSchema: LinkedInProfileInput,
  outputSchema: LinkedInProfileOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveApiToken(integration, EnrichLayerApiKeySlot).pipe(
        Effect.catchTag('ConnectorError', () => Effect.fail(missingEnrichLayer(integration)))
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${enrichLayerApiBaseUrl}/profile?linkedin_profile_url=${encodeURIComponent(input.linkedinUrl)}`,
          headers: { authorization: `Bearer ${token}` }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return linkedInProviderFailure({
          code: 'linkedin_profile_failed',
          message: 'LinkedIn profile fetch failed',
          status: response.status,
          body: response.body
        })
      }

      const profile = yield* decodeJsonResponse(Schema.Unknown, response)
      return ActionResult.success(LinkedInProfileOutput.make({ profile }))
    })
})

export const linkedInEmailAction = defineAction({
  id: 'linkedin_search.email',
  description: 'Fetch a LinkedIn profile email through Enrich Layer.',
  inputSchema: LinkedInProfileInput,
  outputSchema: LinkedInEmailOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const token = yield* resolveApiToken(integration, EnrichLayerApiKeySlot).pipe(
        Effect.catchTag('ConnectorError', () => Effect.fail(missingEnrichLayer(integration)))
      )
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'GET',
          url: `${enrichLayerApiBaseUrl}/profile/email?linkedin_profile_url=${encodeURIComponent(input.linkedinUrl)}`,
          headers: { authorization: `Bearer ${token}` }
        })
      )

      if (!isSuccessStatus(response.status)) {
        return linkedInProviderFailure({
          code: 'linkedin_email_failed',
          message: 'LinkedIn email fetch failed',
          status: response.status,
          body: response.body
        })
      }

      const decoded = yield* decodeJsonResponse(LinkedInEmailApiOutput, response)
      if (decoded.email_queue_count !== undefined && decoded.email === undefined) {
        return ActionResult.success(
          LinkedInEmailOutput.make({
            email: null,
            status: 'queued',
            message: 'Email lookup queued by Enrich Layer'
          })
        )
      }

      return ActionResult.success(
        LinkedInEmailOutput.make({
          email: decoded.email ?? null,
          status: decoded.status ?? linkedInEmailStatus(decoded.email),
          message: decoded.message
        })
      )
    })
})

export const linkedInSearchActions = [linkedInSearchAction, linkedInProfileAction, linkedInEmailAction]

export const LinkedInSearchConnector = defineConnector({
  id: linkedInSearchConnectorId,
  description: 'LinkedIn people search and enrichment connector actions.',
  actions: linkedInSearchActions
})
