/**
 * Dropbox conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions (or the host-only upload helpers) over the connector
 * ports. The current fixtures are synthetic placeholders (`evidence: 'unverified'`) shaped like the
 * Dropbox wire. `pnpm conformance:dropbox --live --owner-approved --account <label> --record`
 * stages verified recordings from a practice account in a gitignored directory; a person scrubs
 * them and promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { dropboxCopyMoveMetadataFixture } from './copy-move-metadata.ts'
import { dropboxCreateFolderConflictFixture } from './create-folder-conflict.ts'
import { dropboxDeleteThenNotFoundFixture } from './delete-then-not-found.ts'
import { dropboxListFolderPagingFixture } from './list-folder-paging.ts'
import { dropboxNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { dropboxPathLowerLookupFixture } from './path-lower-lookup.ts'
import { dropboxSearchContinueFixture } from './search-continue.ts'
import { dropboxUploadRevPreconditionFixture } from './upload-rev-precondition.ts'

export {
  DropboxConformanceActionFailed,
  DropboxConformanceConfig,
  DropboxConformanceRestoreFailed,
  DropboxConformanceSeeds,
  dropboxConformanceCases,
  dropboxConformanceCredentialRef,
  dropboxConformanceIntegration,
  dropboxConformanceMarker,
  dropboxCopyMoveMetadataCase,
  dropboxCreateFolderConflictCase,
  dropboxDeleteThenNotFoundCase,
  dropboxListFolderPagingCase,
  dropboxNotFoundEnvelopeCase,
  dropboxPathLowerLookupCase,
  dropboxSearchContinueCase,
  dropboxUploadRevPreconditionCase,
  type DropboxConformanceCase,
  type DropboxConformanceError,
  type DropboxConformanceRequirements,
  type DropboxConformanceSeedKey
} from './cases.ts'

export { dropboxConformanceFixtureSeeds } from './seeds.ts'

export {
  dropboxCopyMoveMetadataFixture,
  dropboxCreateFolderConflictFixture,
  dropboxDeleteThenNotFoundFixture,
  dropboxListFolderPagingFixture,
  dropboxNotFoundEnvelopeFixture,
  dropboxPathLowerLookupFixture,
  dropboxSearchContinueFixture,
  dropboxUploadRevPreconditionFixture
}

/** Every Dropbox wire fixture, in case order, for replaying the whole suite at once. */
export const dropboxConformanceFixtures: ReadonlyArray<WireFixture> = [
  dropboxListFolderPagingFixture,
  dropboxPathLowerLookupFixture,
  dropboxSearchContinueFixture,
  dropboxNotFoundEnvelopeFixture,
  dropboxCreateFolderConflictFixture,
  dropboxDeleteThenNotFoundFixture,
  dropboxCopyMoveMetadataFixture,
  dropboxUploadRevPreconditionFixture
]
