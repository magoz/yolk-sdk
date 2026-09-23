import { Effect, Predicate, Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  githubAddAssigneesAction,
  githubCreateIssueAction,
  githubGetIssueAction,
  githubListAssigneesAction,
  githubListIssueTimelineAction,
  githubListIssuesAction,
  githubLockIssueAction,
  githubRemoveAssigneesAction,
  githubSearchIssuesAction,
  githubUnlockIssueAction,
  githubUpdateIssueAction
} from '../src/github/issues.ts'
import type { GithubUpdateIssueInput } from '../src/github/issues.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue,
  wireIssue
} from './github-fake.ts'

const nextLink = '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"'

describe('GitHub search issues', () => {
  it.effect('searches scoped to the configured repo and drops foreign items', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            total_count: 2,
            incomplete_results: false,
            items: [
              wireIssue({
                repository_url: 'https://api.github.com/repos/acme/widgets'
              }),
              wireIssue({
                number: 8,
                repository_url: 'https://api.github.com/repos/other/repo'
              })
            ]
          }
        }
      ])

      const result = yield* githubSearchIssuesAction
        .executeTyped({ integration: githubIntegration(), input: { query: 'bug crash' } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/search/issues')
      expect(request?.parsedUrl.searchParams.get('q')).toBe('repo:acme/widgets bug crash')

      const output = successValue(result)

      expect(output.totalCount).toBe(2)
      expect(output.incompleteResults).toBe(false)
      expect(output.items).toHaveLength(1)
      expect(output.items[0]).toMatchObject({ number: 7, title: 'Bug report' })
      expect(output.hasNextPage).toBe(false)
    })
  )

  it.effect('rejects scope-widening qualifiers before any HTTP request', () =>
    Effect.gen(function* () {
      const queries = [
        'repo:other/repo bug',
        'is:open org:acme',
        '-repo:acme/widgets x',
        'label:bug USER:octocat',
        'owner:acme bug',
        'milestone:v1 Owner:acme',
        '   '
      ]

      for (const query of queries) {
        const host = makeGithubHost()

        const result = yield* githubSearchIssuesAction
          .executeTyped({ integration: githubIntegration(), input: { query } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
          expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        }

        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('accepts queries that merely contain qualifier substrings', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: { total_count: 0, incomplete_results: false, items: [] } }
      ])

      const result = yield* githubSearchIssuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { query: 'report: quarterly results' }
        })
        .pipe(Effect.provide(host.layer))

      expect(successValue(result).items).toHaveLength(0)
      expect(host.requests).toHaveLength(1)
    })
  )

  it.effect('sends sort, order, and pagination, reading hasNextPage from Link', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          headers: { link: nextLink },
          body: { total_count: 0, incomplete_results: true, items: [] }
        }
      ])

      const result = yield* githubSearchIssuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { query: 'bug', sort: 'updated', order: 'desc', perPage: 25, page: 3 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.parsedUrl.searchParams.get('q')).toBe('repo:acme/widgets bug')
      expect(request?.parsedUrl.searchParams.get('sort')).toBe('updated')
      expect(request?.parsedUrl.searchParams.get('order')).toBe('desc')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('25')
      expect(request?.parsedUrl.searchParams.get('page')).toBe('3')

      const output = successValue(result)

      expect(output.incompleteResults).toBe(true)
      expect(output.hasNextPage).toBe(true)
    })
  )

  it.effect('truncates list bodies and maps failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: {
            total_count: 1,
            incomplete_results: false,
            items: [
              wireIssue({
                body: 'x'.repeat(2500),
                repository_url: 'https://api.github.com/repos/ACME/WIDGETS'
              })
            ]
          }
        }
      ])

      const result = yield* githubSearchIssuesAction
        .executeTyped({ integration: githubIntegration(), input: { query: 'bug' } })
        .pipe(Effect.provide(host.layer))

      const item = successValue(result).items[0]

      expect(item?.body).toHaveLength(2000)
      expect(item?.bodyTruncated).toBe(true)

      const notFound = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const missing = yield* githubSearchIssuesAction
        .executeTyped({ integration: githubIntegration(), input: { query: 'bug' } })
        .pipe(Effect.provide(notFound.layer))

      const failure = failureOf(missing)

      expect(failure.code).toBe('github_not_found')
      expect(JSON.stringify(missing)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub list issues', () => {
  it.effect('lists with filters, comma-joined labels, and pagination', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          headers: { link: nextLink },
          body: [wireIssue(), wireIssue({ number: 9, pull_request: { url: 'x' } })]
        }
      ])

      const result = yield* githubListIssuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            state: 'open',
            labels: ['bug', 'high priority'],
            assignee: 'hubot',
            type: 'Bug',
            since: '2026-01-01T00:00:00Z',
            sort: 'created',
            direction: 'asc',
            perPage: 50,
            page: 2
          }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues')

      const params = request?.parsedUrl.searchParams

      expect(params?.get('state')).toBe('open')
      expect(params?.get('labels')).toBe('bug,high priority')
      expect(params?.get('assignee')).toBe('hubot')
      expect(params?.get('type')).toBe('Bug')
      expect(params?.get('since')).toBe('2026-01-01T00:00:00Z')
      expect(params?.get('sort')).toBe('created')
      expect(params?.get('direction')).toBe('asc')
      expect(params?.get('per_page')).toBe('50')
      expect(params?.get('page')).toBe('2')

      const output = successValue(result)

      expect(output.issues).toHaveLength(2)
      expect(output.issues[0]).toMatchObject({ number: 7, isPullRequest: false })
      expect(output.issues[1]).toMatchObject({ number: 9, isPullRequest: true })
      expect(output.hasNextPage).toBe(true)
    })
  )

  it.effect('maps validation failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'custom' }] } }
      ])

      const result = yield* githubListIssuesAction
        .executeTyped({ integration: githubIntegration(), input: {} })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_validation')
      expect(failure.message).toContain('Validation Failed')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub get issue', () => {
  it.effect('gets a single issue with the full body cap', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireIssue({ body: 'y'.repeat(3000) }) }])

      const result = yield* githubGetIssueAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7')

      const output = successValue(result)

      expect(output).toMatchObject({ number: 7, title: 'Bug report', author: 'octocat' })
      expect(output.body).toHaveLength(3000)
      expect(output.bodyTruncated).toBe(false)
    })
  )

  it.effect('maps 404 to github_not_found', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubGetIssueAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub create issue', () => {
  it.effect('creates with only the provided fields', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 201, body: wireIssue() }])

      const result = yield* githubCreateIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            title: 'New bug',
            labels: ['bug'],
            assignees: ['hubot'],
            milestone: 2,
            type: 'Bug'
          }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues')
      expect(request?.json).toEqual({
        title: 'New bug',
        labels: ['bug'],
        assignees: ['hubot'],
        milestone: 2,
        type: 'Bug'
      })

      expect(successValue(result)).toMatchObject({ number: 7, title: 'Bug report' })
    })
  )

  it.effect('maps 422 without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 422, body: { message: 'Validation Failed' } }])

      const result = yield* githubCreateIssueAction
        .executeTyped({ integration: githubIntegration(), input: { title: 'New bug' } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub update issue', () => {
  it.effect('patches changed fields and clears the milestone with null', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { body: wireIssue({ state: 'closed', state_reason: 'completed', milestone: null }) }
      ])

      const result = yield* githubUpdateIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            issueNumber: 7,
            title: 'Fixed',
            state: 'closed',
            stateReason: 'completed',
            clearMilestone: true
          }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('PATCH')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7')
      expect(request?.json).toEqual({
        title: 'Fixed',
        state: 'closed',
        state_reason: 'completed',
        milestone: null
      })

      expect(successValue(result)).toMatchObject({ state: 'closed', stateReason: 'completed' })
    })
  )

  it.effect('rejects invalid transitions before any HTTP request', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Partial<GithubUpdateIssueInput>> = [
        {},
        { milestone: 2, clearMilestone: true },
        { type: 'Bug', clearType: true },
        { stateReason: 'completed' },
        { stateReason: 'reopened', state: 'closed' },
        { stateReason: 'not_planned', state: 'open' },
        { title: '   ' }
      ]

      for (const changes of cases) {
        const host = makeGithubHost()

        const result = yield* githubUpdateIssueAction
          .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7, ...changes } })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
          expect(result.failure).toMatchObject({ cause: 'validation_failed' })
        }

        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('accepts reopened with open and maps 404 without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubUpdateIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, state: 'open', stateReason: 'reopened' }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests).toHaveLength(1)
      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub lock and unlock issue', () => {
  it.effect('locks with a reason', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 204 }])

      const result = yield* githubLockIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, lockReason: 'spam' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('PUT')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/lock')
      expect(request?.json).toEqual({ lock_reason: 'spam' })
      expect(successValue(result)).toEqual({ issueNumber: 7, locked: true })
    })
  )

  it.effect('locks without a body when no reason is given', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 204 }])

      const result = yield* githubLockIssueAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.json).toBeUndefined()
      expect(successValue(result)).toEqual({ issueNumber: 7, locked: true })
    })
  )

  it.effect('maps lock failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubLockIssueAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('unlocks', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 204 }])

      const result = yield* githubUnlockIssueAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('DELETE')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/lock')
      expect(successValue(result)).toEqual({ issueNumber: 7, locked: false })
    })
  )
})

describe('GitHub issue assignees', () => {
  it.effect('adds assignees', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireIssue() }])

      const result = yield* githubAddAssigneesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, assignees: ['hubot', 'octocat'] }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/assignees')
      expect(request?.json).toEqual({ assignees: ['hubot', 'octocat'] })
      expect(successValue(result)).toMatchObject({ number: 7, assignees: ['hubot'] })
    })
  )

  it.effect('rejects empty assignee lists before any HTTP request', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const result = yield* githubAddAssigneesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, assignees: [] }
        })
        .pipe(Effect.provide(host.layer), Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'ConnectorError')).toBe(true)
      }

      expect(host.requests).toHaveLength(0)
    })
  )

  it.effect('removes assignees with a DELETE body', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireIssue({ assignees: [] }) }])

      const result = yield* githubRemoveAssigneesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, assignees: ['hubot'] }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('DELETE')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/assignees')
      expect(request?.json).toEqual({ assignees: ['hubot'] })
      expect(successValue(result)).toMatchObject({ number: 7, assignees: [] })
    })
  )

  it.effect('maps assignee failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 422, body: { message: 'Validation Failed' } }])

      const result = yield* githubAddAssigneesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, assignees: ['hubot'] }
        })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub list assignees', () => {
  it.effect('lists assignable users with pagination', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          headers: { link: nextLink },
          body: [{ login: 'hubot', type: 'Bot' }, { login: 'octocat' }]
        }
      ])

      const result = yield* githubListAssigneesAction
        .executeTyped({ integration: githubIntegration(), input: { perPage: 30, page: 1 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/assignees')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('30')
      expect(request?.parsedUrl.searchParams.get('page')).toBe('1')

      const output = successValue(result)

      expect(output.assignees).toEqual([
        { login: 'hubot', type: 'Bot' },
        { login: 'octocat', type: null }
      ])
      expect(output.hasNextPage).toBe(true)
    })
  )

  it.effect('maps forbidden without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 403, body: { message: 'Forbidden' } }])

      const result = yield* githubListAssigneesAction
        .executeTyped({ integration: githubIntegration(), input: {} })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_forbidden')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})

describe('GitHub list issue timeline', () => {
  it.effect('normalizes heterogeneous events with a flat detail struct', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              event: 'labeled',
              actor: { login: 'octocat' },
              created_at: '2026-01-01T00:00:00Z',
              label: { name: 'bug' }
            },
            {
              event: 'assigned',
              actor: { login: 'octocat' },
              created_at: '2026-01-01T01:00:00Z',
              assignee: { login: 'hubot' }
            },
            {
              event: 'commented',
              user: { login: 'hubot' },
              created_at: '2026-01-01T02:00:00Z',
              body: 'Looking into it'
            },
            {
              event: 'cross-referenced',
              actor: { login: 'octocat' },
              created_at: '2026-01-01T03:00:00Z',
              source: {
                type: 'issue',
                issue: {
                  number: 12,
                  title: 'Fix it',
                  state: 'open',
                  html_url: 'https://github.com/acme/widgets/pull/12',
                  repository_url: 'https://api.github.com/repos/acme/widgets',
                  pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/12' }
                }
              }
            },
            {
              event: 'committed',
              sha: 'abc123',
              message: 'fix it',
              author: { name: 'A', email: 'a@example.com', date: '2026-01-03T00:00:00Z' },
              committer: { name: 'A', email: 'a@example.com', date: '2026-01-03T00:00:00Z' }
            },
            {
              event: 'reviewed',
              user: { login: 'rev' },
              submitted_at: '2026-01-04T00:00:00Z',
              state: 'approved',
              body: 'lgtm',
              commit_id: 'abc123'
            },
            {
              event: 'renamed',
              actor: { login: 'octocat' },
              created_at: '2026-01-05T00:00:00Z',
              rename: { from: 'Old title', to: 'New title' }
            },
            {
              event: 'milestoned',
              actor: { login: 'octocat' },
              created_at: '2026-01-06T00:00:00Z',
              milestone: { title: 'v2' }
            },
            {
              event: 'closed',
              actor: { login: 'octocat' },
              created_at: '2026-01-07T00:00:00Z',
              state_reason: 'completed',
              commit_id: 'sha9'
            },
            { event: 'time-flux', actor: { login: 'bot' }, created_at: '2026-01-08T00:00:00Z' }
          ]
        }
      ])

      const result = yield* githubListIssueTimelineAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/timeline')

      const output = successValue(result)

      expect(output.events).toHaveLength(10)
      expect(output.events[0]).toMatchObject({
        event: 'labeled',
        actor: 'octocat',
        label: 'bug'
      })
      expect(output.events[1]).toMatchObject({ event: 'assigned', assignee: 'hubot' })
      expect(output.events[2]).toMatchObject({
        event: 'commented',
        actor: 'hubot',
        body: 'Looking into it',
        bodyTruncated: false
      })
      expect(output.events[3]).toMatchObject({
        event: 'cross-referenced',
        source: {
          number: 12,
          title: 'Fix it',
          isPullRequest: true,
          state: 'open',
          url: 'https://github.com/acme/widgets/pull/12',
          repository: 'acme/widgets'
        }
      })
      expect(output.events[4]).toMatchObject({
        event: 'committed',
        actor: null,
        createdAt: '2026-01-03T00:00:00Z',
        sha: 'abc123',
        message: 'fix it'
      })
      expect(output.events[5]).toMatchObject({
        event: 'reviewed',
        actor: 'rev',
        createdAt: '2026-01-04T00:00:00Z',
        reviewState: 'approved',
        body: 'lgtm',
        commitId: 'abc123'
      })
      expect(output.events[6]).toMatchObject({
        event: 'renamed',
        renamedFrom: 'Old title',
        renamedTo: 'New title'
      })
      expect(output.events[7]).toMatchObject({ event: 'milestoned', milestone: 'v2' })
      expect(output.events[8]).toMatchObject({
        event: 'closed',
        stateReason: 'completed',
        commitId: 'sha9'
      })
      expect(output.events[9]).toEqual({
        event: 'time-flux',
        actor: 'bot',
        createdAt: '2026-01-08T00:00:00Z'
      })
      expect(output.hasNextPage).toBe(false)
    })
  )

  it.effect('truncates timeline comment bodies at the list cap', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              event: 'commented',
              actor: { login: 'octocat' },
              created_at: '2026-01-01T00:00:00Z',
              body: 'z'.repeat(2500)
            }
          ]
        }
      ])

      const result = yield* githubListIssueTimelineAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(host.layer))

      const event = successValue(result).events[0]

      expect(event?.body).toHaveLength(2000)
      expect(event?.bodyTruncated).toBe(true)
    })
  )

  it.effect('reads hasNextPage and maps failures without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ headers: { link: nextLink }, body: [] }])

      const paged = yield* githubListIssueTimelineAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7, page: 2 } })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.parsedUrl.searchParams.get('page')).toBe('2')
      expect(successValue(paged).hasNextPage).toBe(true)

      const missing = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubListIssueTimelineAction
        .executeTyped({ integration: githubIntegration(), input: { issueNumber: 7 } })
        .pipe(Effect.provide(missing.layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})
