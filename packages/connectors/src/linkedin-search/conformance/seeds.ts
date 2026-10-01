import type { LinkedInSearchConformanceSeeds } from './cases.ts'

/**
 * Seed data used by the committed LinkedIn search fixtures (synthetic until a replaced recording is
 * promoted). Replaying the fixtures needs these exact seeds in `LinkedInSearchConformanceConfig`.
 * `pnpm conformance:linkedin-search --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const linkedInSearchConformanceFixtureSeeds: LinkedInSearchConformanceSeeds = {
  searchQuery: 'synthetic conformance engineer',
  profileUrl: 'https://linkedin.example.com/in/synthetic-person-01',
  absentProfileUrl: 'https://linkedin.example.com/in/synthetic-absent-person-00'
}
