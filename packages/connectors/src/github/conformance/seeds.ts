import type { GithubConformanceSeeds } from './cases.ts'

/**
 * Seed values used by the committed GitHub fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `GithubConformanceConfig`.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const githubConformanceFixtureSeeds: GithubConformanceSeeds = {
  owner: 'yolk-synthetic',
  repo: 'conformance-practice',
  workIssueNumber: '1',
  labelName: 'synthetic-conformance',
  filePath: 'docs/synthetic-notes.txt',
  runId: 'run-synthetic'
}
