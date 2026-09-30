import type { NotionConformanceSeeds } from './cases.ts'

/**
 * Seed ids used by the committed Notion fixtures (synthetic until a scrubbed recording is
 * promoted). Replaying the fixtures needs these exact seeds in `NotionConformanceConfig`.
 * `pnpm conformance:notion --live --owner-approved --account <label> --record` stages an
 * updated copy for manual promotion together with the fixtures it records.
 */
export const notionConformanceFixtureSeeds: NotionConformanceSeeds = {
  searchQuery: 'yolk-search-probe',
  titlePageId: '1f000000-0000-4000-8000-000000000001',
  titlePageTitle: 'Synthetic Title Page',
  blocksPageId: '1f000000-0000-4000-8000-000000000002',
  propertyPageId: '1f000000-0000-4000-8000-000000000003',
  propertyId: 'Syn%3Ap',
  databaseId: '1f000000-0000-4000-8000-000000000004',
  parentPageId: '1f000000-0000-4000-8000-000000000005'
}
