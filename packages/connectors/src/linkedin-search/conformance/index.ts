/**
 * LinkedIn search conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that
 * back their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions (Exa people search, Enrich Layer profile and email)
 * over the connector ports, and every case is a read. The current fixtures are synthetic
 * placeholders (`evidence: 'unverified'`) shaped like the Exa and Enrich Layer wires; every person,
 * company, profile URL, and email address in them is synthetic (`linkedin.example.com`,
 * `example.com`), and they carry no API key. This command stages verified recordings in a
 * gitignored directory:
 *
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record`
 *
 * Recordings hold real third parties' personal data, and this repository is public. Before
 * promoting one here, replace each recorded 2xx body wholesale with a minimal synthetic body that
 * keeps only the keys and types the case reads (never scrub field by field), and update the tests
 * together with it (fixture ids, `evidence`, and `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { linkedInSearchEmailLookupFixture } from './email-lookup.ts'
import { linkedInSearchEnrichLayerUnauthorizedFixture } from './enrich-layer-unauthorized.ts'
import { linkedInSearchExaUnauthorizedFixture } from './exa-unauthorized.ts'
import { linkedInSearchNumResultsLimitFixture } from './num-results-limit.ts'
import { linkedInSearchPeopleResultsFixture } from './people-results.ts'
import { linkedInSearchProfileFixture } from './profile.ts'
import { linkedInSearchProfileNotFoundFixture } from './profile-not-found.ts'

export {
  LinkedInSearchConformanceActionFailed,
  LinkedInSearchConformanceConfig,
  LinkedInSearchConformanceSeeds,
  linkedInSearchConformanceCases,
  linkedInSearchConformanceCredentials,
  linkedInSearchConformanceEnrichLayerCredentialRef,
  linkedInSearchConformanceExaCredentialRef,
  linkedInSearchConformanceIntegration,
  linkedInSearchEmailLookupCase,
  linkedInSearchEnrichLayerUnauthorizedCase,
  linkedInSearchExaUnauthorizedCase,
  linkedInSearchNumResultsLimitCase,
  linkedInSearchPeopleResultsCase,
  linkedInSearchProfileCase,
  linkedInSearchProfileNotFoundCase,
  type LinkedInSearchConformanceCase,
  type LinkedInSearchConformanceError,
  type LinkedInSearchConformanceRequirements,
  type LinkedInSearchConformanceSeedKey
} from './cases.ts'

export { linkedInSearchConformanceFixtureSeeds } from './seeds.ts'

export {
  linkedInSearchEmailLookupFixture,
  linkedInSearchEnrichLayerUnauthorizedFixture,
  linkedInSearchExaUnauthorizedFixture,
  linkedInSearchNumResultsLimitFixture,
  linkedInSearchPeopleResultsFixture,
  linkedInSearchProfileFixture,
  linkedInSearchProfileNotFoundFixture
}

/** Every LinkedIn search wire fixture, in case order, for replaying the whole suite at once. */
export const linkedInSearchConformanceFixtures: ReadonlyArray<WireFixture> = [
  linkedInSearchPeopleResultsFixture,
  linkedInSearchNumResultsLimitFixture,
  linkedInSearchProfileFixture,
  linkedInSearchEmailLookupFixture,
  linkedInSearchExaUnauthorizedFixture,
  linkedInSearchEnrichLayerUnauthorizedFixture,
  linkedInSearchProfileNotFoundFixture
]
