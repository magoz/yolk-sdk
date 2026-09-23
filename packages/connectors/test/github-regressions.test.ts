import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import {
  BearerTokenCredential,
  ConnectorError,
  ConnectorHttpClient,
  CredentialResolver
} from '@yolk-sdk/connectors'
import { githubCreateReactionAction, githubRemoveLabelAction } from '../src/github/comments.ts'
import { githubListIssueTimelineAction } from '../src/github/issues.ts'
import {
  githubCreatePullRequestReviewAction,
  githubCreatePullRequestReviewCommentAction,
  githubGetPullRequestChecksAction
} from '../src/github/pulls.ts'
import { githubCompareCommitsAction, githubSearchCodeAction } from '../src/github/repository.ts'
import { githubRepoRequest, resolveGithubContext } from '../src/github/shared.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue
} from './github-fake.ts'

const headSha = 'b'.repeat(40)

const wirePull = {
  number: 7,
  title: 'Add widgets',
  state: 'open',
  draft: false,
  user: { login: 'octocat', type: 'User' },
  head: { ref: 'feature', sha: headSha },
  base: { ref: 'main' },
  html_url: 'https://github.com/acme/widgets/pull/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z'
}

const nextLink = { link: '<https://api.github.com/x?page=2>; rel="next"' }

describe('GitHub review regressions', () => {
  it.effect('review comment head lookup failure returns its own failure without a POST', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          status: 429,
          headers: { 'retry-after': '12' },
          body: { message: 'API rate limit exceeded' }
        }
      ])

      const result = yield* githubCreatePullRequestReviewCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, body: 'nit', path: 'src/a.ts', line: 3 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.method).toBe('GET')
      expect(failureOf(result)).toMatchObject({
        code: 'github_rate_limited',
        status: 429,
        retryAfterMs: 12_000
      })
    })
  )

  it.effect('review comment defaults commit_id to the looked-up head sha', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wirePull },
        {
          status: 201,
          body: {
            id: 5,
            user: { login: 'octocat' },
            body: 'nit',
            path: 'src/a.ts',
            line: 3,
            commit_id: headSha,
            html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z'
          }
        }
      ])

      yield* githubCreatePullRequestReviewCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { pullNumber: 7, body: 'nit', path: 'src/a.ts', line: 3 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[1]?.method).toBe('POST')
      expect(host.requests[1]?.json).toMatchObject({ commit_id: headSha, path: 'src/a.ts' })
    })
  )

  it.effect('rejects dot-only label names before any request', () =>
    Effect.gen(function* () {
      for (const label of ['.', '..', '...']) {
        const host = makeGithubHost()

        const exit = yield* githubRemoveLabelAction
          .execute({ integration: githubIntegration(), input: { issueNumber: 7, label } })
          .pipe(Effect.provide(host.layer), Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('rejects reactions without a target before resolving credentials', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const error = yield* githubCreateReactionAction
        .executeTyped({ integration: githubIntegration(), input: { content: 'heart' } })
        .pipe(Effect.provide(host.layer), Effect.flip)

      expect(error).toBeInstanceOf(ConnectorError)
      expect(host.resolvedSlots).toEqual([])
    })
  )

  it.effect('rejects cross-fork compare refs', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const exit = yield* githubCompareCommitsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { base: 'main', head: 'someone:feature' }
        })
        .pipe(Effect.provide(host.layer), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('flags truncated code search fragments', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            total_count: 2,
            incomplete_results: false,
            items: [
              {
                name: 'a.ts',
                path: 'a.ts',
                sha: 's1',
                html_url: 'https://github.com/acme/widgets/blob/main/a.ts',
                repository: { full_name: 'acme/widgets' },
                text_matches: [{ fragment: 'short' }]
              },
              {
                name: 'b.ts',
                path: 'b.ts',
                sha: 's2',
                html_url: 'https://github.com/acme/widgets/blob/main/b.ts',
                repository: { full_name: 'acme/widgets' },
                text_matches: [
                  { fragment: 'x' },
                  { fragment: 'y' },
                  { fragment: 'z' },
                  { fragment: 'w' }
                ]
              }
            ]
          }
        }
      ])

      const value = successValue(
        yield* githubSearchCodeAction
          .executeTyped({ integration: githubIntegration(), input: { query: 'widget' } })
          .pipe(Effect.provide(host.layer))
      )

      expect(value.items.map(item => item.fragmentsTruncated)).toEqual([false, true])
      expect(value.items[1]?.fragments).toEqual(['x', 'y', 'z'])
    })
  )

  it.effect('paginates combined commit statuses alongside check runs', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wirePull },
        { body: { total_count: 0, check_runs: [] } },
        {
          headers: nextLink,
          body: {
            state: 'pending',
            total_count: 150,
            statuses: [{ context: 'ci', state: 'pending' }]
          }
        }
      ])

      const value = successValue(
        yield* githubGetPullRequestChecksAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, perPage: 100, page: 1 }
          })
          .pipe(Effect.provide(host.layer))
      )

      expect(host.requests[2]?.parsedUrl.pathname).toBe(
        `/repos/acme/widgets/commits/${headSha}/status`
      )
      expect(host.requests[2]?.parsedUrl.searchParams.get('per_page')).toBe('100')
      expect(value.combinedStatusHasNextPage).toBe(true)
      expect(value.checkRunsHasNextPage).toBe(false)
    })
  )

  it.effect('truncates created review bodies', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            id: 1,
            state: 'COMMENTED',
            user: { login: 'octocat' },
            body: 'r'.repeat(25_000),
            html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-1'
          }
        }
      ])

      const value = successValue(
        yield* githubCreatePullRequestReviewAction
          .executeTyped({
            integration: githubIntegration(),
            input: { pullNumber: 7, event: 'COMMENT', body: 'looks good' }
          })
          .pipe(Effect.provide(host.layer))
      )

      expect(value.bodyTruncated).toBe(true)
      expect(value.body?.length).toBe(20_000)
    })
  )

  it.effect('separates lock reasons and truncates commit messages in timelines', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              event: 'locked',
              actor: { login: 'octocat' },
              created_at: '2026-01-01T00:00:00Z',
              lock_reason: 'spam'
            },
            { event: 'committed', sha: 'abc', message: 'm'.repeat(3_000) }
          ]
        }
      ])

      const value = successValue(
        yield* githubListIssueTimelineAction
          .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
          .pipe(Effect.provide(host.layer))
      )

      expect(value.events[0]).toMatchObject({ event: 'locked', lockReason: 'spam' })
      expect(value.events[0]?.stateReason).toBeUndefined()
      expect(value.events[1]).toMatchObject({ event: 'committed', messageTruncated: true })
      expect(value.events[1]?.message?.length).toBe(2_000)
    })
  )

  it.effect('redacts tokens echoed in provider error bodies', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { status: 422, body: { message: `bad token ${githubTestToken} used` } }
      ])

      const result = yield* githubRemoveLabelAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7, label: 'bug' } })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.message).toContain('[redacted]')
      expect(JSON.stringify(failure)).not.toContain(githubTestToken)
    })
  )

  it.effect('redacts JSON-escaped token echoes in messages and diagnostic fields', () =>
    Effect.gen(function* () {
      const escaped = `\\u${githubTestToken.charCodeAt(0).toString(16).padStart(4, '0')}${githubTestToken.slice(1)}`

      const host = makeGithubHost([
        {
          status: 422,
          body: `{"message":"bad ${escaped}","errors":[{"resource":"Issue","field":"${escaped}","code":"invalid"}],"documentation_url":"https://docs.github.com/${escaped}","${escaped}":1e400}`
        }
      ])

      const result = yield* githubRemoveLabelAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7, label: 'bug' } })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_validation')
      expect(failure.message).toContain('[redacted]')
      expect(JSON.stringify(failure)).not.toContain(githubTestToken)
      expect(JSON.stringify(failure.underlying)).toContain('[redacted]')
    })
  )

  it.effect('redacts literal echoes in non-JSON error bodies', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 500, body: `upstream said ${githubTestToken}` }])

      const failure = failureOf(
        yield* githubRemoveLabelAction
          .executeTyped({
            integration: githubIntegration(),
            input: { issueNumber: 7, label: 'bug' }
          })
          .pipe(Effect.provide(host.layer))
      )

      expect(failure.code).toBe('github_request_failed')
      expect(JSON.stringify(failure)).not.toContain(githubTestToken)
    })
  )

  it.effect('strips host transport diagnostics that could contain the token', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        Layer.succeed(CredentialResolver, {
          resolve: () => Effect.succeed(BearerTokenCredential.make({ token: githubTestToken }))
        }),
        Layer.succeed(ConnectorHttpClient, {
          request: request =>
            Effect.fail(
              new ConnectorError({
                cause: 'transport_failed',
                message: `socket closed for ${JSON.stringify(request.headers)}`,
                underlying: request
              })
            )
        })
      )

      const error = yield* Effect.gen(function* () {
        const context = yield* resolveGithubContext(githubIntegration())

        return yield* githubRepoRequest(context, { method: 'GET', path: '/issues' })
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({ cause: 'transport_failed', connectorId: 'github' })
      expect(JSON.stringify(error)).not.toContain(githubTestToken)
      expect(error.message).not.toContain(githubTestToken)
    })
  )
})
