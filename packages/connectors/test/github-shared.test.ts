import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { ConnectorHttpResponse, UsernamePasswordCredential } from '@yolk-sdk/connectors'
import {
  githubFailure,
  githubHasNextPage,
  githubHasScopeQualifier,
  githubRepoRequest,
  isValidGithubOwner,
  isValidGithubRepo,
  normalizeGithubIssue,
  resolveGithubContext,
  resolveGithubUploadToken,
  truncateGithubText
} from '../src/github/shared.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  wireIssue
} from './github-fake.ts'

const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ConnectorHttpResponse.make({ status, headers, body: JSON.stringify(body) })

describe('GitHub shared', () => {
  it('validates owner/repo syntax', () => {
    expect(isValidGithubOwner('acme-inc')).toBe(true)
    expect(isValidGithubOwner('-acme')).toBe(false)
    expect(isValidGithubOwner('ac--me')).toBe(false)
    expect(isValidGithubRepo('widgets.js')).toBe(true)
    expect(isValidGithubRepo('..')).toBe(false)
    expect(isValidGithubRepo('a/b')).toBe(false)
  })

  it('detects scope qualifiers in grouped, negated, and spaced forms', () => {
    for (const query of [
      'repo:other/x bug',
      'bug -repo:other/x',
      '(repo:other/x OR bug)',
      'bug OR org:evil',
      'USER:someone',
      'owner : evil'
    ]) {
      expect(githubHasScopeQualifier(query)).toBe(true)
    }

    for (const query of ['bug label:repo', 'is:open "crash in repo"', 'reporter:me']) {
      expect(githubHasScopeQualifier(query)).toBe(false)
    }
  })

  it('parses Link rel=next', () => {
    expect(
      githubHasNextPage({
        Link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'
      })
    ).toBe(true)
    expect(githubHasNextPage({ link: '<https://api.github.com/x?page=1>; rel="prev"' })).toBe(false)
    expect(githubHasNextPage({})).toBe(false)
  })

  it('truncates without splitting surrogate pairs', () => {
    expect(truncateGithubText('abc', 5)).toEqual({ text: 'abc', truncated: false })
    expect(truncateGithubText('ab😀c', 3)).toEqual({ text: 'ab', truncated: true })
  })

  it('normalizes issues and flags pull requests', () => {
    const issue = normalizeGithubIssue(wireIssue({ pull_request: { url: 'x' } }))

    expect(issue).toMatchObject({
      number: 7,
      isPullRequest: true,
      labels: ['bug'],
      assignees: ['hubot'],
      milestone: { number: 2, title: 'v1' },
      type: 'Bug',
      author: 'octocat'
    })
  })

  it.effect('maps status codes to stable failure codes', () =>
    Effect.gen(function* () {
      const cases: Array<[number, string]> = [
        [401, 'github_unauthorized'],
        [403, 'github_forbidden'],
        [404, 'github_not_found'],
        [409, 'github_conflict'],
        [422, 'github_validation'],
        [429, 'github_rate_limited'],
        [500, 'github_request_failed']
      ]

      for (const [status, code] of cases) {
        const result = yield* githubFailure(response(status, { message: 'nope' }), {
          operation: 'test'
        })

        expect(failureOf(result).code).toBe(code)
      }
    })
  )

  it.effect('detects secondary/primary rate limits and computes retryAfterMs', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000)

      const primary = yield* githubFailure(
        response(
          403,
          { message: 'API rate limit exceeded' },
          { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1060' }
        ),
        { operation: 'list' }
      )

      const secondary = yield* githubFailure(
        response(403, { message: 'secondary' }, { 'Retry-After': '30' }),
        { operation: 'list' }
      )

      expect(failureOf(primary)).toMatchObject({
        code: 'github_rate_limited',
        retryAfterMs: 60_000
      })
      expect(failureOf(secondary)).toMatchObject({
        code: 'github_rate_limited',
        retryAfterMs: 30_000
      })
    })
  )

  it.effect('includes validation details and never the token', () =>
    Effect.gen(function* () {
      const result = yield* githubFailure(
        response(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }],
          documentation_url: 'https://docs.github.com/rest'
        }),
        { operation: 'create issue' }
      )

      expect(failureOf(result).message).toContain('Issue title missing_field')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('sends versioned headers scoped to the configured repo', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: {} }])

      yield* Effect.gen(function* () {
        const context = yield* resolveGithubContext(githubIntegration())

        yield* githubRepoRequest(context, {
          method: 'POST',
          path: '/issues',
          query: { per_page: 5, page: undefined },
          body: { title: 't' }
        })
      }).pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues')
      expect(request?.parsedUrl.search).toBe('?per_page=5')
      expect(request?.headers).toMatchObject({
        authorization: `Bearer ${githubTestToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        'content-type': 'application/json'
      })
      expect(request?.json).toEqual({ title: 't' })
    })
  )

  it.effect('rejects invalid repo config before credentials', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const exit = yield* resolveGithubContext(
        githubIntegration({ owner: 'acme', repo: '../x' })
      ).pipe(Effect.provide(host.layer), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.resolvedSlots).toEqual([])
    })
  )

  it.effect('rejects installation and password credentials for uploads', () =>
    Effect.gen(function* () {
      const installation = yield* resolveGithubUploadToken(githubIntegration()).pipe(
        Effect.provide(makeGithubHost().layer),
        Effect.exit
      )

      const password = yield* resolveGithubUploadToken(githubIntegration()).pipe(
        Effect.provide(
          makeGithubHost(undefined, () =>
            UsernamePasswordCredential.make({ username: 'u', password: 'p' })
          ).layer
        ),
        Effect.exit
      )

      expect(Exit.isFailure(installation)).toBe(true)
      expect(Exit.isFailure(password)).toBe(true)
      expect(JSON.stringify(installation)).not.toContain(githubTestToken)
    })
  )
})
