/**
 * Notion conformance runner for a practice Notion workspace (`pnpm conformance:notion`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Notion API with a
 * `FetchHttpClient`, through the real connector actions. Refused whenever `CI` is non-empty and
 * without `--owner-approved`. Requires `NOTION_API_TOKEN` (environment only, never a flag; an
 * internal integration token of the practice workspace with read content and insert/update content
 * capabilities, shared with every seeded page and database) and the seed ids of every case that
 * will run (flags or environment, see the usage text). Read cases always run; `--allow-writes
 * reversible` adds the write-reversible case, which creates its own page under `--parent-page` and
 * moves it to the trash again. There are no write-irreversible Notion cases.
 *
 * `--record` (with `--live`) stages verified recordings all or nothing in a new run directory
 * under the gitignored `.conformance-recordings/notion/`; the recorder keeps `notion-version` so
 * recordings show the pinned API version. Promotion is manual: scrub the staged files of
 * practice-workspace data (titles, text, names, ids, URLs), copy them into
 * `packages/connectors/src/notion/conformance/`, run `pnpm format:fix`, and update
 * `packages/connectors/test/notion-conformance.test.ts` and
 * `scripts/test/run-notion-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/http'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  NotionConformanceConfig,
  NotionConformanceSeeds,
  notionConformanceCases,
  notionConformanceFixtureSeeds,
  findNotionConformanceLeftovers,
  type NotionConformanceError,
  type NotionConformanceRequirements,
  type NotionConformanceSeedKey
} from '../packages/connectors/src/notion/conformance/index.ts'
import { notionApiBaseUrl } from '../packages/connectors/src/notion/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed id comes from. Flags win over environment variables. */
export const notionSeedSources: ReadonlyArray<SeedSource<NotionConformanceSeedKey>> = [
  {
    key: 'searchQuery',
    flag: '--search-query',
    env: 'NOTION_CONFORMANCE_SEARCH_QUERY',
    description: 'query matching at least two pages'
  },
  {
    key: 'titlePageId',
    flag: '--title-page',
    env: 'NOTION_CONFORMANCE_TITLE_PAGE',
    description: 'page with a plain-text title'
  },
  {
    key: 'titlePageTitle',
    flag: '--title-page-title',
    env: 'NOTION_CONFORMANCE_TITLE_PAGE_TITLE',
    description: "that page's exact plain-text title"
  },
  {
    key: 'blocksPageId',
    flag: '--blocks-page',
    env: 'NOTION_CONFORMANCE_BLOCKS_PAGE',
    description: 'page with more than two child blocks'
  },
  {
    key: 'propertyPageId',
    flag: '--property-page',
    env: 'NOTION_CONFORMANCE_PROPERTY_PAGE',
    description: 'page with a paginated property of more than two items'
  },
  {
    key: 'propertyId',
    flag: '--property-id',
    env: 'NOTION_CONFORMANCE_PROPERTY_ID',
    description: 'that property id as the page returns it; must contain a %XX escape'
  },
  {
    key: 'databaseId',
    flag: '--database',
    env: 'NOTION_CONFORMANCE_DATABASE',
    description: 'database whose first data source holds a page'
  },
  {
    key: 'parentPageId',
    flag: '--parent-page',
    env: 'NOTION_CONFORMANCE_PARENT_PAGE',
    description: 'page the write case creates its own child page under'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const notionCaseSpecs: ReadonlyArray<CaseSpec<NotionConformanceSeedKey>> = [
  {
    caseId: 'notion.search.cursor-paging',
    seeds: ['searchQuery'],
    optionalSeeds: [],
    fileName: 'search-paging.ts',
    exportName: 'notionSearchPagingFixture',
    doc: 'A `page_size: 1` search for the seeded query, then the pages its `next_cursor` leads to.'
  },
  {
    caseId: 'notion.api.pinned-version-accepted',
    seeds: [],
    optionalSeeds: [],
    fileName: 'pinned-version.ts',
    exportName: 'notionPinnedVersionFixture',
    doc: '`notion.get_bot_user`: one GET /v1/users/me carrying the pinned `Notion-Version`.'
  },
  {
    caseId: 'notion.errors.error-envelope',
    seeds: [],
    optionalSeeds: [],
    fileName: 'error-envelope.ts',
    exportName: 'notionErrorEnvelopeFixture',
    doc: '`notion.get_page` of a missing page and of a malformed id.'
  },
  {
    caseId: 'notion.pages.title-plain-text',
    seeds: ['titlePageId', 'titlePageTitle'],
    optionalSeeds: [],
    fileName: 'title-plain-text.ts',
    exportName: 'notionTitlePlainTextFixture',
    doc: 'The seeded title page.'
  },
  {
    caseId: 'notion.blocks.children-cursor-paging',
    seeds: ['blocksPageId'],
    optionalSeeds: [],
    fileName: 'block-children-paging.ts',
    exportName: 'notionBlockChildrenPagingFixture',
    doc: 'A `page_size=2` page of child blocks, then the pages its `next_cursor` leads to.'
  },
  {
    caseId: 'notion.pages.property-item-paging',
    seeds: ['propertyPageId', 'propertyId'],
    optionalSeeds: [],
    fileName: 'property-item-paging.ts',
    exportName: 'notionPropertyItemPagingFixture',
    doc: 'The seeded page, a `page_size=2` page of property items requested with the id percent-encoded again, then the pages its `next_cursor` leads to.'
  },
  {
    caseId: 'notion.data-sources.database-split',
    seeds: ['databaseId'],
    optionalSeeds: [],
    fileName: 'data-source-split.ts',
    exportName: 'notionDataSourceSplitFixture',
    doc: 'The seeded database, its first data source, and a one-row data source query.'
  },
  {
    caseId: 'notion.pages.archive-in-trash',
    seeds: ['parentPageId'],
    optionalSeeds: [],
    fileName: 'archive-in-trash.ts',
    exportName: 'notionArchiveInTrashFixture',
    doc: 'The case-owned page create, the archive PATCH, and the read of the trashed page.'
  }
]

/** The live credential: the practice workspace's integration token. */
export const liveCredential = (accessToken: string) => ApiKeyCredential.make({ key: accessToken })

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: NotionConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(NotionConformanceConfig, seeds)
  )

export const notionRunner = {
  provider: 'notion',
  displayName: 'Notion',
  practiceTarget: 'a practice Notion workspace',
  tokenEnv: 'NOTION_API_TOKEN',
  tokenScopes:
    'an internal integration token of the practice workspace with read and insert/update content capabilities, shared with every seeded page and database',
  endpoint: notionApiBaseUrl,
  writeNote: 'create their own page under --parent-page and move it to the trash again',
  cases: notionConformanceCases,
  seedSources: notionSeedSources,
  caseSpecs: notionCaseSpecs,
  fixtureSeeds: notionConformanceFixtureSeeds,
  seedNoun: 'ids',
  seedsTypeName: 'NotionConformanceSeeds',
  seedsExportName: 'notionConformanceFixtureSeeds',
  configName: 'NotionConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(NotionConformanceSeeds),
  invalidSeedsMessage: 'Seed ids and the search query must be non-empty trimmed values',
  casePorts,
  // Recordings keep the pinned API version the connector sends.
  recordedRequestHeaders: ['notion-version'],
  // Read-only and best effort (search indexing lags): untrashed `yolk-conformance page` pages.
  leftovers: findNotionConformanceLeftovers,
  leftoverAdvice: 'move it to the trash by hand after checking that no run is still using it',
  nameKeys: /^(?:name|workspace_name|query|url|avatar_url)$/,
  textKeys: /^(?:plain_text|content)$/
} satisfies ConnectorConformanceRunner<
  NotionConformanceSeedKey,
  NotionConformanceSeeds,
  NotionConformanceError,
  NotionConformanceRequirements
>

/** Gitignored root of staged Notion recordings. */
export const recordingsRoot = recordingsRootFor(notionRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(notionRunner)
}
