/**
 * INTERNAL raw Notion request for the version-header conformance case. Not exported.
 *
 * Every Notion connector action sends `Notion-Version` (`notionAuthorizationHeaders`), so no action
 * can show what Notion does without it. This helper resolves the same `notion.api_token` credential
 * through the connector `CredentialResolver` port and sends one GET through `ConnectorHttpClient`
 * with the bearer token and NO `Notion-Version` header.
 */
import { Effect, Match } from 'effect'
import { resolveCredential } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest } from '../../http.ts'
import type { ConnectorIntegration } from '../../integration.ts'
import { NotionApiTokenSlot, notionApiBaseUrl } from '../index.ts'

/** The request id reported for the raw request. */
export const unversionedRequestId = 'notion.conformance.unversioned_get'

const resolveToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, NotionApiTokenSlot)

    return yield* Match.value(credential).pipe(
      Match.tag('ApiKeyCredential', current => Effect.succeed(current.key)),
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('UsernamePasswordCredential', () =>
        Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Notion conformance does not accept username/password credentials',
            connectorId: integration.connectorId,
            slotId: NotionApiTokenSlot.id
          })
        )
      ),
      Match.exhaustive
    )
  })

/** GET `path` (relative to the Notion API base URL) with the bearer token and no `Notion-Version`. */
export const getWithoutNotionVersion = (integration: ConnectorIntegration, path: string) =>
  Effect.gen(function* () {
    const token = yield* resolveToken(integration)
    const http = yield* ConnectorHttpClient

    return yield* http.request(
      ConnectorHttpRequest.make({
        method: 'GET',
        url: `${notionApiBaseUrl}${path}`,
        headers: { authorization: `Bearer ${token}` }
      })
    )
  })
