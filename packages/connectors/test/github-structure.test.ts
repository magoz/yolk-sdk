import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import {
  githubAddBlockedByAction,
  githubAddSubIssueAction,
  githubListIssueDependenciesAction,
  githubListIssueFieldsAction,
  githubListIssueTypesAction,
  githubListSubIssuesAction,
  githubRemoveBlockedByAction,
  githubRemoveSubIssueAction,
  githubSetIssueFieldValuesAction
} from '../src/github/structure.ts'
import {
  failureOf,
  githubIntegration,
  githubTestToken,
  makeGithubHost,
  successValue,
  wireIssue
} from './github-fake.ts'

describe('GitHub structure', () => {
  it.effect('lists sub issues with list body cap and pagination', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [wireIssue(), wireIssue({ number: 8, body: `${'z'.repeat(2_001)}!` })],
          headers: {
            Link: '<https://api.github.com/repos/acme/widgets/issues/7/sub_issues?page=2>; rel="next"'
          }
        }
      ])

      const result = yield* githubListSubIssuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, perPage: 2 }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('GET')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/sub_issues')
      expect(request?.parsedUrl.searchParams.get('per_page')).toBe('2')

      const output = successValue(result)

      expect(output.hasNextPage).toBe(true)
      expect(output.subIssues.length).toBe(2)
      expect(output.subIssues[0]).toMatchObject({ number: 7, title: 'Bug report' })
      expect(output.subIssues[1]).toMatchObject({ number: 8, bodyTruncated: true })
      expect(output.subIssues[1]?.body?.length).toBe(2_000)
    })
  )

  it.effect('adds a sub issue by resolving the child id', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: { id: 2002 } }, { status: 201, body: wireIssue() }])

      const result = yield* githubAddSubIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, subIssueNumber: 9, replaceParent: true }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('GET')
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/9')
      expect(host.requests[1]?.method).toBe('POST')
      expect(host.requests[1]?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/sub_issues')
      expect(host.requests[1]?.json).toEqual({ sub_issue_id: 2002, replace_parent: true })

      const output = successValue(result)

      expect(output.subIssueNumber).toBe(9)
      expect(output.parent).toMatchObject({ number: 7 })
    })
  )

  it.effect('rejects adding an issue as its own sub issue', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const exit = yield* githubAddSubIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, subIssueNumber: 7 }
        })
        .pipe(Effect.provide(host.layer), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.requests.length).toBe(0)
    })
  )

  it.effect('removes a sub issue with the singular path and JSON body', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: { id: 2002 } }, { body: wireIssue() }])

      const result = yield* githubRemoveSubIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, subIssueNumber: 9 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[1]?.method).toBe('DELETE')
      expect(host.requests[1]?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/sub_issue')
      expect(host.requests[1]?.json).toEqual({ sub_issue_id: 2002 })

      const output = successValue(result)

      expect(output.subIssueNumber).toBe(9)
      expect(output.parent).toMatchObject({ number: 7 })
    })
  )

  it.effect('propagates a failed sub issue lookup', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubRemoveSubIssueAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, subIssueNumber: 999 }
        })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_not_found')
      expect(host.requests.length).toBe(1)
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('lists blocked-by and blocking dependencies', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [wireIssue({ number: 3 })],
          headers: {
            Link: '<https://api.github.com/x?page=2>; rel="next"'
          }
        },
        { body: [wireIssue({ number: 11 })] }
      ])

      const result = yield* githubListIssueDependenciesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, perPage: 10 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('GET')
      expect(host.requests[0]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/dependencies/blocked_by'
      )
      expect(host.requests[0]?.parsedUrl.searchParams.get('per_page')).toBe('10')
      expect(host.requests[1]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/dependencies/blocking'
      )

      const output = successValue(result)

      expect(output.blockedBy.map(issue => issue.number)).toEqual([3])
      expect(output.blockedByHasNextPage).toBe(true)
      expect(output.blocking.map(issue => issue.number)).toEqual([11])
      expect(output.blockingHasNextPage).toBe(false)
    })
  )

  it.effect('returns the first dependency failure', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 403, body: { message: 'Forbidden' } }])

      const result = yield* githubListIssueDependenciesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7 }
        })
        .pipe(Effect.provide(host.layer))

      expect(failureOf(result).code).toBe('github_forbidden')
      expect(host.requests.length).toBe(1)
    })
  )

  it.effect('adds a blocked-by dependency', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: { id: 3003 } }, { status: 201, body: wireIssue() }])

      const result = yield* githubAddBlockedByAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, blockingIssueNumber: 5 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/5')
      expect(host.requests[1]?.method).toBe('POST')
      expect(host.requests[1]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/dependencies/blocked_by'
      )
      expect(host.requests[1]?.json).toEqual({ issue_id: 3003 })

      const output = successValue(result)

      expect(output.blockingIssueNumber).toBe(5)
      expect(output.issue).toMatchObject({ number: 7 })
    })
  )

  it.effect('rejects equal blocked-by numbers without HTTP', () =>
    Effect.gen(function* () {
      const host = makeGithubHost()

      const exit = yield* githubAddBlockedByAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, blockingIssueNumber: 7 }
        })
        .pipe(Effect.provide(host.layer), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.requests.length).toBe(0)
    })
  )

  it.effect('removes a blocked-by dependency with the id in the path', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ body: { id: 3003 } }, { body: wireIssue() }])

      const result = yield* githubRemoveBlockedByAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, blockingIssueNumber: 5 }
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[1]?.method).toBe('DELETE')
      expect(host.requests[1]?.parsedUrl.pathname).toBe(
        '/repos/acme/widgets/issues/7/dependencies/blocked_by/3003'
      )
      expect(host.requests[1]?.json).toBeUndefined()

      const output = successValue(result)

      expect(output.blockingIssueNumber).toBe(5)
      expect(output.issue).toMatchObject({ number: 7 })
    })
  )

  it.effect('lists org issue types with null normalization', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            { id: 1, name: 'Bug', description: 'Breaks things', color: 'red', is_enabled: true },
            { id: 2, name: 'Task', description: null, color: null, is_enabled: null }
          ]
        }
      ])

      const result = yield* githubListIssueTypesAction
        .executeTyped({
          integration: githubIntegration(),
          input: {}
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('GET')
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/orgs/acme/issue-types')
      expect(successValue(result)).toEqual({
        issueTypes: [
          { id: 1, name: 'Bug', description: 'Breaks things', color: 'red', isEnabled: true },
          { id: 2, name: 'Task', description: null, color: null, isEnabled: null }
        ]
      })
    })
  )

  it.effect('maps org endpoint 404 to github_not_found', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([{ status: 404, body: { message: 'Not Found' } }])

      const result = yield* githubListIssueTypesAction
        .executeTyped({
          integration: githubIntegration(),
          input: {}
        })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_not_found')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )

  it.effect('lists org issue fields with null options as empty', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              id: 10,
              name: 'Priority',
              description: null,
              data_type: 'single_select',
              options: [
                { id: 1, name: 'High', description: null, color: 'red' },
                { id: 2, name: 'Low', description: 'Later', color: null }
              ]
            },
            { id: 11, name: 'Notes', description: 'Free text', data_type: 'text', options: null }
          ]
        }
      ])

      const result = yield* githubListIssueFieldsAction
        .executeTyped({
          integration: githubIntegration(),
          input: {}
        })
        .pipe(Effect.provide(host.layer))

      expect(host.requests[0]?.method).toBe('GET')
      expect(host.requests[0]?.parsedUrl.pathname).toBe('/orgs/acme/issue-fields')
      expect(successValue(result)).toEqual({
        fields: [
          {
            id: 10,
            name: 'Priority',
            description: null,
            dataType: 'single_select',
            options: [
              { id: 1, name: 'High', description: null, color: 'red' },
              { id: 2, name: 'Low', description: 'Later', color: null }
            ]
          },
          { id: 11, name: 'Notes', description: 'Free text', dataType: 'text', options: [] }
        ]
      })
    })
  )

  it.effect('sets issue field values and normalizes the response', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        {
          body: [
            {
              issue_field_id: 10,
              issue_field_name: 'Title',
              data_type: 'text',
              value: 'Hello',
              single_select_option: null,
              multi_select_options: null
            },
            {
              issue_field_id: 11,
              data_type: 'number',
              value: 42
            },
            {
              issue_field_id: 12,
              data_type: 'single_select',
              single_select_option: { id: 1, name: 'High', color: 'red' }
            },
            {
              issue_field_id: 13,
              data_type: 'multi_select',
              multi_select_options: [
                { id: 2, name: 'A' },
                { id: 3, name: 'B' }
              ]
            }
          ]
        }
      ])

      const result = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            issueNumber: 7,
            values: [
              { fieldId: 10, text: 'Hello' },
              { fieldId: 11, number: 42 },
              { fieldId: 12, option: 'High' },
              { fieldId: 13, options: ['A', 'B'] },
              { fieldId: 14, date: '2026-03-10' }
            ]
          }
        })
        .pipe(Effect.provide(host.layer))

      const request = host.requests[0]

      expect(request?.method).toBe('POST')
      expect(request?.parsedUrl.pathname).toBe('/repos/acme/widgets/issues/7/issue-field-values')
      expect(request?.json).toEqual({
        issue_field_values: [
          { field_id: 10, value: 'Hello' },
          { field_id: 11, value: 42 },
          { field_id: 12, value: 'High' },
          { field_id: 13, value: ['A', 'B'] },
          { field_id: 14, value: '2026-03-10' }
        ]
      })

      const output = successValue(result)

      expect(output.issueNumber).toBe(7)
      expect(output.values).toEqual([
        { fieldId: 10, name: 'Title', dataType: 'text', value: 'Hello', number: null, options: [] },
        { fieldId: 11, name: null, dataType: 'number', value: null, number: 42, options: [] },
        {
          fieldId: 12,
          name: null,
          dataType: 'single_select',
          value: null,
          number: null,
          options: ['High']
        },
        {
          fieldId: 13,
          name: null,
          dataType: 'multi_select',
          value: null,
          number: null,
          options: ['A', 'B']
        }
      ])
    })
  )

  it.effect('rejects ambiguous, duplicate, and malformed field values before HTTP', () =>
    Effect.gen(function* () {
      const ambiguousHost = makeGithubHost()

      const ambiguous = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, values: [{ fieldId: 10, text: 'a', number: 1 }] }
        })
        .pipe(Effect.provide(ambiguousHost.layer), Effect.exit)

      const duplicateHost = makeGithubHost()

      const duplicate = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: {
            issueNumber: 7,
            values: [
              { fieldId: 10, text: 'a' },
              { fieldId: 10, text: 'b' }
            ]
          }
        })
        .pipe(Effect.provide(duplicateHost.layer), Effect.exit)

      const emptyHost = makeGithubHost()

      const empty = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, values: [{ fieldId: 10 }] }
        })
        .pipe(Effect.provide(emptyHost.layer), Effect.exit)

      const dateHost = makeGithubHost()

      const badDate = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, values: [{ fieldId: 10, date: 'March 10' }] }
        })
        .pipe(Effect.provide(dateHost.layer), Effect.exit)

      expect(Exit.isFailure(ambiguous)).toBe(true)
      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(Exit.isFailure(empty)).toBe(true)
      expect(Exit.isFailure(badDate)).toBe(true)
      expect(ambiguousHost.requests.length).toBe(0)
      expect(duplicateHost.requests.length).toBe(0)
      expect(emptyHost.requests.length).toBe(0)
      expect(dateHost.requests.length).toBe(0)
    })
  )

  it.effect('maps 422 to github_validation without leaking the token', () =>
    Effect.gen(function* () {
      const host = makeGithubHost([
        { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'custom' }] } }
      ])

      const result = yield* githubSetIssueFieldValuesAction
        .executeTyped({
          integration: githubIntegration(),
          input: { issueNumber: 7, values: [{ fieldId: 10, text: 'Hi' }] }
        })
        .pipe(Effect.provide(host.layer))

      const failure = failureOf(result)

      expect(failure.code).toBe('github_validation')
      expect(JSON.stringify(result)).not.toContain(githubTestToken)
    })
  )
})
