import { Effect, Result } from 'effect'
import type * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  githubCompareCommitsAction,
  githubGetFileContentsAction,
  githubListReleasesAction,
  githubRepositoryActions,
  githubSearchCodeAction
} from '../src/github/repository.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue
} from './github-fake.ts'

const linkNext = { Link: '<https://api.github.com/x?page=2>; rel="next"' }

const wireCommit = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  sha: 'abc123',
  commit: {
    message: 'Fix bug',
    author: { name: 'octocat', date: '2026-01-01T00:00:00Z' },
    committer: { name: 'octocat', date: '2026-01-01T00:00:00Z' }
  },
  author: { login: 'octocat', type: 'User' },
  ...overrides
})

const wireCompare = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  status: 'ahead',
  ahead_by: 2,
  behind_by: 0,
  total_commits: 2,
  commits: [wireCommit(), wireCommit({ sha: 'def456' })],
  files: [
    { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' },
    { filename: 'b.ts', status: 'added', additions: 10, deletions: 0, patch: null }
  ],
  html_url: 'https://github.com/acme/widgets/compare/main...feature',
  ...overrides
})

const wireRelease = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  id: 11,
  tag_name: 'v1.0.0',
  name: 'First',
  draft: false,
  prerelease: false,
  author: { login: 'octocat', type: 'User' },
  body: 'Notes',
  html_url: 'https://github.com/acme/widgets/releases/tag/v1.0.0',
  created_at: '2026-01-01T00:00:00Z',
  published_at: '2026-01-02T00:00:00Z',
  ...overrides
})

const wireFile = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  type: 'file',
  encoding: 'base64',
  size: 11,
  name: 'index.ts',
  path: 'src/index.ts',
  sha: 'sha123',
  content: 'aGVsbG8gd29ybGQ=',
  ...overrides
})

const wireCodeItem = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  name: 'index.ts',
  path: 'src/index.ts',
  sha: 'sha123',
  html_url: 'https://github.com/acme/widgets/blob/main/src/index.ts',
  repository: { full_name: 'acme/widgets' },
  text_matches: [{ fragment: 'hello world' }],
  ...overrides
})

describe('github repository actions', () => {
  it('exposes four read actions', () => {
    expect(githubRepositoryActions.map(action => action.id)).toEqual([
      'github.compare_commits',
      'github.list_releases',
      'github.get_file_contents',
      'github.search_code'
    ])

    for (const action of githubRepositoryActions) {
      expect(action.access).toBe('read')
    }
  })

  it.effect('compares commits with normalized commits and files', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireCompare() }])

      const result = yield* githubCompareCommitsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { base: 'main', head: 'feature', perPage: 50 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/compare/main...feature')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('50')

      const value = successValue(result)

      expect(value).toMatchObject({
        status: 'ahead',
        aheadBy: 2,
        behindBy: 0,
        totalCommits: 2,
        filesTruncated: false,
        hasNextPage: false,
        url: 'https://github.com/acme/widgets/compare/main...feature'
      })
      expect(value.commits).toMatchObject([
        { sha: 'abc123', message: 'Fix bug', author: 'octocat', date: '2026-01-01T00:00:00Z' },
        { sha: 'def456', messageTruncated: false }
      ])
      expect(value.files).toMatchObject([
        { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1, patchTruncated: false },
        { filename: 'b.ts', status: 'added', patch: null, patchTruncated: false }
      ])
    })
  )

  it.effect('truncates long commit messages and patches, flags extra files and next pages', () =>
    Effect.gen(function* () {
      const files = Array.from({ length: 101 }, (_, index) => ({
        filename: `f${index}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: 'x'.repeat(9000)
      }))

      const host = makeGithubHost([
        {
          headers: linkNext,
          body: wireCompare({
            commits: [wireCommit({ sha: 'long', commit: { message: 'm'.repeat(3000) } })],
            files
          })
        }
      ])

      const result = yield* githubCompareCommitsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { base: 'v1', head: 'v2' }
        })
        .pipe(Effect.provide(host.layer))

      const value = successValue(result)

      expect(value.commits[0]).toMatchObject({ messageTruncated: true })
      expect(value.commits[0]?.message?.length).toBe(2000)
      expect(value.files).toHaveLength(100)
      expect(value.filesTruncated).toBe(true)
      expect(value.files[0]).toMatchObject({ patchTruncated: true })
      expect(value.files[0]?.patch?.length).toBe(8000)
      expect(value.hasNextPage).toBe(true)
    })
  )

  it.effect('rejects unsafe compare refs and maps compare failures without the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      for (const input of [
        { base: 'main..x', head: 'feature' },
        { base: 'main', head: 'fea ture' },
        { base: 'main\tx', head: 'feature' }
      ]) {
        const result = yield* githubCompareCommitsAction
          .executeTyped({ integration: githubIntegration(), input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            actionId: 'github.compare_commits'
          })
        }
      }

      expect(host.requests).toHaveLength(0)

      const failure = yield* githubCompareCommitsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { base: 'main', head: 'feature' }
        })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(failure).code).toBe('github_not_found')
      expect(JSON.stringify(failure)).not.toContain(githubTestToken)

      const invalid = yield* githubCompareCommitsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { base: 'main', head: 'feature' }
        })
        .pipe(
          Effect.provide(makeGithubHost([{ status: 422, body: { message: 'No commits' } }]).layer)
        )

      expect(failureOf(invalid).code).toBe('github_validation')
    })
  )

  it.effect('lists releases with pagination and truncation', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          headers: linkNext,
          body: [wireRelease(), wireRelease({ id: 12, body: 'n'.repeat(3000), author: null })]
        }
      ])

      const result = yield* githubListReleasesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { perPage: 2, page: 1 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/releases')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('2')
      expect(request?.parsedUrl.searchParams.get('page')).toBe('1')

      const value = successValue(result)

      expect(value.hasNextPage).toBe(true)
      expect(value.releases[0]).toMatchObject({
        id: 11,
        tagName: 'v1.0.0',
        author: 'octocat',
        bodyTruncated: false
      })
      expect(value.releases[1]).toMatchObject({ author: null, bodyTruncated: true })
      expect(value.releases[1]?.body?.length).toBe(2000)
    })
  )

  it.effect('maps release failures without the token', () =>
    Effect.gen(function* () {
      const result = yield* githubListReleasesAction
        .executeTyped({ integration: githubIntegration(), input: {} })
        .pipe(Effect.provide(makeGithubHost([{ status: 404, body: { message: 'nope' } }]).layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('reads file contents with encoded segments and ref query', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireFile() }])

      const result = yield* githubGetFileContentsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { path: 'dir name/index.ts', ref: 'main' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/contents/dir%20name/index.ts')
      expect(request?.parsedUrl.searchParams.get('ref')).toBe('main')

      expect(successValue(result)).toEqual({
        path: 'src/index.ts',
        sha: 'sha123',
        size: 11,
        content: 'hello world',
        truncated: false
      })
    })
  )

  it.effect('truncates large file content at the file cap', () =>
    Effect.gen(function* () {
      const content = btoa('a'.repeat(100_050))

      const result = yield* githubGetFileContentsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { path: 'big.txt' }
        })
        .pipe(
          Effect.provide(makeGithubHost([{ body: wireFile({ size: 100_050, content }) }]).layer)
        )

      const value = successValue(result)

      expect(value.content.length).toBe(100_000)
      expect(value.truncated).toBe(true)
    })
  )

  it.effect('rejects directories, symlinks, oversized, and binary content', () =>
    Effect.gen(function* () {
      const directory = [{ name: 'a.ts' }, { name: 'b.ts' }]

      const cases: Array<{ readonly body: Schema.Json; readonly match: string }> = [
        { body: directory, match: 'is a directory' },
        { body: wireFile({ type: 'symlink' }), match: "'symlink'" },
        { body: wireFile({ encoding: 'none', content: '', size: 5 }), match: 'too large' },
        { body: wireFile({ content: '', size: 7 }), match: 'too large' },
        { body: wireFile({ content: 'YQBi', size: 3 }), match: 'binary' },
        { body: wireFile({ content: '/w==', size: 1 }), match: 'UTF-8' }
      ]

      for (const entry of cases) {
        const result = yield* githubGetFileContentsAction
          .executeTyped({ integration: githubIntegration(), input: { path: 'src/index.ts' } })
          .pipe(Effect.provide(makeGithubHost([{ body: entry.body }]).layer))

        const failure = failureOf(result)

        expect(failure.code).toBe('github_unsupported_content')
        expect(failure.message).toContain(entry.match)
        expect(JSON.stringify(result)).not.toContain(githubTestToken)
      }

      const names = Array.from({ length: 60 }, (_, index) => ({ name: `f${index}.ts` }))

      const listed = yield* githubGetFileContentsAction
        .executeTyped({ integration: githubIntegration(), input: { path: 'src' } })
        .pipe(Effect.provide(makeGithubHost([{ body: names }]).layer))

      expect(failureOf(listed).message).toContain("'f0.ts'")
      expect(failureOf(listed).message).not.toContain("'f50.ts'")
    })
  )

  it.effect('rejects unsafe content paths before any request and maps 404', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      for (const path of ['/abs.ts', 'a/../b.ts', 'a/./b.ts', 'a//b.ts', 'a\\b.ts', 'a/bád\0.ts']) {
        const result = yield* githubGetFileContentsAction
          .executeTyped({ integration: githubIntegration(), input: { path } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            actionId: 'github.get_file_contents'
          })
        }
      }

      expect(host.requests).toHaveLength(0)

      const missing = yield* githubGetFileContentsAction
        .executeTyped({ integration: githubIntegration(), input: { path: 'missing.ts' } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(missing).code).toBe('github_not_found')
    })
  )

  it.effect('searches code scoped to the configured repo with text-match accept', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          headers: linkNext,
          body: {
            total_count: 3,
            incomplete_results: true,
            items: [
              wireCodeItem(),
              wireCodeItem({ path: 'other.ts', repository: { full_name: 'acme/other' } }),
              wireCodeItem({
                path: 'big.ts',
                text_matches: [{ fragment: 'z'.repeat(600) }, { fragment: 'a' }]
              })
            ]
          }
        }
      ])

      const result = yield* githubSearchCodeAction
        .executeTyped({
          integration: githubIntegration(),
          input: { query: 'hello', perPage: 10 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/search/code')
      expect(request?.parsedUrl.searchParams.get('q')).toBe('repo:acme/widgets hello')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('10')
      expect(request?.headers?.['accept']).toBe('application/vnd.github.text-match+json')

      const value = successValue(result)

      expect(value.totalCount).toBe(3)
      expect(value.incompleteResults).toBe(true)
      expect(value.hasNextPage).toBe(true)
      expect(value.items.map(item => item.path)).toEqual(['src/index.ts', 'big.ts'])
      expect(value.items[1]?.fragments).toEqual(['z'.repeat(500), 'a'])
    })
  )

  it.effect('rejects scoped search qualifiers and maps search failures', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 422, body: { message: 'Validation Failed' } }])

      for (const query of [
        'repo:acme/widgets hello',
        '-repo:acme/widgets hello',
        'ORG:acme hello',
        'hello user:octocat',
        'hello Owner:acme'
      ]) {
        const result = yield* githubSearchCodeAction
          .executeTyped({ integration: githubIntegration(), input: { query } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            cause: 'validation_failed',
            actionId: 'github.search_code'
          })
        }
      }

      expect(host.requests).toHaveLength(0)

      const failure = yield* githubSearchCodeAction
        .executeTyped({ integration: githubIntegration(), input: { query: 'hello' } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(failure).code).toBe('github_validation')
      expect(JSON.stringify(failure)).not.toContain(githubTestToken)
    })
  )
})
