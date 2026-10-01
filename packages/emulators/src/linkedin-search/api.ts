/**
 * LinkedIn search emulator API: the route table (evidence, request-shape checks, and state-reading
 * plans), the fixture error bodies, and answer rendering (internal; re-exported by
 * `src/linkedin-search.ts`).
 *
 * Only the routes the seven LinkedIn search conformance cases send are emulated, each on its
 * recorded origin: the Exa people search (`POST /search` on `https://api.exa.ai`) and the Enrich
 * Layer profile and email lookups (`GET /api/v2/profile` and `GET /api/v2/profile/email` on
 * `https://enrichlayer.com`). Every route is a read: a plan reads the state and answers a fixture's
 * response or refuses (400 not-emulated, no fault used up); no commit writes.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactBodyKeys,
  exactQuery,
  integerIn,
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type Commit,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import {
  linkedInSearchEmulatorEnrichLayerOrigin,
  linkedInSearchEmulatorExaOrigin,
  linkedInSearchMaxNumResults,
  linkedInSearchProfileUrlPattern,
  linkedInSearchQueryPattern,
  type LinkedInSearchEmulatorProfile,
  type LinkedInSearchEmulatorResult,
  type LinkedInSearchEmulatorSearch,
  type LinkedInSearchEmulatorState
} from './state.ts'

/** Content type of every answer, as the fixtures record it. */
const contentType = 'application/json'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type LinkedInSearchEmulatorDrills = {
  /** A search with the default `numResults` (10) answers its results without `text`. */
  readonly defaultSearchWithoutText?: boolean
  /** A search answers the query's seeded search with the most results, whatever `numResults`. */
  readonly numResultsIgnored?: boolean
  /** A profile lookup answers an empty JSON object. */
  readonly profileAnswersEmptyObject?: boolean
  /** An email lookup answers a JSON object without `email`. */
  readonly emailAnswerOmitsEmail?: boolean
  /** A rejected Exa key answers status 500 (with the recorded 401 body). */
  readonly exaUnauthorizedAs5xx?: boolean
  /** A rejected Enrich Layer key answers status 200 (with the recorded 401 body). */
  readonly enrichLayerUnauthorizedAs2xx?: boolean
  /** An absent profile answers status 200 (with the recorded 404 body). */
  readonly absentProfileAs2xx?: boolean
}

export const linkedInSearchEmulatorDrillKnobs: ReadonlyArray<keyof LinkedInSearchEmulatorDrills> = [
  'defaultSearchWithoutText',
  'numResultsIgnored',
  'profileAnswersEmptyObject',
  'emailAnswerOmitsEmail',
  'exaUnauthorizedAs5xx',
  'enrichLayerUnauthorizedAs2xx',
  'absentProfileAs2xx'
]

export type LinkedInSearchApiEnv = {
  readonly drills: Readonly<Record<keyof LinkedInSearchEmulatorDrills, boolean>>
}

/**
 * The fixtures' error bodies, byte for byte (`JSON.stringify` keeps this key order): Exa's 401,
 * Enrich Layer's 401 (the profile and the email lookup answer the same body), and Enrich Layer's
 * not-found 404.
 */
export const linkedInSearchEmulatorErrorBodies = {
  exaUnauthorized: { requestId: 'synthetic-request-0003', error: 'Invalid API key' },
  enrichLayerUnauthorized: { code: 401, description: 'Invalid API Key', name: 'Unauthorized' },
  profileNotFound: { code: 404, description: 'Person profile does not exist', name: 'Not Found' }
} as const satisfies Readonly<Record<string, Schema.Json>>

type Route = StatefulRoute<LinkedInSearchEmulatorState, LinkedInSearchApiEnv>

const peopleResultsCase = 'linkedin-search.search.people-results'

const numResultsLimitCase = 'linkedin-search.search.num-results-limit'

const profileCase = 'linkedin-search.profile.get-profile'

const emailCase = 'linkedin-search.email.lookup-answer'

const exaUnauthorizedCase = 'linkedin-search.errors.exa-unauthorized'

const enrichLayerUnauthorizedCase = 'linkedin-search.errors.enrich-layer-unauthorized'

const profileNotFoundCase = 'linkedin-search.errors.profile-not-found'

const evidence = (
  method: string,
  path: string,
  origin: string,
  caseIds: ReadonlyArray<string>
) => ({
  method,
  path,
  kind: 'connector' as const,
  write: false,
  caseIds,
  evidence: 'unverified' as const,
  origin,
  // No route has a path parameter: every raw path is matched exactly.
  params: {}
})

const json = (status: number, body: Schema.Json): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } })

/** A read-only commit. */
const answer =
  (response: () => Response): Commit =>
  () =>
    response()

/** Whether the request's per-origin bearer digest is one a seed marks as rejected. */
const rejected = (digests: ReadonlyArray<string>, digest: string | undefined): boolean =>
  digest !== undefined && digests.includes(digest)

// Exa people search.

type SearchInput = {
  readonly query: string
  readonly numResults: number
  readonly bearerDigest: string | undefined
}

/** The connector's default `numResults` (the people-results fixture's). */
const defaultNumResults = 10

/** The result fields, in the fixtures' key order. */
const resultKeys = ['title', 'url', 'author', 'publishedDate', 'text'] as const

const renderResult = (result: LinkedInSearchEmulatorResult): Schema.JsonObject => {
  const rendered: Record<string, string> = {}

  for (const key of resultKeys) {
    const value = result[key]

    if (value !== undefined) rendered[key] = value
  }

  return rendered
}

/** The search the state answers for the input, or `undefined` (drills aside: the exact one). */
const searchFor = (
  state: LinkedInSearchEmulatorState,
  input: SearchInput,
  env: LinkedInSearchApiEnv
): LinkedInSearchEmulatorSearch | undefined => {
  const exact = state.searches.find(
    search => search.query === input.query && search.numResults === input.numResults
  )

  if (exact === undefined || !env.drills.numResultsIgnored) return exact

  // The drill: the query's widest seeded answer (the first of the widest), whatever was asked.
  return state.searches
    .filter(search => search.query === input.query)
    .reduce((widest, search) => (search.results.length > widest.results.length ? search : widest))
}

const search: Route = statefulRoute(
  {
    ...evidence('POST', '/search', linkedInSearchEmulatorExaOrigin, [
      peopleResultsCase,
      numResultsLimitCase,
      exaUnauthorizedCase
    ])
  },
  'json',
  (request): SearchInput | NotEmulated => {
    const query = exactQuery(request, [])

    if (isNotEmulated(query)) return query

    const body = exactBodyKeys(request.json, 'the search body', [
      'query',
      'category',
      'numResults',
      'type',
      'contents'
    ])

    if (isNotEmulated(body)) return body

    const text = body.query

    if (!Predicate.isString(text) || !linkedInSearchQueryPattern.test(text) || text.length > 500) {
      return notEmulated('query must be one trimmed, non-empty line of at most 500 characters')
    }

    if (body.category !== 'people') return notEmulated('category other than people is not emulated')

    if (body.type !== 'auto') return notEmulated('type other than auto is not emulated')

    const contents = exactBodyKeys(body.contents, 'contents', ['text'])

    if (isNotEmulated(contents)) return contents

    if (contents.text !== true)
      return notEmulated('contents other than { text: true } is not emulated')

    const numResults = integerIn(body.numResults, 'numResults', 1, linkedInSearchMaxNumResults)

    if (isNotEmulated(numResults)) return numResults

    return { query: text, numResults, bearerDigest: request.bearerDigest }
  },
  (state, input, { env }) => {
    if (rejected(state.exaRejectedKeyDigests, input.bearerDigest)) {
      // The Exa unauthorized fixture's 401, whatever the (well-formed) search.
      return answer(() =>
        json(
          env.drills.exaUnauthorizedAs5xx ? 500 : 401,
          linkedInSearchEmulatorErrorBodies.exaUnauthorized
        )
      )
    }

    const found = searchFor(state, input, env)

    if (found === undefined) {
      return notEmulated(
        'a search the state holds no answer for (this query and numResults) is not emulated'
      )
    }

    return answer(() =>
      json(200, {
        results: found.results.map(result => {
          const rendered = renderResult(result)

          if (!env.drills.defaultSearchWithoutText || input.numResults !== defaultNumResults) {
            return rendered
          }

          const { text: _text, ...withoutText } = rendered

          return withoutText
        })
      })
    )
  }
)

// Enrich Layer lookups.

type LookupInput = { readonly url: string; readonly bearerDigest: string | undefined }

/** The one `linkedin_profile_url` query parameter: a profile URL (decoded once). */
const lookupInput = (request: EmulatedRequest): LookupInput | NotEmulated => {
  const query = exactQuery(request, ['linkedin_profile_url'])

  if (isNotEmulated(query)) return query

  const url = query.linkedin_profile_url ?? ''

  if (!linkedInSearchProfileUrlPattern.test(url) || url.length > 2048) {
    return notEmulated('linkedin_profile_url must be a profile URL https://<host>/in/<slug>')
  }

  return { url, bearerDigest: request.bearerDigest }
}

const profileHeld = (
  state: LinkedInSearchEmulatorState,
  url: string
): LinkedInSearchEmulatorProfile | undefined => state.profiles.find(profile => profile.url === url)

/** The Enrich Layer unauthorized fixture's 401 (both lookups answer it). */
const enrichLayerUnauthorized = (env: LinkedInSearchApiEnv): Commit =>
  answer(() =>
    json(
      env.drills.enrichLayerUnauthorizedAs2xx ? 200 : 401,
      linkedInSearchEmulatorErrorBodies.enrichLayerUnauthorized
    )
  )

const profile: Route = statefulRoute(
  evidence('GET', '/api/v2/profile', linkedInSearchEmulatorEnrichLayerOrigin, [
    profileCase,
    enrichLayerUnauthorizedCase,
    profileNotFoundCase
  ]),
  'none',
  lookupInput,
  (state, input, { env }) => {
    if (rejected(state.enrichLayerRejectedKeyDigests, input.bearerDigest)) {
      return enrichLayerUnauthorized(env)
    }

    const held = profileHeld(state, input.url)

    if (held !== undefined) {
      return answer(() =>
        json(
          200,
          env.drills.profileAnswersEmptyObject
            ? {}
            : {
                public_identifier: held.publicIdentifier,
                full_name: held.fullName,
                headline: held.headline
              }
        )
      )
    }

    if (state.absentProfileUrls.includes(input.url)) {
      return answer(() =>
        json(
          env.drills.absentProfileAs2xx ? 200 : 404,
          linkedInSearchEmulatorErrorBodies.profileNotFound
        )
      )
    }

    return notEmulated(
      'a profile URL the state holds neither as a profile nor as absent is not emulated'
    )
  }
)

const email: Route = statefulRoute(
  evidence('GET', '/api/v2/profile/email', linkedInSearchEmulatorEnrichLayerOrigin, [
    emailCase,
    enrichLayerUnauthorizedCase
  ]),
  'none',
  lookupInput,
  (state, input, { env }) => {
    if (rejected(state.enrichLayerRejectedKeyDigests, input.bearerDigest)) {
      return enrichLayerUnauthorized(env)
    }

    const address = profileHeld(state, input.url)?.email

    if (address === undefined) {
      return notEmulated(
        'an email lookup of a profile the state holds no email answer for is not emulated'
      )
    }

    return answer(() => json(200, env.drills.emailAnswerOmitsEmail ? {} : { email: address }))
  }
)

/** Every emulated route, in manifest order. */
export const linkedInSearchApiRoutes: ReadonlyArray<Route> = [search, profile, email]
