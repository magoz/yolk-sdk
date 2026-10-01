/**
 * GitHub emulator API: the route table (evidence, raw parameter patterns, request-shape checks, and
 * stateful handlers), the fixture error bodies, object rendering, and `Link` paging (internal;
 * re-exported by `src/github.ts`).
 *
 * Only the REST routes the seven GitHub conformance cases send are emulated, on
 * `https://api.github.com`, with the wire shapes of their synthetic fixtures: the label listing
 * (with the paging fixture's `Link` header), issue read, create, rename, and close, the issue
 * search the validation fixture refuses, file contents (folded base64), comment create, listing
 * `since`, and delete, and issue label add and remove. Every route plans first (reading the state,
 * writing nothing) and commits only an eligible request: anything no fixture shows is not emulated
 * (400, nothing written, no fault used up).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  exactObject,
  isJsonObject,
  isNotEmulated,
  notEmulated,
  statefulRoute,
  type Commit,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import {
  githubFilePathPattern,
  githubLabelNamePattern,
  githubMaxIssueNumber,
  githubOwnerPattern,
  githubRepoPattern,
  githubTimestampPattern,
  mintedCommentNodeId,
  mintedIssueIdBase,
  mintedIssueNodeId,
  type GithubEmulatorComment,
  type GithubEmulatorIssue,
  type GithubEmulatorLabel,
  type GithubEmulatorState,
  type GithubEmulatorUser
} from './state.ts'

/** The origin every GitHub fixture records; another origin is not emulated. */
export const githubEmulatorOrigin = 'https://api.github.com'

/** The only `X-GitHub-Api-Version` the emulator answers (every fixture sends it). */
export const githubEmulatorApiVersion = '2026-03-10'

/** The only `Accept` the emulator answers (every fixture sends it). */
export const githubEmulatorAccept = 'application/vnd.github+json'

/** Content type of every GitHub JSON response, as the fixtures record it. */
const githubContentType = 'application/json; charset=utf-8'

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type GithubEmulatorDrills = {
  /** The first label page's `Link` lists no `rel="next"` while labels remain. */
  readonly linkOmitsNext?: boolean
  /** The not-found body of an unreached issue number lacks `documentation_url`. */
  readonly notFoundOmitsDocumentationUrl?: boolean
  /** The overlong search's validation body carries an empty `errors` array. */
  readonly validationWithoutErrors?: boolean
  /** File contents answer base64 on one line (not folded). */
  readonly contentUnfolded?: boolean
  /** A comment listing `since` excludes a comment updated at exactly that instant. */
  readonly sinceExcludesEqual?: boolean
  /** The label add answers the issue labels without the added label. */
  readonly addAnswerOmitsLabel?: boolean
  /** Closing an issue answers `closed_at: null`. */
  readonly closeWithoutClosedAt?: boolean
}

export const githubEmulatorDrillKnobs: ReadonlyArray<keyof GithubEmulatorDrills> = [
  'linkOmitsNext',
  'notFoundOmitsDocumentationUrl',
  'validationWithoutErrors',
  'contentUnfolded',
  'sinceExcludesEqual',
  'addAnswerOmitsLabel',
  'closeWithoutClosedAt'
]

export type GithubApiEnv = {
  /** Clock in epoch milliseconds (created issue and comment timestamps, close times). */
  readonly now: () => number
  readonly drills: Readonly<Record<keyof GithubEmulatorDrills, boolean>>
}

/**
 * The fixtures' error bodies, byte for byte (`JSON.stringify` keeps this key order): the issue
 * and comment 404s, the label-not-on-issue 404, and the overlong search's 422.
 */
export const githubEmulatorErrorBodies = {
  issueNotFound: {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/issues/issues#get-an-issue',
    status: '404'
  },
  commentNotFound: {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest/issues/comments#delete-an-issue-comment',
    status: '404'
  },
  labelNotOnIssue: {
    message: 'Label does not exist',
    documentation_url: 'https://docs.github.com/rest/issues/labels#remove-a-label-from-an-issue',
    status: '404'
  },
  searchTooLong: {
    message: 'Validation Failed',
    errors: [
      {
        message: 'The search is longer than 256 characters.',
        resource: 'Search',
        field: 'q',
        code: 'invalid'
      }
    ],
    documentation_url: 'https://docs.github.com/v3/search/',
    status: '422'
  }
} as const satisfies Readonly<Record<string, Schema.Json>>

type Route = StatefulRoute<GithubEmulatorState, GithubApiEnv>

const pagingCase = 'github.labels.list-link-paging'

const notFoundCase = 'github.errors.not-found-envelope'

const validationCase = 'github.errors.validation-envelope'

const contentsCase = 'github.contents.base64-file'

const commentCase = 'github.comments.create-delete'

const labelCase = 'github.labels.add-remove'

const lifecycleCase = 'github.issues.lifecycle-close'

// Raw (still percent-encoded) path parameter patterns: a request whose raw path is not exactly one
// of these shapes is unrecognised (ledgered with constant text only).

const repoParams = { owner: githubOwnerPattern, repo: githubRepoPattern }

const issueNumberPattern = /^[1-9][0-9]{0,9}$/

const commentIdPattern = /^[1-9][0-9]{0,14}$/

const filePathParam = new RegExp(`^(?=.{1,200}$)${githubFilePathPattern.source.slice(1)}`)

const evidence = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  params: Readonly<Record<string, RegExp>> = {}
) => ({
  method,
  path,
  kind: 'connector' as const,
  write,
  caseIds,
  evidence: 'unverified' as const,
  origin: githubEmulatorOrigin,
  params
})

const repoEvidence = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  params: Readonly<Record<string, RegExp>> = {}
) => evidence(method, `/repos/{owner}/{repo}${path}`, write, caseIds, { ...repoParams, ...params })

// Responses.

const json = (status: number, body: Schema.Json, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': githubContentType, ...headers }
  })

/** A read-only commit. */
const answer =
  (response: () => Response): Commit =>
  () =>
    response()

/** The current instant as GitHub writes it (whole seconds); throws for an unusable clock. */
const timestamp = (env: GithubApiEnv): string => {
  const text = new Date(env.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')

  if (!githubTimestampPattern.test(text)) throw new Error('the clock is out of range')

  return text
}

// Requests.

type RepoInput = { readonly owner: string; readonly repo: string }

const repoOf = (request: EmulatedRequest): RepoInput => ({
  owner: request.params.owner ?? '',
  repo: request.params.repo ?? ''
})

/** Not emulated unless the request names the seeded repository (exactly, as stored). */
const otherRepository = (state: GithubEmulatorState, input: RepoInput): NotEmulated | undefined =>
  state.repository.owner === input.owner && state.repository.repo === input.repo
    ? undefined
    : notEmulated('a repository other than the seeded one is not emulated')

/** Exactly the `required` query keys plus any `optional` ones, each once; or not emulated. */
const queryOf = (
  request: EmulatedRequest,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Readonly<Record<string, string>> | NotEmulated => {
  const keys = [...request.query.keys()]

  if (keys.length !== new Set(keys).size) {
    return notEmulated('repeated query parameters are not emulated')
  }

  const unknown = keys.find(key => !required.includes(key) && !optional.includes(key))

  if (unknown !== undefined) {
    return notEmulated(`query parameter ${unknown} is not emulated on this route`)
  }

  const missing = required.find(key => !keys.includes(key))

  return missing === undefined
    ? Object.fromEntries(request.query)
    : notEmulated(`requests without query parameter ${missing} are not emulated on this route`)
}

const withoutQuery = (request: EmulatedRequest): NotEmulated | undefined => {
  const query = queryOf(request, [])

  return isNotEmulated(query) ? query : undefined
}

const issueNumberOf = (request: EmulatedRequest): number => Number(request.params.issueNumber)

const nonEmptyString = (value: Schema.Json | undefined, label: string): string | NotEmulated =>
  Predicate.isString(value) && value.length > 0
    ? value
    : notEmulated(`${label} must be a non-empty string`)

// Rendering, in the fixture key order.

const repoApi = (state: GithubEmulatorState): string =>
  `${githubEmulatorOrigin}/repos/${state.repository.owner}/${state.repository.repo}`

const repoHtml = (state: GithubEmulatorState): string =>
  `https://github.com/${state.repository.owner}/${state.repository.repo}`

const renderUser = (user: GithubEmulatorUser): Schema.JsonObject => ({
  login: user.login,
  id: user.id,
  type: user.type,
  site_admin: user.siteAdmin
})

const renderLabel = (
  state: GithubEmulatorState,
  label: GithubEmulatorLabel
): Schema.JsonObject => ({
  id: label.id,
  node_id: label.nodeId,
  url: `${repoApi(state)}/labels/${encodeURIComponent(label.name)}`,
  name: label.name,
  color: label.color,
  default: label.default,
  description: label.description
})

const labelNamed = (state: GithubEmulatorState, name: string): GithubEmulatorLabel | undefined =>
  state.labels.find(label => label.name === name)

/** Labels by name, rendered (names the seed validated, or the add route checked). */
const renderLabels = (
  state: GithubEmulatorState,
  names: ReadonlyArray<string>
): ReadonlyArray<Schema.JsonObject> =>
  names.flatMap(name => {
    const label = labelNamed(state, name)

    return label === undefined ? [] : [renderLabel(state, label)]
  })

const renderIssue = (
  state: GithubEmulatorState,
  issue: GithubEmulatorIssue
): Schema.JsonObject => ({
  url: `${repoApi(state)}/issues/${issue.number}`,
  repository_url: repoApi(state),
  html_url: `${repoHtml(state)}/issues/${issue.number}`,
  id: issue.id,
  node_id: issue.nodeId,
  number: issue.number,
  title: issue.title,
  user: renderUser(issue.user),
  labels: [...renderLabels(state, issue.labels)],
  state: issue.state,
  locked: false,
  assignees: [],
  milestone: null,
  comments: 0,
  created_at: issue.createdAt,
  updated_at: issue.updatedAt,
  closed_at: issue.closedAt,
  author_association: issue.authorAssociation,
  active_lock_reason: null,
  body: issue.body,
  state_reason: issue.stateReason
})

/** Every fixture's issue answers `comments: 0`: an issue holding comments is not rendered. */
const commentsRefusal = (
  state: GithubEmulatorState,
  issue: GithubEmulatorIssue
): NotEmulated | undefined =>
  state.comments.some(comment => comment.issueNumber === issue.number)
    ? notEmulated(
        'an issue answer while the issue holds comments is not emulated (no fixture records one)'
      )
    : undefined

const renderComment = (
  state: GithubEmulatorState,
  comment: GithubEmulatorComment
): Schema.JsonObject => ({
  url: `${repoApi(state)}/issues/comments/${comment.id}`,
  html_url: `${repoHtml(state)}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  issue_url: `${repoApi(state)}/issues/${comment.issueNumber}`,
  id: comment.id,
  node_id: mintedCommentNodeId(comment.id),
  user: renderUser(comment.user),
  created_at: comment.createdAt,
  updated_at: comment.updatedAt,
  author_association: comment.authorAssociation,
  body: comment.body
})

/** Base64 of the UTF-8 text, folded every 60 characters with a trailing line break. */
const foldedBase64 = (text: string, folded: boolean): string => {
  let binary = ''

  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)

  const encoded = btoa(binary)

  return folded ? `${(encoded.match(/.{1,60}/g) ?? []).join('\n')}\n` : encoded
}

const issueHeld = (state: GithubEmulatorState, number: number): GithubEmulatorIssue | undefined =>
  state.issues.find(issue => issue.number === number)

const missingIssue = (): NotEmulated =>
  notEmulated('an issue the state does not hold is not emulated on this route')

// Routes.

type LabelsInput = RepoInput & { readonly perPage: number; readonly page: number }

const listLabels: Route = statefulRoute(
  repoEvidence('GET', '/labels', false, [pagingCase, labelCase]),
  'none',
  (request): LabelsInput | NotEmulated => {
    const query = queryOf(request, ['per_page'], ['page'])

    if (isNotEmulated(query)) return query

    const perPage = query.per_page ?? ''

    if (!/^[1-9][0-9]{0,2}$/.test(perPage) || Number(perPage) > 100) {
      return notEmulated('per_page must be an integer from 1 to 100')
    }

    const page = query.page

    // The fixtures ask for the first page without `page`.
    if (page !== undefined && (!/^[1-9][0-9]{0,5}$/.test(page) || Number(page) < 2)) {
      return notEmulated('page must be an integer of 2 or more (the first page omits it)')
    }

    return {
      ...repoOf(request),
      perPage: Number(perPage),
      page: page === undefined ? 1 : Number(page)
    }
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const count = state.labels.length

    if (count === 0) {
      return notEmulated('a label listing without labels is not emulated (no fixture records one)')
    }

    const last = Math.ceil(count / input.perPage)

    // The paging fixture records the page after the last (empty), never one further.
    if (input.page > last + 1) {
      return notEmulated('a label page beyond the one after the last is not emulated')
    }

    return answer(() => {
      const target = (page: number) =>
        `<${githubEmulatorOrigin}/repositories/${state.repository.id}/labels?per_page=${input.perPage}&page=${page}>`

      // The paging fixture's relations and order: prev, next, last, first.
      const relations = [
        input.page > 1 ? `${target(input.page - 1)}; rel="prev"` : undefined,
        input.page < last && !(env.drills.linkOmitsNext && input.page === 1)
          ? `${target(input.page + 1)}; rel="next"`
          : undefined,
        input.page === last ? undefined : `${target(last)}; rel="last"`,
        input.page > 1 ? `${target(1)}; rel="first"` : undefined
      ].filter(Predicate.isString)

      const start = (input.page - 1) * input.perPage

      return json(
        200,
        state.labels.slice(start, start + input.perPage).map(label => renderLabel(state, label)),
        // A listing that fits one page carries no Link, as the label fixture records.
        relations.length === 0 ? {} : { link: relations.join(', ') }
      )
    })
  }
)

type IssueInput = RepoInput & { readonly number: number }

const issueInput = (request: EmulatedRequest): IssueInput | NotEmulated =>
  withoutQuery(request) ?? { ...repoOf(request), number: issueNumberOf(request) }

const getIssue: Route = statefulRoute(
  repoEvidence('GET', '/issues/{issueNumber}', false, [notFoundCase, labelCase, lifecycleCase], {
    issueNumber: issueNumberPattern
  }),
  'none',
  issueInput,
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const issue = issueHeld(state, input.number)

    if (issue !== undefined) {
      return commentsRefusal(state, issue) ?? answer(() => json(200, renderIssue(state, issue)))
    }

    // A number the repository has not reached answers the not-found fixture's 404.
    if (input.number >= state.counters.nextIssueNumber) {
      return answer(() => {
        const { documentation_url: _url, ...withoutUrl } = githubEmulatorErrorBodies.issueNotFound

        return json(
          404,
          env.drills.notFoundOmitsDocumentationUrl
            ? withoutUrl
            : githubEmulatorErrorBodies.issueNotFound
        )
      })
    }

    return notEmulated('an issue below nextIssueNumber that the state does not hold is implied')
  }
)

/** The connector's repository qualifier, then the case's query. */
const scopedQueryPattern = /^repo:([^/\s]+)\/([^/\s]+) ([\s\S]*)$/

/** GitHub's documented search length limit, which the validation fixture refuses past. */
const searchLimit = 256

const searchIssues: Route = statefulRoute(
  evidence('GET', '/search/issues', false, [validationCase]),
  'none',
  (request): RepoInput | NotEmulated => {
    const query = queryOf(request, ['q'])

    if (isNotEmulated(query)) return query

    const scoped = scopedQueryPattern.exec(query.q ?? '')

    if (scoped === null) {
      return notEmulated(
        'a search without the leading repo:<owner>/<repo> qualifier is not emulated'
      )
    }

    // Only a refusal is recorded: a query after the qualifier of at most 256 characters would
    // answer results, which no fixture shows.
    return (scoped[3] ?? '').length > searchLimit
      ? { owner: scoped[1] ?? '', repo: scoped[2] ?? '' }
      : notEmulated(
          'a search of at most 256 characters is not emulated (no fixture records results)'
        )
  },
  (state, input, { env }) =>
    otherRepository(state, input) ??
    answer(() =>
      json(
        422,
        env.drills.validationWithoutErrors
          ? { ...githubEmulatorErrorBodies.searchTooLong, errors: [] }
          : githubEmulatorErrorBodies.searchTooLong
      )
    )
)

type FileInput = RepoInput & { readonly path: string }

const getContents: Route = statefulRoute(
  repoEvidence('GET', '/contents/{path+}', false, [contentsCase], { path: filePathParam }),
  'none',
  (request): FileInput | NotEmulated =>
    withoutQuery(request) ?? { ...repoOf(request), path: request.params.path ?? '' },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const file = state.files.find(candidate => candidate.path === input.path)

    if (file === undefined) {
      return notEmulated('a path naming no seeded file is not emulated (no fixture records one)')
    }

    return answer(() => {
      const { owner, repo, defaultBranch } = state.repository
      const name = file.path.split('/').at(-1) ?? file.path

      return json(200, {
        name,
        path: file.path,
        sha: file.sha,
        size: new TextEncoder().encode(file.text).byteLength,
        url: `${repoApi(state)}/contents/${file.path}?ref=${defaultBranch}`,
        html_url: `${repoHtml(state)}/blob/${defaultBranch}/${file.path}`,
        git_url: `${repoApi(state)}/git/blobs/${file.sha}`,
        download_url: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`,
        type: 'file',
        content: foldedBase64(file.text, !env.drills.contentUnfolded),
        encoding: 'base64'
      })
    })
  }
)

type CommentInput = IssueInput & { readonly body: string }

const createComment: Route = statefulRoute(
  repoEvidence('POST', '/issues/{issueNumber}/comments', true, [commentCase], {
    issueNumber: issueNumberPattern
  }),
  'json',
  (request): CommentInput | NotEmulated => {
    const issue = issueInput(request)

    if (isNotEmulated(issue)) return issue

    const body = exactObject(request.json, 'the comment body', ['body'])

    if (isNotEmulated(body)) return body

    const text = nonEmptyString(body.body, 'body')

    return isNotEmulated(text) ? text : { ...issue, body: text }
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const issue = issueHeld(state, input.number)

    if (issue === undefined) return missingIssue()

    if (issue.state !== 'open') {
      return notEmulated('commenting on a closed issue is not emulated (no fixture records one)')
    }

    return () => {
      // Read the clock before any write: a failing clock writes nothing.
      const at = timestamp(env)
      const id = state.counters.nextCommentId

      const comment: GithubEmulatorComment = {
        id,
        issueNumber: issue.number,
        body: input.body,
        user: state.viewer,
        authorAssociation: 'OWNER',
        createdAt: at,
        updatedAt: at
      }

      state.counters = { ...state.counters, nextCommentId: id + 1 }
      state.comments = [...state.comments, comment]

      return json(201, renderComment(state, comment))
    }
  }
)

type CommentsInput = IssueInput & { readonly since: number }

const listComments: Route = statefulRoute(
  repoEvidence('GET', '/issues/{issueNumber}/comments', false, [commentCase], {
    issueNumber: issueNumberPattern
  }),
  'none',
  (request): CommentsInput | NotEmulated => {
    const query = queryOf(request, ['per_page', 'since'])

    if (isNotEmulated(query)) return query

    // The fixture records one page of 100, without `page`.
    if (query.per_page !== '100') {
      return notEmulated('a comment listing per_page other than 100 is not emulated')
    }

    const since = query.since ?? ''
    const instant = githubTimestampPattern.test(since) ? Date.parse(since) : Number.NaN

    if (!Number.isFinite(instant)) {
      return notEmulated('since must be a timestamp of the form YYYY-MM-DDTHH:MM:SSZ')
    }

    return { ...repoOf(request), number: issueNumberOf(request), since: instant }
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    if (issueHeld(state, input.number) === undefined) return missingIssue()

    const listed = state.comments.filter(comment => {
      if (comment.issueNumber !== input.number) return false

      const updated = Date.parse(comment.updatedAt)

      return env.drills.sinceExcludesEqual ? updated > input.since : updated >= input.since
    })

    // The fixture records a listing of one comment and an empty one; the order of several is not
    // recorded.
    if (listed.length > 1) {
      return notEmulated('a comment listing of more than one comment is not emulated')
    }

    return answer(() =>
      json(
        200,
        listed.map(comment => renderComment(state, comment))
      )
    )
  }
)

type CommentIdInput = RepoInput & { readonly id: number }

const deleteComment: Route = statefulRoute(
  repoEvidence('DELETE', '/issues/comments/{commentId}', true, [commentCase], {
    commentId: commentIdPattern
  }),
  'none',
  (request): CommentIdInput | NotEmulated =>
    withoutQuery(request) ?? { ...repoOf(request), id: Number(request.params.commentId) },
  (state, input) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const comment = state.comments.find(candidate => candidate.id === input.id)

    if (comment !== undefined) {
      return () => {
        state.comments = state.comments.filter(candidate => candidate.id !== input.id)
        state.deletedComments = [...state.deletedComments, input.id]

        // The fixture's bodiless 204.
        return new Response(null, { status: 204 })
      }
    }

    // A comment deleted here answers the fixture's second-delete 404.
    return state.deletedComments.includes(input.id)
      ? answer(() => json(404, githubEmulatorErrorBodies.commentNotFound))
      : notEmulated('a comment this emulator never held is not emulated')
  }
)

type AddLabelInput = IssueInput & { readonly label: string }

/** GitHub orders label names case-insensitively; the fixture's answer is in that order. */
const sortsAfter = (name: string, other: string): boolean =>
  name.toLowerCase() > other.toLowerCase()

const addLabels: Route = statefulRoute(
  repoEvidence('POST', '/issues/{issueNumber}/labels', true, [labelCase], {
    issueNumber: issueNumberPattern
  }),
  'json',
  (request): AddLabelInput | NotEmulated => {
    const issue = issueInput(request)

    if (isNotEmulated(issue)) return issue

    const body = exactObject(request.json, 'the labels body', ['labels'])

    if (isNotEmulated(body)) return body

    const labels = body.labels

    if (!Array.isArray(labels) || labels.length !== 1) {
      return notEmulated('adding other than exactly one label is not emulated')
    }

    const [label] = labels

    return Predicate.isString(label) && githubLabelNamePattern.test(label)
      ? { ...issue, label }
      : notEmulated('the label must be a plain label name')
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const issue = issueHeld(state, input.number)

    if (issue === undefined) return missingIssue()

    if (issue.state !== 'open') {
      return notEmulated('labelling a closed issue is not emulated (no fixture records one)')
    }

    // Adding a label the repository lacks creates it, which no fixture records.
    if (labelNamed(state, input.label) === undefined) {
      return notEmulated('adding a label the repository does not have is not emulated')
    }

    if (issue.labels.includes(input.label)) {
      return notEmulated('adding a label the issue already has is not emulated')
    }

    // The fixture's answer is both the issue's labels with the new one appended and name order.
    if (!issue.labels.every(name => sortsAfter(input.label, name))) {
      return notEmulated('adding a label that does not sort after the issue labels is not emulated')
    }

    return () => {
      const labels = [...issue.labels, input.label]

      state.issues = state.issues.map(candidate =>
        candidate.number === issue.number ? { ...candidate, labels } : candidate
      )

      return json(200, [
        ...renderLabels(state, env.drills.addAnswerOmitsLabel ? issue.labels : labels)
      ])
    }
  }
)

const removeLabel: Route = statefulRoute(
  repoEvidence('DELETE', '/issues/{issueNumber}/labels/{name}', true, [labelCase], {
    issueNumber: issueNumberPattern,
    name: githubLabelNamePattern
  }),
  'none',
  (request): AddLabelInput | NotEmulated => {
    const issue = issueInput(request)

    return isNotEmulated(issue) ? issue : { ...issue, label: request.params.name ?? '' }
  },
  (state, input) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const issue = issueHeld(state, input.number)

    if (issue === undefined) return missingIssue()

    if (issue.state !== 'open') {
      return notEmulated('unlabelling a closed issue is not emulated (no fixture records one)')
    }

    if (labelNamed(state, input.label) === undefined) {
      return notEmulated('removing a label the repository does not have is not emulated')
    }

    // A repository label that is not on the issue answers the fixture's 404.
    if (!issue.labels.includes(input.label)) {
      return answer(() => json(404, githubEmulatorErrorBodies.labelNotOnIssue))
    }

    return () => {
      const labels = issue.labels.filter(name => name !== input.label)

      state.issues = state.issues.map(candidate =>
        candidate.number === issue.number ? { ...candidate, labels } : candidate
      )

      return json(200, [...renderLabels(state, labels)])
    }
  }
)

type CreateIssueInput = RepoInput & { readonly title: string; readonly body: string }

const createIssue: Route = statefulRoute(
  repoEvidence('POST', '/issues', true, [lifecycleCase]),
  'json',
  (request): CreateIssueInput | NotEmulated => {
    const query = withoutQuery(request)

    if (query !== undefined) return query

    const body = exactObject(request.json, 'the issue body', ['title', 'body'])

    if (isNotEmulated(body)) return body

    const title = nonEmptyString(body.title, 'title')

    if (isNotEmulated(title)) return title

    return Predicate.isString(body.body)
      ? { ...repoOf(request), title, body: body.body }
      : notEmulated('body must be a string')
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const number = state.counters.nextIssueNumber

    if (number > githubMaxIssueNumber) {
      return notEmulated('the repository has run out of emulated issue numbers')
    }

    return () => {
      // Read the clock before any write: a failing clock writes nothing.
      const at = timestamp(env)

      const issue: GithubEmulatorIssue = {
        number,
        id: mintedIssueIdBase + number,
        nodeId: mintedIssueNodeId(number),
        title: input.title,
        body: input.body,
        state: 'open',
        stateReason: null,
        labels: [],
        user: state.viewer,
        authorAssociation: 'OWNER',
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        createdHere: true
      }

      state.counters = { ...state.counters, nextIssueNumber: number + 1 }
      state.issues = [...state.issues, issue]

      return json(201, renderIssue(state, issue))
    }
  }
)

type UpdateIssueInput = IssueInput &
  ({ readonly change: 'rename'; readonly title: string } | { readonly change: 'close' })

const updateIssue: Route = statefulRoute(
  repoEvidence('PATCH', '/issues/{issueNumber}', true, [lifecycleCase], {
    issueNumber: issueNumberPattern
  }),
  'json',
  (request): UpdateIssueInput | NotEmulated => {
    const issue = issueInput(request)

    if (isNotEmulated(issue)) return issue

    const body = request.json

    if (!isJsonObject(body)) return notEmulated('the update body must be a JSON object')

    const keys = Object.keys(body).sort().join(',')

    // The two recorded updates: a rename, and closing as completed.
    if (keys === 'title') {
      const title = nonEmptyString(body.title, 'title')

      return isNotEmulated(title) ? title : { ...issue, change: 'rename', title }
    }

    if (keys === 'state,state_reason') {
      return body.state === 'closed' && body.state_reason === 'completed'
        ? { ...issue, change: 'close' }
        : notEmulated('state changes other than closed as completed are not emulated')
    }

    return notEmulated(
      'issue updates other than { title } or { state, state_reason } are not emulated'
    )
  },
  (state, input, { env }) => {
    const other = otherRepository(state, input)

    if (other !== undefined) return other

    const issue = issueHeld(state, input.number)

    if (issue === undefined || !issue.createdHere) {
      return notEmulated('updating an issue not created here is not emulated')
    }

    if (issue.state !== 'open') {
      return notEmulated('updating a closed issue is not emulated (no fixture records one)')
    }

    const refusal = commentsRefusal(state, issue)

    if (refusal !== undefined) return refusal

    return () => {
      // Read the clock before any write: a failing clock writes nothing. A rename keeps
      // `updated_at`, as the lifecycle fixture records.
      const updated: GithubEmulatorIssue =
        input.change === 'rename'
          ? { ...issue, title: input.title }
          : (() => {
              const at = timestamp(env)

              return {
                ...issue,
                state: 'closed',
                stateReason: 'completed',
                closedAt: at,
                updatedAt: at
              }
            })()

      state.issues = state.issues.map(candidate =>
        candidate.number === issue.number ? updated : candidate
      )

      const rendered = renderIssue(state, updated)

      return json(
        200,
        input.change === 'close' && env.drills.closeWithoutClosedAt
          ? { ...rendered, closed_at: null }
          : rendered
      )
    }
  }
)

/** The route table: evidence plus handlers. `githubEmulatorRoutes` is its evidence part. */
export const githubApiRoutes: ReadonlyArray<Route> = [
  listLabels,
  getIssue,
  searchIssues,
  getContents,
  createComment,
  listComments,
  deleteComment,
  addLabels,
  removeLabel,
  createIssue,
  updateIssue
]
