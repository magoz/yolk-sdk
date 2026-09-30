/**
 * Notion conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions over the connector ports; the pinned-version case
 * observes the outgoing `Notion-Version` at the `ConnectorHttpClient` port. The current fixtures are
 * synthetic placeholders (`evidence: 'unverified'`) shaped like the Notion wire at API version
 * 2025-09-03. `pnpm conformance:notion --live --owner-approved --account <label> --record` stages
 * verified recordings from a practice workspace in a gitignored directory; a person scrubs them
 * and promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { notionArchiveInTrashFixture } from './archive-in-trash.ts'
import { notionBlockChildrenPagingFixture } from './block-children-paging.ts'
import { notionDataSourceSplitFixture } from './data-source-split.ts'
import { notionErrorEnvelopeFixture } from './error-envelope.ts'
import { notionPropertyItemPagingFixture } from './property-item-paging.ts'
import { notionSearchPagingFixture } from './search-paging.ts'
import { notionTitlePlainTextFixture } from './title-plain-text.ts'
import { notionPinnedVersionFixture } from './pinned-version.ts'

export {
  NotionConformanceActionFailed,
  NotionConformanceConfig,
  NotionConformanceRestoreFailed,
  NotionConformanceSeeds,
  notionArchiveInTrashCase,
  notionBlockChildrenPagingCase,
  notionConformanceCases,
  notionConformanceCredentialRef,
  notionConformanceIntegration,
  notionConformanceMarker,
  notionDataSourceSplitCase,
  notionErrorEnvelopeCase,
  notionPropertyItemPagingCase,
  notionSearchPagingCase,
  notionTitlePlainTextCase,
  notionPinnedVersionCase,
  findNotionConformanceLeftovers,
  type NotionConformanceCase,
  type NotionConformanceError,
  type NotionConformanceRequirements,
  type NotionConformanceSeedKey
} from './cases.ts'

export { notionConformanceFixtureSeeds } from './seeds.ts'

export {
  notionArchiveInTrashFixture,
  notionBlockChildrenPagingFixture,
  notionDataSourceSplitFixture,
  notionErrorEnvelopeFixture,
  notionPropertyItemPagingFixture,
  notionSearchPagingFixture,
  notionTitlePlainTextFixture,
  notionPinnedVersionFixture
}

/** Every Notion wire fixture, in case order, for replaying the whole suite at once. */
export const notionConformanceFixtures: ReadonlyArray<WireFixture> = [
  notionSearchPagingFixture,
  notionPinnedVersionFixture,
  notionErrorEnvelopeFixture,
  notionTitlePlainTextFixture,
  notionBlockChildrenPagingFixture,
  notionPropertyItemPagingFixture,
  notionDataSourceSplitFixture,
  notionArchiveInTrashFixture
]
