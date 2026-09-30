/**
 * Shared synthetic shapes of the GitHub fixtures (internal, except the long search query): the
 * practice repository, request headers the connector sends, and issue, comment, and label answers
 * shaped like the GitHub REST API. Synthetic data only; never recorded from a live repository.
 */
import type * as Schema from 'effect/Schema'
import type { WireHeaders, WireResponse } from '@yolk-sdk/conformance/fixture'

export const githubSyntheticApi = 'https://api.github.com'

export const githubSyntheticRepoApi = `${githubSyntheticApi}/repos/yolk-synthetic/conformance-practice`

const githubSyntheticHtml = 'https://github.com/yolk-synthetic/conformance-practice'

/**
 * A search longer than GitHub's 256-character limit, synthetic words only (the validation-envelope
 * case sends it through `github.search_issues`).
 */
export const githubConformanceLongSearchQuery = Array.from(
  { length: 20 },
  () => 'yolk-conformance'
).join(' ')

/** The URL the connector builds for `path` and `query` (percent-encoded like `URLSearchParams`). */
export const githubSyntheticUrl = (
  path: string,
  query: Readonly<Record<string, string>> = {}
): string => {
  const url = new URL(`${githubSyntheticApi}${path}`)

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }

  return url.toString()
}

/** The recorded request headers of a connector request (credential headers are never recorded). */
export const githubRequestHeaders: WireHeaders = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2026-03-10'
}

/** The recorded request headers of a connector request with a JSON body. */
export const githubJsonRequestHeaders: WireHeaders = {
  ...githubRequestHeaders,
  'content-type': 'application/json'
}

export const githubJson = (
  status: number,
  body: Schema.Json,
  headers: WireHeaders = {}
): WireResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(body)
})

export const githubNoContent: WireResponse = { status: 204, headers: {}, body: '' }

/** GitHub's JSON error body. */
export const githubErrorBody = (
  message: string,
  documentationUrl: string,
  status: number
): Schema.Json => ({ message, documentation_url: documentationUrl, status: String(status) })

const syntheticUser = {
  login: 'yolk-synthetic-bot',
  id: 1000001,
  type: 'User',
  site_admin: false
}

/** A repository label as the labels endpoints answer it. */
export const githubSyntheticLabel = (id: number, name: string, color: string) => ({
  id,
  node_id: `LA_kwSynthetic${id}`,
  url: `${githubSyntheticRepoApi}/labels/${encodeURIComponent(name)}`,
  name,
  color,
  default: false,
  description: `Synthetic ${name} label`
})

/** An issue as the issues endpoints answer it. */
export const githubSyntheticIssue = (fields: {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly stateReason?: string
  readonly labels?: ReadonlyArray<ReturnType<typeof githubSyntheticLabel>>
  readonly body?: string
  readonly closedAt?: string
  readonly updatedAt?: string
}): Schema.Json => ({
  url: `${githubSyntheticRepoApi}/issues/${fields.number}`,
  repository_url: githubSyntheticRepoApi,
  html_url: `${githubSyntheticHtml}/issues/${fields.number}`,
  id: 3_000_000_000 + fields.number,
  node_id: `I_kwSynthetic${fields.number}`,
  number: fields.number,
  title: fields.title,
  user: syntheticUser,
  labels: [...(fields.labels ?? [])],
  state: fields.state,
  locked: false,
  assignees: [],
  milestone: null,
  comments: 0,
  created_at: '2026-09-30T12:00:00Z',
  updated_at: fields.updatedAt ?? '2026-09-30T12:00:00Z',
  closed_at: fields.closedAt ?? null,
  author_association: 'OWNER',
  active_lock_reason: null,
  body: fields.body ?? null,
  state_reason: fields.stateReason ?? null
})

/** An issue comment as the comments endpoints answer it. */
export const githubSyntheticComment = (fields: {
  readonly id: number
  readonly issueNumber: number
  readonly body: string
  readonly createdAt: string
}): Schema.Json => ({
  url: `${githubSyntheticRepoApi}/issues/comments/${fields.id}`,
  html_url: `${githubSyntheticHtml}/issues/${fields.issueNumber}#issuecomment-${fields.id}`,
  issue_url: `${githubSyntheticRepoApi}/issues/${fields.issueNumber}`,
  id: fields.id,
  node_id: `IC_kwSynthetic${fields.id}`,
  user: syntheticUser,
  created_at: fields.createdAt,
  updated_at: fields.createdAt,
  author_association: 'OWNER',
  body: fields.body
})
