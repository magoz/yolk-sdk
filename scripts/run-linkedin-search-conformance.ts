/**
 * LinkedIn search conformance runner for the Exa and Enrich Layer APIs
 * (`pnpm conformance:linkedin-search`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Exa and Enrich Layer
 * APIs with a `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is
 * non-empty and without `--owner-approved`. Every case is a read (the connector has no write
 * action), but a live run spends Exa and Enrich Layer credits and looks up real people, so it
 * needs the repository owner's approval all the same. Neither provider has a sandbox: the keys are
 * real, paid keys (use dedicated low-credit ones), and `--profile-url` should name a profile whose
 * owner consented, for example the repository owner's own. `--profile-url` and
 * `--absent-profile-url` must be `linkedin.com` profile URLs for a live run (replay is
 * host-agnostic), so the not-found case exercises a missing profile, not URL validation. Requires
 * both API keys from the environment only, never a flag: `EXA_API_KEY` (the Exa key) and
 * `ENRICH_LAYER_API_KEY` (the Enrich Layer key); each is refused before any request unless it has
 * 16 to 256 letters, digits, `_`, or `-`, and neither is ever printed. Every printed line is
 * redacted of both keys, and `--record` refuses to stage a recording, rendered file, or
 * review-checklist line carrying either one, naming which (the recorder never keeps
 * `authorization`, the only header that carries them). Also requires the seeds of every case that
 * will run (flags or environment, see the usage text). There are no write cases, so
 * `--allow-writes` changes nothing and there is no leftover lookup.
 *
 * `--record` (with `--live`) stages verified recordings all or nothing in a new run directory
 * under the gitignored `.conformance-recordings/linkedin-search/`; each fixture records its own
 * provider's base URL as `endpoint`, and the review checklist lists every string value they hold.
 * Promotion is manual. The recordings hold real third parties' personal data (search results name
 * other people; a profile carries names, history, other people's names, phone numbers, image
 * URLs; an email address), and this repository is public. Never scrub them field by field: replace
 * each recorded 2xx body wholesale with a minimal synthetic body that keeps only the keys and types
 * the case reads, with obviously synthetic values (`Synthetic Person 01`,
 * `https://linkedin.example.com/in/synthetic-person-01`, `example.com` addresses). Replace the
 * seeded URLs and query in requests and `seeds.ts` the same way. Then copy the files into
 * `packages/connectors/src/linkedin-search/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/linkedin-search-conformance.test.ts` (whose word-level allowlist
 * refuses any word outside its short synthetic vocabulary in a 2xx body, request query, or seed;
 * see the test for exactly what it enforces) and
 * `scripts/test/run-linkedin-search-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  LinkedInSearchConformanceConfig,
  LinkedInSearchConformanceSeeds,
  linkedInSearchConformanceCases,
  linkedInSearchConformanceCredentials,
  linkedInSearchConformanceFixtureSeeds,
  type LinkedInSearchConformanceError,
  type LinkedInSearchConformanceRequirements,
  type LinkedInSearchConformanceSeedKey
} from '../packages/connectors/src/linkedin-search/conformance/index.ts'
import {
  enrichLayerApiBaseUrl,
  exaApiBaseUrl,
  exaApiKeySlotId
} from '../packages/connectors/src/linkedin-search/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Environment variable holding the Exa API key (the runner's access token). */
export const exaApiKeyEnv = 'EXA_API_KEY'

/** Environment variable holding the Enrich Layer API key (the runner's extra token). */
export const enrichLayerApiKeyEnv = 'ENRICH_LAYER_API_KEY'

/**
 * The format both keys must have: long enough for the live-output redaction to recognise a
 * truncated echo (it looks for 16 consecutive key characters), in the characters API keys use.
 */
const apiKeyFormat = {
  pattern: /^[A-Za-z0-9_-]{16,256}$/,
  description: '16 to 256 letters, digits, _ or -'
}

/** Where each seed comes from. Flags win over environment variables. */
export const linkedInSearchSeedSources: ReadonlyArray<
  SeedSource<LinkedInSearchConformanceSeedKey>
> = [
  {
    key: 'searchQuery',
    flag: '--search-query',
    env: 'LINKEDIN_SEARCH_CONFORMANCE_QUERY',
    description: 'Exa people query that matches more than two people (the limit case checks)'
  },
  {
    key: 'profileUrl',
    flag: '--profile-url',
    env: 'LINKEDIN_SEARCH_CONFORMANCE_PROFILE_URL',
    description:
      "https://www.linkedin.com/in/<slug> of a profile whose owner consented (e.g. the owner's own)"
  },
  {
    key: 'absentProfileUrl',
    flag: '--absent-profile-url',
    env: 'LINKEDIN_SEARCH_CONFORMANCE_ABSENT_PROFILE_URL',
    description: 'https://www.linkedin.com/in/<slug> URL that names no profile (a made-up slug)'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const linkedInSearchCaseSpecs: ReadonlyArray<CaseSpec<LinkedInSearchConformanceSeedKey>> = [
  {
    caseId: 'linkedin-search.search.people-results',
    seeds: ['searchQuery'],
    optionalSeeds: [],
    fileName: 'people-results.ts',
    exportName: 'linkedInSearchPeopleResultsFixture',
    doc: '`linkedin_search.search` for the seeded query with the default `numResults` (10): one POST /search.',
    endpoint: exaApiBaseUrl
  },
  {
    caseId: 'linkedin-search.search.num-results-limit',
    seeds: ['searchQuery'],
    optionalSeeds: [],
    fileName: 'num-results-limit.ts',
    exportName: 'linkedInSearchNumResultsLimitFixture',
    doc: 'The control and the limited search: `linkedin_search.search` for the seeded query with `numResults: 3`, then with `numResults: 2` (two POST /search).',
    endpoint: exaApiBaseUrl
  },
  {
    caseId: 'linkedin-search.profile.get-profile',
    seeds: ['profileUrl'],
    optionalSeeds: [],
    fileName: 'profile.ts',
    exportName: 'linkedInSearchProfileFixture',
    doc: '`linkedin_search.profile` for the seeded profile URL: one GET /profile.',
    endpoint: enrichLayerApiBaseUrl
  },
  {
    caseId: 'linkedin-search.email.lookup-answer',
    seeds: ['profileUrl'],
    optionalSeeds: [],
    fileName: 'email-lookup.ts',
    exportName: 'linkedInSearchEmailLookupFixture',
    doc: '`linkedin_search.email` for the seeded profile URL: one GET /profile/email.',
    endpoint: enrichLayerApiBaseUrl
  },
  {
    caseId: 'linkedin-search.errors.exa-unauthorized',
    seeds: [],
    optionalSeeds: [],
    fileName: 'exa-unauthorized.ts',
    exportName: 'linkedInSearchExaUnauthorizedFixture',
    doc: '`linkedin_search.search` with a synthetic API key Exa does not know.',
    endpoint: exaApiBaseUrl
  },
  {
    caseId: 'linkedin-search.errors.enrich-layer-unauthorized',
    seeds: ['profileUrl'],
    optionalSeeds: [],
    fileName: 'enrich-layer-unauthorized.ts',
    exportName: 'linkedInSearchEnrichLayerUnauthorizedFixture',
    doc: '`linkedin_search.profile`, then `linkedin_search.email`, for the seeded profile URL with a synthetic API key Enrich Layer does not know.',
    endpoint: enrichLayerApiBaseUrl
  },
  {
    caseId: 'linkedin-search.errors.profile-not-found',
    seeds: ['absentProfileUrl'],
    optionalSeeds: [],
    fileName: 'profile-not-found.ts',
    exportName: 'linkedInSearchProfileNotFoundFixture',
    doc: '`linkedin_search.profile` for the seeded absent profile URL.',
    endpoint: enrichLayerApiBaseUrl
  }
]

/** The live credentials: the Exa key and the Enrich Layer key, each for its own slot. */
export const liveCredentials = (exaApiKey: string, enrichLayerApiKey: string) =>
  linkedInSearchConformanceCredentials({ exaApiKey, enrichLayerApiKey })

/**
 * The static credentials for the case ports. Without an Enrich Layer key the Enrich Layer slot is
 * left out, so the resolver fails `credential_missing` and the profile and email actions fail
 * (`credential_binding_missing`) before any request: never an empty key sent as `Bearer `.
 */
const caseCredentials = (exaApiKey: string, enrichLayerApiKey: string | undefined) =>
  enrichLayerApiKey === undefined
    ? { [exaApiKeySlotId]: ApiKeyCredential.make({ key: exaApiKey }) }
    : liveCredentials(exaApiKey, enrichLayerApiKey)

export const linkedInSearchCasePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  exaApiKey: string,
  seeds: LinkedInSearchConformanceSeeds,
  extraTokens: Readonly<Record<string, string>>
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(caseCredentials(exaApiKey, extraTokens[enrichLayerApiKeyEnv])),
    Layer.succeed(LinkedInSearchConformanceConfig, seeds)
  )

/** A LinkedIn person profile URL on `linkedin.com` or one of its subdomains. */
const linkedInProfileUrl = /^https:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\//

/**
 * The live seed check: the case schema, plus a `linkedin.com` host for both profile URLs (the case
 * schema stays host-agnostic so the synthetic fixtures replay on `linkedin.example.com`). A live
 * profile URL on another host would make the not-found case pass on URL validation alone.
 */
export const decodeLiveSeeds = (raw: unknown) =>
  Option.filter(Schema.decodeUnknownOption(LinkedInSearchConformanceSeeds)(raw), seeds =>
    [seeds.profileUrl, seeds.absentProfileUrl].every(
      url => url === undefined || linkedInProfileUrl.test(url)
    )
  )

export const linkedInSearchRunner = {
  provider: 'linkedin-search',
  displayName: 'LinkedIn search',
  practiceTarget:
    'dedicated low-credit Exa and Enrich Layer keys (real, paid: neither has a sandbox) and a consenting profile',
  usageTarget:
    "dedicated low-credit Exa and Enrich Layer keys (real, paid keys: neither provider has a\nsandbox) and, as --profile-url, a profile whose owner consented (for example the repository\nowner's own)",
  tokenEnv: exaApiKeyEnv,
  tokenScopes: 'an Exa API key (every case is a read; a run spends Exa search credits)',
  tokenFormat: apiKeyFormat,
  extraTokens: [
    {
      env: enrichLayerApiKeyEnv,
      scopes:
        'an Enrich Layer API key (every case is a read; a run spends Enrich Layer profile and email credits)',
      tokenFormat: apiKeyFormat
    }
  ],
  endpoint: exaApiBaseUrl,
  cases: linkedInSearchConformanceCases,
  seedSources: linkedInSearchSeedSources,
  caseSpecs: linkedInSearchCaseSpecs,
  fixtureSeeds: linkedInSearchConformanceFixtureSeeds,
  seedNoun: 'data',
  seedsTypeName: 'LinkedInSearchConformanceSeeds',
  seedsExportName: 'linkedInSearchConformanceFixtureSeeds',
  configName: 'LinkedInSearchConformanceConfig',
  decodeSeeds: decodeLiveSeeds,
  invalidSeedsMessage:
    '--search-query must be a trimmed one-line query, and --profile-url and --absent-profile-url https://www.linkedin.com/in/<slug> URLs without a query or fragment',
  casePorts: linkedInSearchCasePorts,
  recordedRequestHeaders: [],
  // Read-only cases create nothing, so an interrupted run leaves nothing behind.
  recoveryAdvice:
    'Every LinkedIn search case is a read: nothing was created, and there is nothing to look for.',
  // This runner lists every string value (`listEveryString`), so these never match.
  nameKeys: /(?!)/,
  textKeys: /(?!)/,
  // A profile carries far more personal fields than any key list names (other people, phone
  // numbers, image URLs): the checklist lists every string value instead.
  listEveryString: true,
  reviewNotice: {
    heading:
      "REVIEW before promoting (staged files hold real third parties' personal data, and this repository is public):",
    seeds:
      'the seeds name real people (a profile URL, a query); replace each with a synthetic value',
    promote:
      'replace each recorded 2xx body wholesale with a minimal synthetic body that keeps only the keys and types the case reads (never scrub field by field)',
    stagedFixture: 'replaced wholesale and promoted by hand',
    stagedSeeds: 'a replaced recording'
  }
} satisfies ConnectorConformanceRunner<
  LinkedInSearchConformanceSeedKey,
  LinkedInSearchConformanceSeeds,
  LinkedInSearchConformanceError,
  LinkedInSearchConformanceRequirements
>

/** Gitignored root of staged LinkedIn search recordings. */
export const recordingsRoot = recordingsRootFor(linkedInSearchRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(linkedInSearchRunner)
}
