import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import type * as Schema from 'effect/Schema'
import { ConnectorError } from '@yolk-sdk/connectors'
import {
  githubCreatePullRequestAction,
  githubCreatePullRequestReviewAction,
  githubCreatePullRequestReviewCommentAction,
  githubGetPullRequestAction,
  githubGetPullRequestChecksAction,
  githubListPullRequestCommitsAction,
  githubListPullRequestFilesAction,
  githubListPullRequestReviewCommentsAction,
  githubListPullRequestReviewsAction,
  githubListPullRequestsAction,
  githubMergePullRequestAction,
  githubRequestReviewersAction,
  githubUpdatePullRequestAction
} from '../src/github/pulls.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue
} from './github-fake.ts'

const headSha = 'a'.repeat(40)

const wirePullRequest = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  number: 7,
  title: 'Add widgets',
  state: 'open',
  draft: false,
  body: 'Implements widgets',
  user: { login: 'octocat', type: 'User' },
  head: { ref: 'feature', sha: headSha, repo: { full_name: 'acme/widgets' } },
  base: { ref: 'main' },
  labels: [{ name: 'enhancement' }],
  assignees: [{ login: 'hubot' }],
  requested_reviewers: [{ login: 'reviewer' }],
  requested_teams: [{ slug: 'core' }],
  html_url: 'https://github.com/acme/widgets/pull/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  closed_at: null,
  merged_at: null,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  merged_by: null,
  commits: 2,
  additions: 10,
  deletions: 3,
  changed_files: 1,
  ...overrides
})

const nextLink = { link: '<https://api.github.com/x?page=2>; rel="next"' }

const runValidation = (
  execute: Effect.Effect<unknown, unknown, never>,
  requests: ReadonlyArray<unknown>
) =>
  Effect.gen(function* () {
    const exit = yield* execute.pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(requests).toHaveLength(0)

    const failure = yield* Effect.flip(execute)

    expect(failure).toBeInstanceOf(ConnectorError)
  })

describe('GitHub pull requests', () => {
  it.effect('lists pull requests with head prefixing and pagination', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: [wirePullRequest()], headers: nextLink }])

      const result = yield* githubListPullRequestsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { state: 'open', head: 'feature' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls')
      expect(request?.parsedUrl.searchParams.get('head')).toBe('acme:feature')
      expect(request?.parsedUrl.searchParams.get('state')).toBe('open')

      const output = successValue(result)

      expect(output.hasNextPage).toBe(true)
      expect(output.pullRequests).toHaveLength(1)
      expect(output.pullRequests[0]).toMatchObject({
        number: 7,
        title: 'Add widgets',
        draft: false,
        author: 'octocat',
        headRef: 'feature',
        headSha,
        baseRef: 'main',
        labels: ['enhancement'],
        assignees: ['hubot'],
        requestedReviewers: ['reviewer', 'core']
      })
    })
  )

  it.effect('keeps head refs that already have an owner prefix', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: [wirePullRequest()] }])

      const result = yield* githubListPullRequestsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { head: 'fork:feature', sort: 'created', direction: 'desc', perPage: 5, page: 2 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.parsedUrl.searchParams.get('head')).toBe('fork:feature')
      expect(request?.parsedUrl.searchParams.get('sort')).toBe('created')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('5')
      expect(request?.parsedUrl.searchParams.get('page')).toBe('2')
      expect(successValue(result).hasNextPage).toBe(false)
    })
  )

  it.effect('maps list failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubListPullRequestsAction
        .executeTyped({ integration: githubIntegration(), input: {} })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('gets a pull request with full normalization', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wirePullRequest() }])

      const result = yield* githubGetPullRequestAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7')

      expect(successValue(result)).toMatchObject({
        number: 7,
        body: 'Implements widgets',
        bodyTruncated: false,
        merged: false,
        mergeable: true,
        mergeableState: 'clean',
        mergedBy: null,
        headRepository: 'acme/widgets',
        commits: 2,
        additions: 10,
        deletions: 3,
        changedFiles: 1
      })
    })
  )

  it.effect('truncates long pull request bodies and nulls missing counts', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: wirePullRequest({
            body: 'x'.repeat(25_000),
            commits: null,
            additions: null,
            deletions: null,
            changed_files: null
          })
        }
      ])

      const result = yield* githubGetPullRequestAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const output = successValue(result)

      expect(output.bodyTruncated).toBe(true)
      expect(output.body?.length).toBe(20_000)
      expect(output.commits).toBe(null)
      expect(output.additions).toBe(null)
      expect(output.deletions).toBe(null)
      expect(output.changedFiles).toBe(null)
    })
  )

  it.effect('lists pull request files with patch truncation', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              filename: 'src/a.ts',
              status: 'modified',
              additions: 5,
              deletions: 1,
              changes: 6,
              patch: 'y'.repeat(10_000)
            },
            {
              filename: 'src/old.ts',
              previous_filename: 'src/new.ts',
              status: 'renamed',
              additions: 0,
              deletions: 0,
              changes: 0
            }
          ],
          headers: nextLink
        }
      ])

      const result = yield* githubListPullRequestFilesAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7, perPage: 10 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/files')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('10')

      const output = successValue(result)

      expect(output.hasNextPage).toBe(true)
      expect(output.files[0]).toMatchObject({ filename: 'src/a.ts', patchTruncated: true })
      expect(output.files[0]?.patch?.length).toBe(8_000)
      expect(output.files[1]).toMatchObject({
        filename: 'src/old.ts',
        previousFilename: 'src/new.ts',
        patch: null,
        patchTruncated: false
      })
    })
  )

  it.effect('maps file list validation failures', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 422, body: { message: 'Validation Failed' } }])

      const result = yield* githubListPullRequestFilesAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('lists pull request commits with message truncation', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              sha: 'b'.repeat(40),
              commit: {
                message: `Short message`,
                author: { name: 'Mona', date: '2026-01-01T00:00:00Z' }
              },
              author: { login: 'mona' }
            },
            {
              sha: 'c'.repeat(40),
              commit: { message: 'z'.repeat(5_000), author: null },
              author: null
            }
          ]
        }
      ])

      const result = yield* githubListPullRequestCommitsAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/commits')

      const output = successValue(result)

      expect(output.commits[0]).toMatchObject({
        message: 'Short message',
        messageTruncated: false,
        author: 'mona',
        authorName: 'Mona'
      })
      expect(output.commits[1]).toMatchObject({
        messageTruncated: true,
        author: null,
        authorName: null,
        date: null
      })
      expect(output.commits[1]?.message.length).toBe(2_000)
    })
  )

  it.effect('gets pull request checks across three requests', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wirePullRequest() },
        {
          body: {
            total_count: 1,
            check_runs: [
              {
                id: 11,
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/acme/widgets/runs/11',
                started_at: '2026-01-01T00:00:00Z',
                completed_at: '2026-01-01T01:00:00Z',
                app: { slug: 'github-actions' }
              }
            ]
          }
        },
        {
          body: {
            state: 'success',
            total_count: 1,
            statuses: [
              {
                context: 'ci',
                state: 'success',
                description: 'Build passed',
                target_url: 'https://ci.example.com/1'
              }
            ]
          }
        }
      ])

      const result = yield* githubGetPullRequestChecksAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7, perPage: 5 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(3)
      expect(host.requests[1]?.parsedUrl.pathname).toBe(
        `/repos/acme/widgets/commits/${headSha}/check-runs`
      )
      expect(host.requests[1]?.parsedUrl.searchParams.get('per_page')).toBe('5')
      expect(host.requests[2]?.parsedUrl.pathname).toBe(
        `/repos/acme/widgets/commits/${headSha}/status`
      )

      expect(successValue(result)).toMatchObject({
        headSha,
        checkRunsTotal: 1,
        checkRunsHasNextPage: false,
        checkRuns: [
          {
            id: 11,
            name: 'build',
            conclusion: 'success',
            url: 'https://github.com/acme/widgets/runs/11',
            app: 'github-actions'
          }
        ],
        combinedStatus: { state: 'success', total: 1 }
      })
    })
  )

  it.effect('propagates check run failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wirePullRequest() },
        { status: 404, body: { message: 'Not Found' } }
      ])

      const result = yield* githubGetPullRequestChecksAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(2)
      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('lists pull request reviews', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              id: 21,
              user: { login: 'reviewer' },
              state: 'APPROVED',
              body: 'Looks good',
              commit_id: headSha,
              submitted_at: '2026-01-03T00:00:00Z',
              html_url: 'https://github.com/acme/widgets/pull/7#review-21'
            }
          ],
          headers: nextLink
        }
      ])

      const result = yield* githubListPullRequestReviewsAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/reviews')

      const output = successValue(result)

      expect(output.hasNextPage).toBe(true)
      expect(output.reviews[0]).toMatchObject({
        id: 21,
        author: 'reviewer',
        state: 'APPROVED',
        body: 'Looks good',
        bodyTruncated: false
      })
    })
  )

  it.effect('lists pull request review comments with truncation', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              id: 31,
              user: { login: 'reviewer' },
              body: 'w'.repeat(6_000),
              path: 'src/a.ts',
              line: 12,
              start_line: null,
              side: 'RIGHT',
              in_reply_to_id: null,
              commit_id: headSha,
              html_url: 'https://github.com/acme/widgets/pull/7#discussion-31',
              created_at: '2026-01-03T00:00:00Z',
              updated_at: '2026-01-03T01:00:00Z'
            }
          ]
        }
      ])

      const result = yield* githubListPullRequestReviewCommentsAction
        .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/comments')

      const output = successValue(result)

      expect(output.comments[0]).toMatchObject({
        id: 31,
        path: 'src/a.ts',
        line: 12,
        side: 'RIGHT',
        bodyTruncated: true
      })
      expect(output.comments[0]?.body.length).toBe(4_000)
    })
  )

  it.effect('creates a pull request', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wirePullRequest() }])

      const result = yield* githubCreatePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { title: 'Add widgets', head: 'feature', base: 'main', draft: true }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls')
      expect(request?.json).toEqual({
        title: 'Add widgets',
        head: 'feature',
        base: 'main',
        draft: true
      })
      expect(successValue(result).number).toBe(7)
    })
  )

  it.effect('maps create pull request validation failures', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 422, body: { message: 'Validation Failed' } }])

      const result = yield* githubCreatePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { title: 'Add widgets', head: 'feature', base: 'main' }
        })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('updates a pull request and rejects empty updates before HTTP', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wirePullRequest({ title: 'Renamed' }) }])

      const result = yield* githubUpdatePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, title: 'Renamed' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('PATCH')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7')
      expect(request?.json).toMatchObject({ title: 'Renamed' })
      expect(successValue(result).title).toBe('Renamed')

      const emptyHost = makeGithubHost([{ body: wirePullRequest() }])

      yield* runValidation(
        githubUpdatePullRequestAction
          .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
          .pipe(Effect.provide(emptyHost.layer)),
        emptyHost.requests
      )
    })
  )

  it.effect('requests reviewers and rejects empty reviewer sets before HTTP', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wirePullRequest(), status: 201 }])

      const result = yield* githubRequestReviewersAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, reviewers: ['reviewer'], teamReviewers: ['core'] }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/requested_reviewers')
      expect(request?.json).toEqual({ reviewers: ['reviewer'], team_reviewers: ['core'] })
      expect(successValue(result).requestedReviewers).toContain('reviewer')

      const emptyHost = makeGithubHost([{ body: wirePullRequest() }])

      yield* runValidation(
        githubRequestReviewersAction
          .executeTyped({ integration: githubIntegration(), input: { pullNumber: 7 } })
          .pipe(Effect.provide(emptyHost.layer)),
        emptyHost.requests
      )
    })
  )

  it.effect('creates a pull request review and requires bodies for COMMENT', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            id: 41,
            user: { login: 'reviewer' },
            state: 'CHANGES_REQUESTED',
            body: 'Please fix',
            commit_id: headSha,
            submitted_at: '2026-01-04T00:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/7#review-41'
          }
        }
      ])

      const result = yield* githubCreatePullRequestReviewAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            pullNumber: 7,
            event: 'REQUEST_CHANGES',
            body: 'Please fix',
            comments: [{ path: 'src/a.ts', body: 'Fix this', line: 3, side: 'RIGHT' }]
          }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/reviews')
      expect(request?.json).toMatchObject({
        event: 'REQUEST_CHANGES',
        body: 'Please fix',
        comments: [{ path: 'src/a.ts', body: 'Fix this', line: 3, side: 'RIGHT' }]
      })
      expect(successValue(result)).toMatchObject({ id: 41, state: 'CHANGES_REQUESTED' })

      const emptyHost = makeGithubHost([{ body: {} }])

      yield* runValidation(
        githubCreatePullRequestReviewAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, event: 'COMMENT' }
          })
          .pipe(Effect.provide(emptyHost.layer)),
        emptyHost.requests
      )
    })
  )

  it.effect('creates an inline review comment with the head sha lookup', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wirePullRequest() },
        {
          body: {
            id: 51,
            user: { login: 'reviewer' },
            body: 'Nit',
            path: 'src/a.ts',
            line: 4,
            start_line: null,
            side: 'RIGHT',
            in_reply_to_id: null,
            commit_id: headSha,
            html_url: 'https://github.com/acme/widgets/pull/7#discussion-51',
            created_at: '2026-01-04T00:00:00Z',
            updated_at: '2026-01-04T00:00:00Z'
          }
        }
      ])

      const result = yield* githubCreatePullRequestReviewCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, body: 'Nit', path: 'src/a.ts', line: 4, side: 'RIGHT' }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(2)
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7')

      const request = host.requests[1]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/comments')
      expect(request?.json).toMatchObject({
        body: 'Nit',
        commit_id: headSha,
        path: 'src/a.ts',
        line: 4,
        side: 'RIGHT'
      })
      expect(successValue(result)).toMatchObject({ id: 51, commitId: headSha })
    })
  )

  it.effect('replies to a review comment and rejects mixed fields before HTTP', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            id: 52,
            user: { login: 'octocat' },
            body: 'Done',
            path: 'src/a.ts',
            line: 4,
            start_line: null,
            side: 'RIGHT',
            in_reply_to_id: 51,
            commit_id: headSha,
            html_url: 'https://github.com/acme/widgets/pull/7#discussion-52',
            created_at: '2026-01-04T00:00:00Z',
            updated_at: '2026-01-04T00:00:00Z'
          }
        }
      ])

      const result = yield* githubCreatePullRequestReviewCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, body: 'Done', inReplyTo: 51 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/comments/51/replies')
      expect(request?.json).toEqual({ body: 'Done' })
      expect(successValue(result)).toMatchObject({ inReplyToId: 51 })

      const mixedHost = makeGithubHost([{ body: {} }])

      yield* runValidation(
        githubCreatePullRequestReviewCommentAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, body: 'Done', inReplyTo: 51, path: 'src/a.ts', line: 4 }
          })
          .pipe(Effect.provide(mixedHost.layer)),
        mixedHost.requests
      )

      const missingHost = makeGithubHost([{ body: {} }])

      yield* runValidation(
        githubCreatePullRequestReviewCommentAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, body: 'Done' }
          })
          .pipe(Effect.provide(missingHost.layer)),
        missingHost.requests
      )
    })
  )

  it.effect('merges a pull request and maps mergeability codes', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: { sha: 'd'.repeat(40), merged: true, message: 'Pull Request successfully merged' } }
      ])

      const result = yield* githubMergePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, expectedHeadSha: headSha, method: 'squash' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('PUT')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/pulls/7/merge')
      expect(request?.json).toEqual({ sha: headSha, merge_method: 'squash' })
      expect(successValue(result)).toMatchObject({ merged: true })

      const blockedHost = makeGithubHost([{ status: 405, body: { message: 'Not mergeable' } }])

      const blocked = yield* githubMergePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, expectedHeadSha: headSha, method: 'merge' }
        })
        .pipe(Effect.provide(blockedHost.layer))

      expect(failureOf(blocked).code).toBe('github_not_mergeable')
      expect(JSON.stringify(blocked)).not.toContain(githubTestToken)

      const conflictHost = makeGithubHost([{ status: 409, body: { message: 'Head moved' } }])

      const conflict = yield* githubMergePullRequestAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, expectedHeadSha: headSha, method: 'merge' }
        })
        .pipe(Effect.provide(conflictHost.layer))

      expect(failureOf(conflict).code).toBe('github_conflict')
    })
  )

  it.effect('rejects invalid merge shas before HTTP', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: {} }])

      yield* runValidation(
        githubMergePullRequestAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, expectedHeadSha: 'not-a-sha', method: 'merge' }
          })
          .pipe(Effect.provide(host.layer)),
        host.requests
      )
    })
  )
})
