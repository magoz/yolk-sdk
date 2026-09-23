import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  githubAddLabelsAction,
  githubCreateIssueCommentAction,
  githubCreateReactionAction,
  githubDeleteIssueCommentAction,
  githubListIssueCommentsAction,
  githubListLabelsAction,
  githubListMilestonesAction,
  githubRemoveLabelAction,
  githubUpdateIssueCommentAction
} from '../src/github/comments.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue
} from './github-fake.ts'

const wireComment = (overrides: Record<string, Schema.Json> = {}) => ({
  id: 101,
  body: 'Nice work',
  user: { login: 'octocat', type: 'User' },
  html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-101',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...overrides
})

describe('GitHub comments', () => {
  it.effect('lists issue comments with pagination and truncation', () =>
    Effect.gen(function* () {
      const longBody = `${'x'.repeat(4_000)}tail`

      const host = makeGithubHost([
        {
          body: [wireComment(), wireComment({ id: 102, body: longBody, user: null })],
          headers: {
            Link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?page=2>; rel="next"'
          }
        }
      ])

      const result = yield* githubListIssueCommentsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, since: '2026-01-01T00:00:00Z', perPage: 2, page: 1 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/comments')
      expect(request?.parsedUrl.searchParams.get('since')).toBe('2026-01-01T00:00:00Z')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('2')
      expect(request?.parsedUrl.searchParams.get('page')).toBe('1')

      const output = successValue(result)

      expect(output.hasNextPage).toBe(true)
      expect(output.comments[0]).toMatchObject({ id: 101, author: 'octocat', body: 'Nice work' })
      expect(output.comments[1]).toMatchObject({
        id: 102,
        author: null,
        bodyTruncated: true
      })
      expect(output.comments[1]?.body.length).toBe(4_000)
    })
  )

  it.effect('creates an issue comment', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireComment({ body: 'Hello' }) }])

      const result = yield* githubCreateIssueCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, body: 'Hello' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/comments')
      expect(request?.json).toEqual({ body: 'Hello' })
      expect(successValue(result)).toMatchObject({
        id: 101,
        author: 'octocat',
        body: 'Hello',
        bodyTruncated: false
      })
    })
  )

  it.effect('truncates long comment bodies at the full cap', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireComment({ body: `${'y'.repeat(20_001)}!` }) }])

      const result = yield* githubCreateIssueCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, body: 'Hello' }
        })
        .pipe(Effect.provide(host.layer))

      const output = successValue(result)

      expect(output.bodyTruncated).toBe(true)
      expect(output.body.length).toBe(20_000)
    })
  )

  it.effect('updates an issue comment', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: wireComment({ id: 101, body: 'Edited' }) }])

      const result = yield* githubUpdateIssueCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { commentId: 101, body: 'Edited' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('PATCH')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/comments/101')
      expect(request?.json).toEqual({ body: 'Edited' })
      expect(successValue(result)).toMatchObject({ id: 101, body: 'Edited' })
    })
  )

  it.effect('deletes an issue comment', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 204, body: '' }])

      const result = yield* githubDeleteIssueCommentAction
        .executeTyped({
          integration: githubIntegration(),
          input: { commentId: 101 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('DELETE')
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/comments/101')
      expect(successValue(result)).toEqual({ commentId: 101, deleted: true })
    })
  )

  it.effect('lists labels with null descriptions', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
            { name: 'chore', color: 'ffffff', description: null }
          ]
        }
      ])

      const result = yield* githubListLabelsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { perPage: 30 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('GET')
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/labels')
      expect(host.requests[0]?.parsedUrl.searchParams.get('per_page')).toBe('30')
      expect(successValue(result)).toEqual({
        labels: [
          { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
          { name: 'chore', color: 'ffffff', description: null }
        ],
        hasNextPage: false
      })
    })
  )

  it.effect('adds labels and returns the full label list', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: [{ name: 'bug' }, { name: 'help wanted' }] }])

      const result = yield* githubAddLabelsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, labels: ['bug', 'help wanted'] }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/labels')
      expect(request?.json).toEqual({ labels: ['bug', 'help wanted'] })
      expect(successValue(result)).toEqual({ issueNumber: 7, labels: ['bug', 'help wanted'] })
    })
  )

  it.effect('removes a label with an encoded name', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: [{ name: 'bug' }] }])

      const result = yield* githubRemoveLabelAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, label: 'help wanted' }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('DELETE')
      expect(host.requests[0]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/labels/help%20wanted'
      )
      expect(successValue(result)).toEqual({ issueNumber: 7, labels: ['bug'] })
    })
  )

  it.effect('lists milestones with filters', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              number: 2,
              title: 'v1',
              state: 'open',
              description: null,
              due_on: '2026-06-01T00:00:00Z',
              open_issues: 4,
              closed_issues: 6,
              html_url: 'https://github.com/acme/widgets/milestone/2'
            }
          ]
        }
      ])

      const result = yield* githubListMilestonesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { state: 'open', sort: 'due_on', direction: 'asc' }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/milestones')
      expect(request?.parsedUrl.searchParams.get('state')).toBe('open')
      expect(request?.parsedUrl.searchParams.get('sort')).toBe('due_on')
      expect(request?.parsedUrl.searchParams.get('direction')).toBe('asc')
      expect(successValue(result)).toEqual({
        milestones: [
          {
            number: 2,
            title: 'v1',
            state: 'open',
            description: null,
            dueOn: '2026-06-01T00:00:00Z',
            openIssues: 4,
            closedIssues: 6,
            url: 'https://github.com/acme/widgets/milestone/2'
          }
        ],
        hasNextPage: false
      })
    })
  )

  it.effect('creates issue and comment reactions', () =>
    Effect.gen(function* () {
      const issueHost = makeGithubHost([
        { status: 201, body: { id: 55, content: 'hooray', user: { login: 'octocat' } } }
      ])

      const issueResult = yield* githubCreateReactionAction
        .executeTyped({
          integration: githubIntegration(),
          input: { content: 'hooray', issueNumber: 7 }
        })
        .pipe(Effect.provide(issueHost.layer))

      expect(issueHost.requests[0]?.method).toBe('POST')
      expect(issueHost.requests[0]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/reactions'
      )
      expect(issueHost.requests[0]?.json).toEqual({ content: 'hooray' })
      expect(successValue(issueResult)).toEqual({ id: 55, content: 'hooray', author: 'octocat' })

      const commentHost = makeGithubHost([
        { status: 200, body: { id: 56, content: '+1', user: null } }
      ])

      const commentResult = yield* githubCreateReactionAction
        .executeTyped({
          integration: githubIntegration(),
          input: { content: '+1', commentId: 101 }
        })
        .pipe(Effect.provide(commentHost.layer))

      expect(commentHost.requests[0]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/comments/101/reactions'
      )
      expect(successValue(commentResult)).toEqual({ id: 56, content: '+1', author: null })
    })
  )

  it.effect('rejects reactions with zero or two targets before HTTP', () =>
    Effect.gen(function* () {
      const bothHost = makeGithubHost()

      const both = yield* githubCreateReactionAction
        .executeTyped({
          integration: githubIntegration(),
          input: { content: '+1', issueNumber: 7, commentId: 101 }
        })
        .pipe(Effect.provide(bothHost.layer), Effect.exit)

      const neitherHost = makeGithubHost()

      const neither = yield* githubCreateReactionAction
        .executeTyped({
          integration: githubIntegration(),
          input: { content: '+1' }
        })
        .pipe(Effect.provide(neitherHost.layer), Effect.exit)

      expect(Exit.isFailure(both)).toBe(true)
      expect(Exit.isFailure(neither)).toBe(true)
      expect(bothHost.requests.length).toBe(0)
      expect(neitherHost.requests.length).toBe(0)
    })
  )

  it.effect('maps 404 to github_not_found without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubListIssueCommentsAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7 }
        })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('maps 422 to github_validation without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'custom' }] } }
      ])

      const result = yield* githubCreateReactionAction
        .executeTyped({
          integration: githubIntegration(),
          input: { content: 'heart', issueNumber: 7 }
        })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})
