/**
 * LinkedIn search emulator state: the Exa people searches and the Enrich Layer profiles the state
 * answers, the absent profiles, and the digests of the API keys a seed marks as rejected on each
 * origin, with the seed input and the default seed (internal; re-exported by
 * `src/linkedin-search.ts`).
 *
 * The default entities are the synthetic LinkedIn search conformance fixtures, copied as data
 * (the seeded query with the three answers the fixtures record for `numResults` 10, 3, and 2, the
 * seeded profile with its profile and email answers, and the seeded absent profile), never
 * imported from SDK code. The default rejected keys are the synthetic invalid keys the two
 * unauthorized cases send (no account data). Every rendered answer keeps the fixtures' key order.
 *
 * Rejected keys are never kept: the state holds only their per-origin digests (SHA-256 of the
 * origin, a space, and the key), so a rejected key that a request carries as its bearer reaches
 * neither the state nor `/_emulate/*`. There are no writes, cursors, minted ids, or clock reads.
 *
 * @experimental
 */
import { createHash } from 'node:crypto'
import { Result } from 'effect'
import * as Schema from 'effect/Schema'
import { isRecognisableBearerValue } from '../stateful-secrets.ts'

/** The origin every Exa fixture records; another origin is not emulated. */
export const linkedInSearchEmulatorExaOrigin = 'https://api.exa.ai'

/** The origin every Enrich Layer fixture records (its API base is `/api/v2`). */
export const linkedInSearchEmulatorEnrichLayerOrigin = 'https://enrichlayer.com'

/**
 * The per-origin digest of an API key: SHA-256 (hex) of the origin, a space, and the key. Neither
 * an origin nor a recognisable bearer holds a space, so distinct pairs never share a text.
 */
export const linkedInSearchKeyDigest = (key: string, origin: string): string =>
  createHash('sha256').update(`${origin} ${key}`, 'utf8').digest('hex')

/** A search query as the cases seed it: trimmed, non-empty, one line, at most 500 characters. */
export const linkedInSearchQueryPattern = /^\S(?:.*\S)?$/

/** A LinkedIn person profile URL as the actions take it: `https://<host>/in/<slug>`. */
export const linkedInSearchProfileUrlPattern = /^https:\/\/[A-Za-z0-9.-]+\/in\/[^\s?#]+$/

/** The largest `numResults` the emulator takes. */
export const linkedInSearchMaxNumResults = 100

const SearchQuery = Schema.String.check(
  Schema.isPattern(linkedInSearchQueryPattern),
  Schema.isMaxLength(500)
)

const ProfileUrl = Schema.String.check(
  Schema.isPattern(linkedInSearchProfileUrlPattern),
  Schema.isMaxLength(2048)
)

const NumResults = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(linkedInSearchMaxNumResults)
)

/**
 * An API key a seed marks as rejected (checked to be a recognisable fail-closed bearer value after
 * decoding, with a constant reason: a key is a credential, so no reason quotes it).
 */
const RejectedKey = Schema.String

/** A SHA-256 digest (64 lower-case hex digits). */
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** One Exa result, in the fixtures' fields (each a string, or absent; never null). */
export const LinkedInSearchEmulatorResult = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  publishedDate: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String)
})

export type LinkedInSearchEmulatorResult = typeof LinkedInSearchEmulatorResult.Type

/**
 * An Exa people search the state answers: the query, the `numResults` it was asked with, and the
 * results answered (1 to `numResults`; no fixture records an empty search).
 */
export const LinkedInSearchEmulatorSearch = Schema.Struct({
  query: SearchQuery,
  numResults: NumResults,
  results: Schema.Array(LinkedInSearchEmulatorResult)
})

export type LinkedInSearchEmulatorSearch = typeof LinkedInSearchEmulatorSearch.Type

/**
 * An Enrich Layer profile the state answers, in the profile fixture's fields, and the email its
 * lookup answers (absent: an email lookup of this profile is not emulated).
 */
export const LinkedInSearchEmulatorProfile = Schema.Struct({
  url: ProfileUrl,
  publicIdentifier: Schema.String,
  fullName: Schema.String,
  headline: Schema.String,
  email: Schema.optionalKey(Schema.String)
})

export type LinkedInSearchEmulatorProfile = typeof LinkedInSearchEmulatorProfile.Type

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const LinkedInSearchEmulatorStateSchema = Schema.Struct({
  /** Digests (for the Exa origin) of the keys Exa answers with the recorded 401. */
  exaRejectedKeyDigests: Schema.Array(Digest),
  searches: Schema.Array(LinkedInSearchEmulatorSearch),
  /** Digests (for the Enrich Layer origin) of the keys Enrich Layer answers with the 401. */
  enrichLayerRejectedKeyDigests: Schema.Array(Digest),
  profiles: Schema.Array(LinkedInSearchEmulatorProfile),
  /** Profile URLs that name no profile: their profile lookup answers the recorded 404. */
  absentProfileUrls: Schema.Array(ProfileUrl)
})

export type LinkedInSearchEmulatorState = typeof LinkedInSearchEmulatorStateSchema.Type

/**
 * A typed seed: every key, when given, replaces that part of the default seed (the fixture
 * entities). Rejected keys are given as keys and kept only as their per-origin digests.
 */
export const LinkedInSearchEmulatorSeed = Schema.Struct({
  exaRejectedKeys: Schema.optionalKey(Schema.Array(RejectedKey)),
  searches: Schema.optionalKey(Schema.Array(LinkedInSearchEmulatorSearch)),
  enrichLayerRejectedKeys: Schema.optionalKey(Schema.Array(RejectedKey)),
  profiles: Schema.optionalKey(Schema.Array(LinkedInSearchEmulatorProfile)),
  absentProfileUrls: Schema.optionalKey(Schema.Array(ProfileUrl))
})

export type LinkedInSearchEmulatorSeed = typeof LinkedInSearchEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(LinkedInSearchEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(LinkedInSearchEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// Default entities, copied from the fixtures.

const seededQuery = 'synthetic conformance engineer'

const person01: LinkedInSearchEmulatorResult = {
  title: 'Synthetic Person 01 | Conformance Engineer at Example Synthetic Co',
  url: 'https://linkedin.example.com/in/synthetic-person-01',
  author: 'Synthetic Person 01',
  text: 'Synthetic Person 01. Conformance Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
}

const person02: LinkedInSearchEmulatorResult = {
  title: 'Synthetic Person 02 | Test Engineer at Example Synthetic Co',
  url: 'https://linkedin.example.com/in/synthetic-person-02',
  author: 'Synthetic Person 02',
  publishedDate: '2026-01-15T00:00:00.000Z',
  text: 'Synthetic Person 02. Test Engineer at Example Synthetic Co. Synthetic profile text, not a real person.'
}

const person03: LinkedInSearchEmulatorResult = {
  title: 'Synthetic Person 03 | Conformance Lead at Example Synthetic Labs',
  url: 'https://linkedin.example.com/in/synthetic-person-03'
}

/** The limited search's second result: the fixture records it without `publishedDate`. */
const { publishedDate: _limitedOmits, ...person02Limited } = person02

const defaultSearches: ReadonlyArray<LinkedInSearchEmulatorSearch> = [
  // The people-results fixture (the connector's default numResults).
  { query: seededQuery, numResults: 10, results: [person01, person02, person03] },
  // The num-results-limit fixture: the control, then the limited search.
  { query: seededQuery, numResults: 3, results: [person01, person02, person03] },
  { query: seededQuery, numResults: 2, results: [person01, person02Limited] }
]

const defaultProfiles: ReadonlyArray<LinkedInSearchEmulatorProfile> = [
  {
    url: 'https://linkedin.example.com/in/synthetic-person-01',
    publicIdentifier: 'synthetic-person-01',
    fullName: 'Synthetic Person 01',
    headline: 'Conformance Engineer at Example Synthetic Co',
    email: 'synthetic-person-01@example.com'
  }
]

const defaultAbsentProfileUrls: ReadonlyArray<string> = [
  'https://linkedin.example.com/in/synthetic-absent-person-00'
]

/** The synthetic invalid keys the unauthorized cases send (never account data). */
export const linkedInSearchEmulatorDefaultRejectedKeys = {
  exa: ['yolk-conformance-invalid-exa-key'],
  enrichLayer: ['yolk-conformance-invalid-enrich-layer-key']
} as const

const duplicate = <A>(values: ReadonlyArray<A>): A | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

type SeedParts = {
  readonly exaRejectedKeys: ReadonlyArray<string>
  readonly searches: ReadonlyArray<LinkedInSearchEmulatorSearch>
  readonly enrichLayerRejectedKeys: ReadonlyArray<string>
  readonly profiles: ReadonlyArray<LinkedInSearchEmulatorProfile>
  readonly absentProfileUrls: ReadonlyArray<string>
}

/** Integrity problems a decoded seed can still have. */
const seedProblem = (parts: SeedParts): string | undefined => {
  const searchKey = duplicate(
    parts.searches.map(search => JSON.stringify([search.query, search.numResults]))
  )

  if (searchKey !== undefined) return `duplicate search ${searchKey}`

  for (const search of parts.searches) {
    // No fixture records an empty search, and Exa answers at most numResults results.
    if (search.results.length === 0 || search.results.length > search.numResults) {
      return 'every search answers 1 to numResults results'
    }
  }

  const url = duplicate([...parts.profiles.map(profile => profile.url), ...parts.absentProfileUrls])

  if (url !== undefined) return `profile URL ${url} is seeded twice (as a profile or absent)`

  for (const [label, keys] of [
    ['Exa', parts.exaRejectedKeys],
    ['Enrich Layer', parts.enrichLayerRejectedKeys]
  ] as const) {
    if (!keys.every(isRecognisableBearerValue)) {
      return `every ${label} rejected key must be a recognisable bearer value`
    }
  }

  if (duplicate(parts.exaRejectedKeys) !== undefined) return 'duplicate Exa rejected key'

  return duplicate(parts.enrichLayerRejectedKeys) === undefined
    ? undefined
    : 'duplicate Enrich Layer rejected key'
}

const stateFromSeed = (seed: LinkedInSearchEmulatorSeed): LinkedInSearchEmulatorState | string => {
  const parts: SeedParts = {
    exaRejectedKeys: seed.exaRejectedKeys ?? linkedInSearchEmulatorDefaultRejectedKeys.exa,
    searches: seed.searches ?? defaultSearches,
    enrichLayerRejectedKeys:
      seed.enrichLayerRejectedKeys ?? linkedInSearchEmulatorDefaultRejectedKeys.enrichLayer,
    profiles: seed.profiles ?? defaultProfiles,
    absentProfileUrls: seed.absentProfileUrls ?? defaultAbsentProfileUrls
  }

  return (
    seedProblem(parts) ?? {
      exaRejectedKeyDigests: parts.exaRejectedKeys.map(key =>
        linkedInSearchKeyDigest(key, linkedInSearchEmulatorExaOrigin)
      ),
      searches: parts.searches,
      enrichLayerRejectedKeyDigests: parts.enrichLayerRejectedKeys.map(key =>
        linkedInSearchKeyDigest(key, linkedInSearchEmulatorEnrichLayerOrigin)
      ),
      profiles: parts.profiles,
      absentProfileUrls: parts.absentProfileUrls
    }
  )
}

/** Decode and build a seed; a string is the reason it is invalid (never a seeded key). */
export const buildSeedState = (input: unknown): LinkedInSearchEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  if (Result.isFailure(decoded)) {
    // A schema message may quote the offending value, and a rejected key is a credential.
    const message = issueMessage(decoded.failure.issue)

    return /RejectedKeys/.test(message) ? 'rejected keys must be an array of strings' : message
  }

  return stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeState = (input: unknown): LinkedInSearchEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : decoded.success
}
