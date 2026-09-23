import { Effect, Layer, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  BearerTokenCredential,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type {
  ActionResult,
  ConnectorHttpRequest,
  ProviderFailure,
  RuntimeCredential
} from '@yolk-sdk/connectors'
import {
  githubConnectorId,
  githubTokenSlotId,
  githubUploadTokenSlotId
} from '../src/github/shared.ts'

/** Secret used by the fake resolver; tests assert it never appears in failures. */
export const githubTestToken = 'ghs_secretTESTtoken123'

export const githubIntegration = (
  config: Readonly<Record<string, Schema.Json>> = { owner: 'acme', repo: 'widgets' }
) =>
  makeIntegration({
    connectorId: githubConnectorId,
    config,
    credentialBindings: [
      makeCredentialBinding({ slotId: githubTokenSlotId, credentialRef: 'gh-token' }),
      makeCredentialBinding({ slotId: githubUploadTokenSlotId, credentialRef: 'gh-upload' })
    ]
  })

export type GithubFakeResponse = {
  readonly status?: number
  readonly headers?: Record<string, string>
  /** JSON-serialized unless already a string. */
  readonly body?: Schema.Json
}

export type GithubFakeRequest = ConnectorHttpRequest & {
  /** Parsed URL for path/query assertions. */
  readonly parsedUrl: URL
  /** Parsed JSON body, or undefined. */
  readonly json: unknown
}

const toResponse = (response: GithubFakeResponse) =>
  ConnectorHttpResponse.make({
    status: response.status ?? 200,
    headers: response.headers ?? {},
    body:
      response.body === undefined
        ? ''
        : Predicate.isString(response.body)
          ? response.body
          : JSON.stringify(response.body)
  })

/**
 * Typed fake `ConnectorHttpClient` + `CredentialResolver`. Responses are consumed in order;
 * the last one repeats. `credential` overrides the resolved runtime credential per slot.
 */
export const makeGithubHost = (
  responses: ReadonlyArray<GithubFakeResponse> = [{ body: {} }],
  credential: (slotId: string) => RuntimeCredential = () =>
    BearerTokenCredential.make({ token: githubTestToken })
) => {
  const requests: Array<GithubFakeRequest> = []
  const resolvedSlots: Array<string> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        resolvedSlots.push(request.slot.id)

        return Effect.succeed(credential(request.slot.id))
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        const index = Math.min(requests.length, responses.length - 1)

        requests.push({
          ...request,
          parsedUrl: new URL(request.url),
          json: request.body === undefined ? undefined : JSON.parse(request.body)
        })

        return Effect.succeed(toResponse(responses[index] ?? { body: {} }))
      }
    })
  )

  return { layer, requests, resolvedSlots }
}

/** Minimal GitHub issue wire payload; override any field. */
export const wireIssue = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  id: 1001,
  number: 7,
  title: 'Bug report',
  state: 'open',
  state_reason: null,
  body: 'Steps to reproduce',
  user: { login: 'octocat', type: 'User' },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'hubot' }],
  milestone: { number: 2, title: 'v1' },
  type: { name: 'Bug' },
  locked: false,
  active_lock_reason: null,
  comments: 3,
  html_url: 'https://github.com/acme/widgets/issues/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  closed_at: null,
  ...overrides
})

/** Unwrap an `ActionResult` success or throw (test-only). */
export const successValue = <A>(result: ActionResult<A>): A => {
  if (!Predicate.isTagged(result, 'Success')) {
    throw new Error(`Expected success, got ${JSON.stringify(result)}`)
  }

  return result.value
}

/** Unwrap an `ActionResult` failure or throw (test-only). */
export const failureOf = <A>(result: ActionResult<A>): ProviderFailure => {
  if (!Predicate.isTagged(result, 'Failure')) {
    throw new Error(`Expected failure, got ${JSON.stringify(result)}`)
  }

  return result.error
}
