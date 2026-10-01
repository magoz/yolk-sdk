/**
 * LinkedIn search conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the LinkedIn search connector relies on, running the REAL
 * connector actions (`linkedin_search.search` through Exa, `linkedin_search.profile` and
 * `linkedin_search.email` through Enrich Layer) over the connector ports (`ConnectorHttpClient`,
 * `CredentialResolver`) plus the host-supplied `LinkedInSearchConformanceConfig` seeds. Answers
 * the actions decode only partly, or not at all (the profile is returned as any JSON value), are
 * observed at the `ConnectorHttpClient` port the host provides; the cases send no request of
 * their own. The same cases run on replay fixtures or by hand against the real APIs. None is
 * observed live yet (`observed` absent = unverified); sub-claims no live run has settled are
 * marked "(unverified: ...)" in their `wire`.
 *
 * Every case is a read: the connector has no write action. A live run still spends Exa and Enrich
 * Layer credits, so it needs the repository owner's approval.
 *
 * Not covered: rate limiting. The connector maps every non-2xx answer, 429 included, to its
 * action's failure code with the HTTP status and the raw body (`underlying`), and reads no
 * `Retry-After` header (no `retryAfterMs`); a practice run cannot provoke a 429 without flooding
 * the APIs, so no case claims it.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { ApiKeyCredential, CredentialResolver, makeCredentialBinding } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import {
  ConnectorHttpClient,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse
} from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  LinkedInProfileInput,
  LinkedInSearchInput,
  enrichLayerApiBaseUrl,
  enrichLayerApiKeySlotId,
  exaApiBaseUrl,
  exaApiKeySlotId,
  linkedInEmailAction,
  linkedInProfileAction,
  linkedInSearchAction,
  linkedInSearchConnectorId
} from '../index.ts'
import { linkedInSearchEmailLookupFixture } from './email-lookup.ts'
import { linkedInSearchEnrichLayerUnauthorizedFixture } from './enrich-layer-unauthorized.ts'
import { linkedInSearchExaUnauthorizedFixture } from './exa-unauthorized.ts'
import { linkedInSearchNumResultsLimitFixture } from './num-results-limit.ts'
import { linkedInSearchPeopleResultsFixture } from './people-results.ts'
import { linkedInSearchProfileFixture } from './profile.ts'
import { linkedInSearchProfileNotFoundFixture } from './profile-not-found.ts'

/** A search query: trimmed, non-empty, one line, at most 500 characters. */
const SearchQuery = Schema.String.check(Schema.isPattern(/^\S(?:.*\S)?$/), Schema.isMaxLength(500))

/**
 * A LinkedIn person profile URL as the actions take it: `https://<host>/in/<slug>`, no query,
 * fragment, or whitespace, at most 2048 characters.
 */
const ProfileUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+\/in\/[^\s?#]+$/),
  Schema.isMaxLength(2048)
)

/**
 * Host-supplied seeds. Cases never hard-code account or people data. A case whose required seed is
 * missing fails with a `precondition:` `ConformanceMismatch` before any request.
 */
export const LinkedInSearchConformanceSeeds = Schema.Struct({
  /** An Exa people query that matches more than two people. */
  searchQuery: Schema.optionalKey(SearchQuery),
  /** A public LinkedIn profile URL Enrich Layer can enrich. */
  profileUrl: Schema.optionalKey(ProfileUrl),
  /** A well-formed LinkedIn profile URL that names no profile (a made-up slug). */
  absentProfileUrl: Schema.optionalKey(ProfileUrl)
})

export type LinkedInSearchConformanceSeeds = typeof LinkedInSearchConformanceSeeds.Type

export type LinkedInSearchConformanceSeedKey = keyof LinkedInSearchConformanceSeeds

/** Host-supplied seeds for the LinkedIn search conformance cases. */
export class LinkedInSearchConformanceConfig extends Context.Service<
  LinkedInSearchConformanceConfig,
  LinkedInSearchConformanceSeeds
>()('@yolk-sdk/connectors/linkedin-search/conformance/LinkedInSearchConformanceConfig') {}

/** Credential reference the cases bind to the `linkedin-search.exa_api_key` slot. */
export const linkedInSearchConformanceExaCredentialRef = 'linkedin-search.conformance.exa'

/** Credential reference the cases bind to the `linkedin-search.enrich_layer_api_key` slot. */
export const linkedInSearchConformanceEnrichLayerCredentialRef =
  'linkedin-search.conformance.enrich-layer'

/**
 * The integration a LinkedIn search conformance case invokes the connector with: both API key
 * bindings, no config. A host `CredentialResolver` (for example `staticCredentialResolverLayer`
 * from `@yolk-sdk/connectors/conformance` over `linkedInSearchConformanceCredentials`) resolves
 * them.
 */
export const linkedInSearchConformanceIntegration = () =>
  makeIntegration({
    connectorId: linkedInSearchConnectorId,
    config: {},
    credentialBindings: [
      makeCredentialBinding({
        slotId: exaApiKeySlotId,
        credentialRef: linkedInSearchConformanceExaCredentialRef
      }),
      makeCredentialBinding({
        slotId: enrichLayerApiKeySlotId,
        credentialRef: linkedInSearchConformanceEnrichLayerCredentialRef
      })
    ]
  })

/**
 * Static credentials keyed by slot id, for `staticCredentialResolverLayer`: the Exa key for
 * `linkedin-search.exa_api_key` and the Enrich Layer key for
 * `linkedin-search.enrich_layer_api_key`.
 */
export const linkedInSearchConformanceCredentials = (keys: {
  readonly exaApiKey: string
  readonly enrichLayerApiKey: string
}) => ({
  [exaApiKeySlotId]: ApiKeyCredential.make({ key: keys.exaApiKey }),
  [enrichLayerApiKeySlotId]: ApiKeyCredential.make({ key: keys.enrichLayerApiKey })
})

/**
 * A connector action failed where the case needed success. `code` and `status` keep the
 * underlying classification (a `ConnectorError` cause such as `transport_failed`, or a provider
 * failure code such as `linkedin_profile_failed`).
 */
export class LinkedInSearchConformanceActionFailed extends Data.TaggedError(
  'LinkedInSearchConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    return `${this.actionId} failed: ${this.code}${status}`
  }
}

export type LinkedInSearchConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | LinkedInSearchConformanceActionFailed

/** What every LinkedIn search conformance case requires from the host. */
export type LinkedInSearchConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | LinkedInSearchConformanceConfig

export type LinkedInSearchConformanceCase = ConformanceCase<
  LinkedInSearchConformanceError,
  LinkedInSearchConformanceRequirements
>

const requireSeed = <K extends LinkedInSearchConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* LinkedInSearchConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: LinkedInSearchConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, LinkedInSearchConformanceActionFailed> => {
    if (Predicate.isTagged(result, 'Success')) {
      return Effect.succeed(result.value)
    }

    const { code, status } = result.error

    return Effect.fail(
      status === undefined
        ? new LinkedInSearchConformanceActionFailed({ actionId, code })
        : new LinkedInSearchConformanceActionFailed({ actionId, code, status })
    )
  }

/** The provider failure of a result, or `undefined` for a success. */
const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** `code status` of a result for mismatch details (`success` for a success). */
const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined ? 'success' : `${failure.code} ${failure.status ?? 'no-status'}`
}

/** A JSON text body parsed, or `undefined` when it is not JSON text. */
const parseJson = (body: unknown): Effect.Effect<unknown> =>
  Predicate.isString(body)
    ? Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )
    : Effect.succeed(undefined)

type ObservedExchange = {
  readonly request: ConnectorHttpRequest
  readonly response: ConnectorHttpResponse
}

/**
 * Run `effect` with the host's `ConnectorHttpClient` wrapped so every exchange is observed (the
 * requests and responses are the host's own, unchanged), and keep its exit, so a decoding
 * failure can still be explained from the observed answer.
 */
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const exchanges = yield* Ref.make<ReadonlyArray<ObservedExchange>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        http
          .request(request)
          .pipe(
            Effect.tap(response => Ref.update(exchanges, list => [...list, { request, response }]))
          )
    })

    const exit = yield* Effect.exit(
      effect.pipe(Effect.provideService(ConnectorHttpClient, observing))
    )

    return { exit, exchanges: yield* Ref.get(exchanges) }
  })

/** `METHOD URL` per observed exchange, for request-shape checks. */
const sentRequests = (exchanges: ReadonlyArray<ObservedExchange>) =>
  exchanges.map(({ request }) => `${request.method} ${request.url}`)

/** The fields of an answer the connector decodes: top-level keys, and keys of each `results[n]`. */
type DecodedFields = {
  readonly top: ReadonlyArray<string>
  readonly result: ReadonlyArray<string>
}

/** The keys among `keys` whose value in `value` is JSON `null`. */
const nullKeys = (value: unknown, keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  keys.filter(key => Predicate.hasProperty(value, key) && value[key] === null)

/**
 * Where an answer holds `null` in a field the connector decodes: `results[n].<key>` for
 * `fields.result` and top-level `fields.top`, never anything nested deeper (the connector reads
 * nothing there, so a `null` there cannot be why decoding failed).
 */
const nullPaths = (value: unknown, fields: DecodedFields): ReadonlyArray<string> => {
  const results: ReadonlyArray<unknown> =
    Predicate.hasProperty(value, 'results') && Array.isArray(value.results) ? value.results : []

  return [
    ...results.flatMap((entry, index) =>
      nullKeys(entry, fields.result).map(key => `results[${index}].${key}`)
    ),
    ...nullKeys(value, fields.top)
  ]
}

/**
 * The action's result, or why its 2xx answer did not decode: a `validation_failed` connector error
 * becomes a `ConformanceMismatch` naming the observed `null` values among the decoded `fields` (or
 * the connector's own message when none is null). Any other failure is kept.
 */
const settled = <A>(
  actionId: string,
  exit: Exit.Exit<ActionResult<A>, ConnectorError>,
  exchanges: ReadonlyArray<ObservedExchange>,
  fields: DecodedFields
) =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    const error = Cause.findErrorOption(exit.cause)

    if (Option.isSome(error) && error.value.cause === 'validation_failed') {
      const body = yield* parseJson(exchanges.at(-1)?.response.body)
      const nulls = nullPaths(body, fields)

      return yield* new ConformanceMismatch({
        message:
          nulls.length > 0
            ? `expected the 2xx answer of ${actionId} to decode as the connector reads it; null where it reads a string or number: ${nulls.join(', ')}`
            : `expected the 2xx answer of ${actionId} to decode as the connector reads it (${error.value.message})`
      })
    }

    return yield* exit
  })

const search = (input: { readonly query: string; readonly numResults?: number }) =>
  linkedInSearchAction.executeTyped({
    integration: linkedInSearchConformanceIntegration(),
    input: LinkedInSearchInput.make(input)
  })

const profile = (linkedinUrl: string) =>
  linkedInProfileAction.executeTyped({
    integration: linkedInSearchConformanceIntegration(),
    input: LinkedInProfileInput.make({ linkedinUrl })
  })

const email = (linkedinUrl: string) =>
  linkedInEmailAction.executeTyped({
    integration: linkedInSearchConformanceIntegration(),
    input: LinkedInProfileInput.make({ linkedinUrl })
  })

/** The URL `linkedin_search.profile` requests for a profile URL. */
const profileRequestUrl = (linkedinUrl: string) =>
  `${enrichLayerApiBaseUrl}/profile?linkedin_profile_url=${encodeURIComponent(linkedinUrl)}`

/** The URL `linkedin_search.email` requests for a profile URL. */
const emailRequestUrl = (linkedinUrl: string) =>
  `${enrichLayerApiBaseUrl}/profile/email?linkedin_profile_url=${encodeURIComponent(linkedinUrl)}`

/** The fields of an Exa answer the connector decodes: each a string (a number for the count). */
const searchFields: DecodedFields = {
  top: ['totalResults'],
  result: ['title', 'url', 'text', 'publishedDate', 'author']
}

/** The default `numResults` the connector sends. */
const defaultNumResults = 10

const SentSearchBody = Schema.Struct({ numResults: Schema.Number })

export const linkedInSearchPeopleResultsCase: LinkedInSearchConformanceCase = defineConformanceCase(
  {
    id: 'linkedin-search.search.people-results',
    title: 'an Exa people search answers 1 to 10 results whose fields are strings, never null',
    safety: 'read',
    docs: '`linkedin_search.search` sends POST https://api.exa.ai/search with `Authorization: Bearer <key>` and the JSON body `{ query, category: "people", numResults, type: "auto", contents: { text: true } }` (`numResults` defaults to 10, passed through without a cap), then decodes `{ results: [{ title?, url?, text?, publishedDate?, author? }], totalResults? }` into its output and drops every other field. A field answered as `null` fails decoding (`validation_failed`). There is no paging: one request answers every result.',
    wire: 'For the seeded query, Exa accepts the bearer `Authorization` header (unverified: Exa documents `x-api-key`; the connector sends a bearer token) and answers a 2xx with a `results` array of 1 to 10 entries (at most the default `numResults` the connector sends), every entry carrying a string `url` (a usefulness expectation, not something the connector decodes: its `url` is optional, but a result without one cannot be handed to `linkedin_search.profile`), and every `title`, `url`, `text`, `publishedDate`, and `author` a string or absent, never `null` (unverified: Exa omits a missing author or date rather than answering null, which the connector would fail to decode); at least one entry carries `text`, which the connector requests.',
    fixtures: [linkedInSearchPeopleResultsFixture.id],
    run: Effect.gen(function* () {
      const query = yield* requireSeed('searchQuery')
      const { exit, exchanges } = yield* observed(search({ query }))
      const result = yield* settled(linkedInSearchAction.id, exit, exchanges, searchFields)

      yield* expectEqual(
        sentRequests(exchanges),
        [`POST ${exaApiBaseUrl}/search`],
        'expected linkedin_search.search to send exactly one POST /search'
      )

      const output = yield* successValue(linkedInSearchAction.id)(result)
      const count = output.results.length

      if (count === 0) {
        return yield* new ConformanceMismatch({
          message: 'precondition: searchQuery must match at least one person'
        })
      }

      yield* expectConformance(
        count <= defaultNumResults,
        `expected at most ${defaultNumResults} results (the default numResults the connector sends)`,
        { actual: count }
      )
      yield* expectConformance(
        output.results.every(entry => entry.url !== undefined && entry.url.length > 0),
        'expected every result to carry a url'
      )
      yield* expectConformance(
        output.results.some(entry => entry.text !== undefined),
        'expected at least one result to carry the text the connector requests'
      )
    })
  }
)

/** The limit the limit case sends. */
const limitedNumResults = 2

/**
 * The control search's limit: one more than the limited search, so a control answering more than
 * `limitedNumResults` people proves the query can show an ignored limit, at the smallest cost (each
 * result is paid for and holds a third party's data).
 */
const controlNumResults = limitedNumResults + 1

export const linkedInSearchNumResultsLimitCase: LinkedInSearchConformanceCase =
  defineConformanceCase({
    id: 'linkedin-search.search.num-results-limit',
    title: 'Exa answers at most numResults results for a query that matches more',
    safety: 'read',
    docs: '`linkedin_search.search` passes `numResults` to Exa unchanged (it neither caps nor validates it) and never pages, so the answer to its single request is everything it returns.',
    wire: 'The case sends two POST /search requests for the seeded query through `linkedin_search.search`. First a control with `numResults: 3`, which must answer more than 2 people (a `precondition:` otherwise: only then could an ignored limit show). Then the same query with `numResults: 2`; the two bodies carry `numResults: 3` and `numResults: 2`, and Exa answers a 2xx with 1 or 2 results: the limit is honoured, not ignored.',
    fixtures: [linkedInSearchNumResultsLimitFixture.id],
    run: Effect.gen(function* () {
      const query = yield* requireSeed('searchQuery')

      // The control: the same query with one more result than the limit must answer more people
      // than the limit lets through, or an ignored limit would look exactly like an honoured one.
      const control = yield* observed(search({ query, numResults: controlNumResults }))

      const controlResult = yield* settled(
        linkedInSearchAction.id,
        control.exit,
        control.exchanges,
        searchFields
      )

      const controlCount = (yield* successValue(linkedInSearchAction.id)(controlResult)).results
        .length

      if (controlCount <= limitedNumResults) {
        return yield* new ConformanceMismatch({
          message: `precondition: searchQuery must match more than ${limitedNumResults} people (the control search with numResults: ${controlNumResults} answered ${controlCount})`
        })
      }

      const { exit, exchanges } = yield* observed(search({ query, numResults: limitedNumResults }))

      const result = yield* settled(linkedInSearchAction.id, exit, exchanges, searchFields)

      yield* expectEqual(
        [...sentRequests(control.exchanges), ...sentRequests(exchanges)],
        [`POST ${exaApiBaseUrl}/search`, `POST ${exaApiBaseUrl}/search`],
        'expected the control and the limited search to send one POST /search each'
      )

      const sentLimits = yield* Effect.forEach([...control.exchanges, ...exchanges], exchange =>
        parseJson(exchange.request.body).pipe(
          Effect.map(sent => (Schema.is(SentSearchBody)(sent) ? sent.numResults : null))
        )
      )

      yield* expectEqual(
        sentLimits,
        [controlNumResults, limitedNumResults],
        `expected the control and the limited search bodies to carry numResults: ${controlNumResults} and ${limitedNumResults}`
      )

      const output = yield* successValue(linkedInSearchAction.id)(result)
      const count = output.results.length

      yield* expectConformance(
        count >= 1 && count <= limitedNumResults,
        `expected 1 to ${limitedNumResults} results for numResults: ${limitedNumResults} (the control answered more)`,
        { actual: count }
      )
    })
  })

/** The profile action decodes no field: any JSON value is the profile. */
const profileFields: DecodedFields = { top: [], result: [] }

export const linkedInSearchProfileCase: LinkedInSearchConformanceCase = defineConformanceCase({
  id: 'linkedin-search.profile.get-profile',
  title: 'Enrich Layer answers linkedin_profile_url with a profile object',
  safety: 'read',
  docs: '`linkedin_search.profile` sends GET https://enrichlayer.com/api/v2/profile?linkedin_profile_url=<profile URL, percent-encoded> with `Authorization: Bearer <key>` and returns the 2xx JSON body unchanged as `profile` (any JSON value: it reads no field of it). A non-2xx answer is `linkedin_profile_failed` with the HTTP status and the raw body as `underlying`.',
  wire: 'For the seeded profile URL, Enrich Layer accepts the `linkedin_profile_url` query parameter (unverified: that Enrich Layer still takes this Proxycurl-era name) with the fully percent-encoded URL and the bearer key, and answers a 2xx JSON object with at least one field (the connector returns it unchanged as `profile`: a connector property, not checked here).',
  fixtures: [linkedInSearchProfileFixture.id],
  run: Effect.gen(function* () {
    const linkedinUrl = yield* requireSeed('profileUrl')
    const { exit, exchanges } = yield* observed(profile(linkedinUrl))
    const result = yield* settled(linkedInProfileAction.id, exit, exchanges, profileFields)

    yield* expectEqual(
      sentRequests(exchanges),
      [`GET ${profileRequestUrl(linkedinUrl)}`],
      'expected linkedin_search.profile to send exactly one GET /profile for the seeded URL'
    )

    const output = yield* successValue(linkedInProfileAction.id)(result)

    yield* expectConformance(
      Predicate.isObject(output.profile) &&
        !Array.isArray(output.profile) &&
        Object.keys(output.profile).length > 0,
      'expected the 2xx profile answer to be a JSON object with at least one field'
    )
  })
})

/** The fields of an email lookup answer the connector decodes as a string or number. */
const emailFields: DecodedFields = { top: ['status', 'message', 'email_queue_count'], result: [] }

const EmailAnswer = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  email_queue_count: Schema.optional(Schema.Number)
})

export const linkedInSearchEmailLookupCase: LinkedInSearchConformanceCase = defineConformanceCase({
  id: 'linkedin-search.email.lookup-answer',
  title: 'the email lookup answers an email or a queued count, never a status of unknown',
  safety: 'read',
  docs: '`linkedin_search.email` sends GET https://enrichlayer.com/api/v2/profile/email?linkedin_profile_url=<profile URL, percent-encoded> with `Authorization: Bearer <key>` and decodes `{ email?: string | null, status?: string, message?: string, email_queue_count?: number }`. An answer with `email_queue_count` and no `email` is reported as `{ email: null, status: "queued" }`; otherwise `email` (null when absent) with the answered `status`, or `found`, `not_found`, or `unknown` for a string, null, or absent `email`. Any of those fields answered with another type (`email_queue_count: null` included) fails decoding (`validation_failed`).',
  wire: 'For the seeded profile URL, Enrich Layer answers a 2xx JSON object that decodes as the connector reads it and carries either an `email` field (a string or null) or a numeric `email_queue_count` (unverified: which of the two a lookup answers, and that a queued lookup answers a number rather than `email_queue_count: null`), and the connector never reports `status: "unknown"`: neither the status it falls back to for an answer it does not recognise nor an answered `status` of `unknown`, which it passes through.',
  fixtures: [linkedInSearchEmailLookupFixture.id],
  run: Effect.gen(function* () {
    const linkedinUrl = yield* requireSeed('profileUrl')
    const { exit, exchanges } = yield* observed(email(linkedinUrl))
    const result = yield* settled(linkedInEmailAction.id, exit, exchanges, emailFields)

    yield* expectEqual(
      sentRequests(exchanges),
      [`GET ${emailRequestUrl(linkedinUrl)}`],
      'expected linkedin_search.email to send exactly one GET /profile/email for the seeded URL'
    )

    const output = yield* successValue(linkedInEmailAction.id)(result)
    const [exchange] = exchanges
    const parsed = yield* parseJson(exchange?.response.body)
    // The connector decoded this same body, so it always matches; the guard only narrows the type.
    const answered = Schema.is(EmailAnswer)(parsed) ? parsed : undefined

    yield* expectConformance(
      answered?.email !== undefined || answered?.email_queue_count !== undefined,
      'expected the email answer to carry an email (string or null) or an email_queue_count'
    )
    yield* expectConformance(
      output.status !== 'unknown',
      'expected linkedin_search.email never to report status "unknown"',
      { actual: output.status ?? 'none' }
    )
  })
})

/** Synthetic API keys the providers cannot know (never account data). */
const invalidExaApiKey = 'yolk-conformance-invalid-exa-key'

const invalidEnrichLayerApiKey = 'yolk-conformance-invalid-enrich-layer-key'

const invalidKeyResolver = (key: string) =>
  CredentialResolver.of({ resolve: () => Effect.succeed(ApiKeyCredential.make({ key })) })

/** A synthetic query for the unauthorized search: no seed, since nothing should be searched. */
const unauthorizedQuery = 'yolk-conformance unauthorized probe'

/** Fail unless `result` is the failure `code` with a 4xx status. */
const expectClientError = <A>(
  result: ActionResult<A>,
  code: string,
  label: string
): Effect.Effect<void, ConformanceMismatch> =>
  Effect.gen(function* () {
    const failure = failureOf(result)

    if (failure === undefined) {
      return yield* new ConformanceMismatch({ message: `expected ${label} to fail` })
    }

    yield* expectConformance(
      failure.code === code &&
        failure.status !== undefined &&
        failure.status >= 400 &&
        failure.status < 500,
      `expected ${label} to answer a 4xx status (${code})`,
      { actual: outcomeOf(result) }
    )
  })

export const linkedInSearchExaUnauthorizedCase: LinkedInSearchConformanceCase =
  defineConformanceCase({
    id: 'linkedin-search.errors.exa-unauthorized',
    title: 'Exa answers an API key it does not know with a 4xx status, never 2xx or 5xx',
    safety: 'read',
    docs: 'A non-2xx Exa answer is `linkedin_search_failed` with the HTTP status and the raw body as `underlying`. The connector maps no status specially (no rate-limit code, no `retryAfterMs`) and reads no field of the error body.',
    wire: '`linkedin_search.search` with a synthetic API key Exa does not know answers a 4xx status (unverified: 401), not a 2xx error body (which the connector would try to decode as results) and not a 5xx; the connector reports `linkedin_search_failed` with that status. The error body is not checked: the connector does not read it.',
    fixtures: [linkedInSearchExaUnauthorizedFixture.id],
    run: Effect.gen(function* () {
      const result = yield* search({ query: unauthorizedQuery }).pipe(
        Effect.provideService(CredentialResolver, invalidKeyResolver(invalidExaApiKey))
      )

      yield* expectClientError(
        result,
        'linkedin_search_failed',
        'linkedin_search.search with an unknown Exa key'
      )
    })
  })

export const linkedInSearchEnrichLayerUnauthorizedCase: LinkedInSearchConformanceCase =
  defineConformanceCase({
    id: 'linkedin-search.errors.enrich-layer-unauthorized',
    title: 'Enrich Layer answers an API key it does not know with a 4xx status, never 2xx or 5xx',
    safety: 'read',
    docs: 'A non-2xx Enrich Layer answer is `linkedin_profile_failed` (profile) or `linkedin_email_failed` (email) with the HTTP status and the raw body as `underlying`. The connector maps no status specially (no rate-limit code, no `retryAfterMs`) and reads no field of the error body.',
    wire: '`linkedin_search.profile` and then `linkedin_search.email` for the seeded profile URL with a synthetic API key Enrich Layer does not know each answer a 4xx status (unverified: 401), never a 2xx (a 2xx error body would be returned as the profile) and not a 5xx; the connector reports `linkedin_profile_failed` and `linkedin_email_failed` with that status. The error bodies are not checked: the connector does not read them.',
    fixtures: [linkedInSearchEnrichLayerUnauthorizedFixture.id],
    run: Effect.gen(function* () {
      const linkedinUrl = yield* requireSeed('profileUrl')
      const resolver = invalidKeyResolver(invalidEnrichLayerApiKey)

      const profileResult = yield* profile(linkedinUrl).pipe(
        Effect.provideService(CredentialResolver, resolver)
      )

      yield* expectClientError(
        profileResult,
        'linkedin_profile_failed',
        'linkedin_search.profile with an unknown Enrich Layer key'
      )

      const emailResult = yield* email(linkedinUrl).pipe(
        Effect.provideService(CredentialResolver, resolver)
      )

      yield* expectClientError(
        emailResult,
        'linkedin_email_failed',
        'linkedin_search.email with an unknown Enrich Layer key'
      )
    })
  })

export const linkedInSearchProfileNotFoundCase: LinkedInSearchConformanceCase =
  defineConformanceCase({
    id: 'linkedin-search.errors.profile-not-found',
    title: 'a profile URL that names no profile answers a 4xx status, never an empty 2xx profile',
    safety: 'read',
    docs: '`linkedin_search.profile` returns any 2xx JSON body as the profile, so a missing profile must come back as a non-2xx status for the connector to report it: `linkedin_profile_failed` with the HTTP status and the raw body as `underlying`.',
    wire: '`linkedin_search.profile` for the seeded `absentProfileUrl` (a well-formed profile URL that names no profile) answers a 4xx status (unverified: 404), never a 2xx (which the connector would return as an empty or placeholder profile) and not a 5xx; the connector reports `linkedin_profile_failed` with that status.',
    fixtures: [linkedInSearchProfileNotFoundFixture.id],
    run: Effect.gen(function* () {
      const linkedinUrl = yield* requireSeed('absentProfileUrl')
      const result = yield* profile(linkedinUrl)

      yield* expectClientError(
        result,
        'linkedin_profile_failed',
        'linkedin_search.profile for a profile URL that names no profile'
      )
    })
  })

/** Every LinkedIn search conformance case, in fixture order. */
export const linkedInSearchConformanceCases: ReadonlyArray<LinkedInSearchConformanceCase> = [
  linkedInSearchPeopleResultsCase,
  linkedInSearchNumResultsLimitCase,
  linkedInSearchProfileCase,
  linkedInSearchEmailLookupCase,
  linkedInSearchExaUnauthorizedCase,
  linkedInSearchEnrichLayerUnauthorizedCase,
  linkedInSearchProfileNotFoundCase
]
