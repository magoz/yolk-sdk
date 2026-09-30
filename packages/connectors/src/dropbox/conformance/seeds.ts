import type { DropboxConformanceSeeds } from './cases.ts'

/**
 * Seed paths used by the committed Dropbox fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `DropboxConformanceConfig`.
 * `pnpm conformance:dropbox --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const dropboxConformanceFixtureSeeds: DropboxConformanceSeeds = {
  pagingFolderPath: '/Conformance/Paging',
  mixedCasePath: '/Conformance/Mixed Case Notes.txt',
  searchQuery: 'yolk-search-probe',
  workFolderPath: '/Conformance/Work',
  copySourcePath: '/Conformance/copy-source.txt',
  runId: 'run-synthetic'
}
