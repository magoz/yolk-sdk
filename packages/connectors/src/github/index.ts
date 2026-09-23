import { defineConnector } from '../connector.ts'
import { githubCommentActions } from './comments.ts'
import { githubIssueActions } from './issues.ts'
import { githubPullRequestActions } from './pulls.ts'
import { githubRepositoryActions } from './repository.ts'
import { githubConnectorId } from './shared.ts'
import { githubStructureActions } from './structure.ts'

export {
  githubApiBaseUrl,
  githubApiVersion,
  githubBodyMaxChars,
  githubConnectorId,
  githubFileContentMaxChars,
  GithubIssue,
  GithubIssueNumber,
  githubListBodyMaxChars,
  GithubMilestoneRef,
  GithubPage,
  githubPatchMaxChars,
  GithubPerPage,
  GithubTokenSlot,
  githubTokenSlotId,
  GithubUploadTokenSlot,
  githubUploadTokenSlotId,
  githubUploadsBaseUrl,
  isValidGithubOwner,
  isValidGithubRepo
} from './shared.ts'

export type { GithubFailureCode, GithubRepoRef } from './shared.ts'

export * from './issues.ts'

export * from './comments.ts'

export * from './structure.ts'

export * from './pulls.ts'

export * from './repository.ts'

/** Host-only helpers: never part of `GithubConnector.actions` or agent tool modules. */
export * from './app-token.ts'

export * from './attachments.ts'

export const githubActions = [
  ...githubIssueActions,
  ...githubCommentActions,
  ...githubStructureActions,
  ...githubPullRequestActions,
  ...githubRepositoryActions
]

/** Repo-scoped GitHub REST connector; `owner`/`repo` come from integration config only. */
export const GithubConnector = defineConnector({
  id: githubConnectorId,
  description: 'GitHub issues, pull requests, and repository context for one configured repo.',
  actions: githubActions
})
