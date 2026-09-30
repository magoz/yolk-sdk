/**
 * GitHub conformance cases for `@yolk-sdk/conformance/runner` and the wire fixtures that back
 * their replay (`@yolk-sdk/conformance/replay`).
 *
 * Every case runs the real connector actions over the connector ports. The current fixtures are
 * synthetic placeholders (`evidence: 'unverified'`) shaped like the GitHub REST API.
 * `pnpm conformance:github --live --owner-approved --account <label> --record` stages verified
 * recordings from a practice repository in a gitignored directory; a person scrubs them and
 * promotes them here, updating the tests together with them (fixture ids, `evidence`, and
 * `account` change).
 *
 * @experimental
 */
import type { WireFixture } from '@yolk-sdk/conformance/fixture'
import { githubCommentLifecycleFixture } from './comment-lifecycle.ts'
import { githubFileContentsFixture } from './file-contents.ts'
import { githubIssueLabelsFixture } from './issue-labels.ts'
import { githubIssueLifecycleFixture } from './issue-lifecycle.ts'
import { githubLabelsPagingFixture } from './labels-paging.ts'
import { githubNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { githubValidationEnvelopeFixture } from './validation-envelope.ts'

export {
  GithubConformanceActionFailed,
  GithubConformanceCleanupRefused,
  GithubConformanceConfig,
  GithubConformanceRestoreFailed,
  GithubConformanceSeeds,
  findGithubConformanceLeftovers,
  githubCommentLifecycleCase,
  githubConformanceCases,
  githubConformanceCredentialRef,
  githubConformanceIntegration,
  githubConformanceMarker,
  githubConformanceRunPrefix,
  githubFileContentsCase,
  githubIssueLabelsCase,
  githubIssueLifecycleCase,
  githubLabelsPagingCase,
  githubNotFoundEnvelopeCase,
  githubValidationEnvelopeCase,
  type GithubConformanceCase,
  type GithubConformanceError,
  type GithubConformanceRequirements,
  type GithubConformanceSeedKey
} from './cases.ts'

export { githubConformanceFixtureSeeds } from './seeds.ts'

export { githubConformanceLongSearchQuery } from './synthetic.ts'

export {
  githubCommentLifecycleFixture,
  githubFileContentsFixture,
  githubIssueLabelsFixture,
  githubIssueLifecycleFixture,
  githubLabelsPagingFixture,
  githubNotFoundEnvelopeFixture,
  githubValidationEnvelopeFixture
}

/** Every GitHub wire fixture, in case order, for replaying the whole suite at once. */
export const githubConformanceFixtures: ReadonlyArray<WireFixture> = [
  githubLabelsPagingFixture,
  githubNotFoundEnvelopeFixture,
  githubValidationEnvelopeFixture,
  githubFileContentsFixture,
  githubCommentLifecycleFixture,
  githubIssueLabelsFixture,
  githubIssueLifecycleFixture
]
