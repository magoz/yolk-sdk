import { Clock, Effect, Match, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { requiredStringConfig } from '../config.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import { ConnectorHttpClient, ConnectorHttpRequest, ConnectorHttpResponse } from '../http.ts'
import type { HttpMethod } from '../http.ts'
import type { ConnectorIntegration } from '../integration.ts'
import { ActionResult } from '../result.ts'
import type { ProviderFailureInput } from '../result.ts'

export const githubConnectorId = 'github'

export const githubTokenSlotId = 'github.token'

export const githubUploadTokenSlotId = 'github.upload_token'

export const githubApiBaseUrl = 'https://api.github.com'

export const githubUploadsBaseUrl = 'https://uploads.github.com'

export const githubApiVersion = '2026-03-10'

export const githubUserAgent = 'yolk-sdk-connectors'

export const githubJsonMediaType = 'application/vnd.github+json'

/** Installation token, PAT, or OAuth/user token. Used by every connector action. */
export const GithubTokenSlot = CredentialSlot.make({
  id: githubTokenSlotId,
  kind: 'bearer_token'
})

/**
 * Optional user token (OAuth user-to-server or PAT) used only by the host-only native
 * attachment upload helper. GitHub refuses installation (`ghs_`) tokens there.
 */
export const GithubUploadTokenSlot = CredentialSlot.make({
  id: githubUploadTokenSlotId,
  kind: 'bearer_token'
})

/** Text caps (UTF-16 code units). Larger provider text is cut and flagged `truncated`. */
export const githubBodyMaxChars = 20_000

export const githubListBodyMaxChars = 2_000

export const githubPatchMaxChars = 8_000

export const githubFileContentMaxChars = 100_000

// ---------------------------------------------------------------------------
// Repository scope
// ---------------------------------------------------------------------------

export type GithubRepoRef = {
  readonly owner: string
  readonly repo: string
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

const repoPattern = /^[A-Za-z0-9._-]{1,100}$/

export const isValidGithubOwner = (value: string) => ownerPattern.test(value)

export const isValidGithubRepo = (value: string) =>
  repoPattern.test(value) && value !== '.' && value !== '..' && !value.endsWith('.git')

/** Resolve and validate the integration-scoped `owner`/`repo`; the model never supplies them. */
export const resolveGithubRepo = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const owner = yield* requiredStringConfig(integration, 'owner')
    const repo = yield* requiredStringConfig(integration, 'repo')

    if (!isValidGithubOwner(owner) || !isValidGithubRepo(repo)) {
      return yield* Effect.fail(
        new ConnectorError({
          cause: 'validation_failed',
          message: 'Invalid GitHub owner/repo integration config',
          connectorId: integration.connectorId
        })
      )
    }

    return { owner, repo } satisfies GithubRepoRef
  })

/** `/repos/{owner}/{repo}` for a validated repo reference. */
export const githubRepoPath = (ref: GithubRepoRef) =>
  `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`

/** `/orgs/{owner}` for org-level issue types/fields. */
export const githubOrgPath = (ref: GithubRepoRef) => `/orgs/${encodeURIComponent(ref.owner)}`

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const headerSafeToken = /^[\x21-\x7e]+$/

const invalidCredential = (
  integration: ConnectorIntegration,
  slot: CredentialSlot,
  message: string
) =>
  Effect.fail(
    new ConnectorError({
      cause: 'credential_invalid',
      message,
      connectorId: integration.connectorId,
      slotId: slot.id
    })
  )

const resolveGithubSecret = (integration: ConnectorIntegration, slot: CredentialSlot) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    const token = yield* Match.value(credential).pipe(
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('ApiKeyCredential', current => Effect.succeed(current.key)),
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('UsernamePasswordCredential', () =>
        invalidCredential(
          integration,
          slot,
          'GitHub connector does not accept username/password credentials'
        )
      ),
      Match.exhaustive
    )

    // Never echo the token: only its shape is checked.
    if (!headerSafeToken.test(token)) {
      return yield* invalidCredential(integration, slot, 'GitHub token is not header-safe')
    }

    return token
  })

/** Token for every connector action (installation token, PAT, or OAuth token). */
export const resolveGithubToken = (integration: ConnectorIntegration) =>
  resolveGithubSecret(integration, GithubTokenSlot)

/**
 * User token for native attachment upload. Rejects GitHub App installation tokens
 * (`ghs_` prefix), which GitHub refuses on the uploads endpoint.
 */
export const resolveGithubUploadToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const token = yield* resolveGithubSecret(integration, GithubUploadTokenSlot)

    if (token.startsWith('ghs_')) {
      return yield* invalidCredential(
        integration,
        GithubUploadTokenSlot,
        'GitHub attachment upload requires a user token, not an installation token'
      )
    }

    return token
  })

export type GithubRequestContext = GithubRepoRef & {
  readonly token: string
}

/** Resolve repo scope then the `github.token` credential. */
export const resolveGithubContext = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const ref = yield* resolveGithubRepo(integration)
    const token = yield* resolveGithubToken(integration)

    return { ...ref, token } satisfies GithubRequestContext
  })

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type GithubQueryValue = string | number | boolean | undefined

export type GithubRequestInput = {
  readonly method: HttpMethod
  /** Absolute API path beginning with `/` (already percent-encoded per segment). */
  readonly path: string
  readonly query?: Readonly<Record<string, GithubQueryValue>>
  /** JSON body; serialized with `JSON.stringify` and sent as `application/json`. */
  readonly body?: unknown
  /** Override `Accept`, e.g. `application/vnd.github.raw+json`. */
  readonly accept?: string
}

export const githubHeaders = (token: string, accept: string = githubJsonMediaType) => ({
  authorization: `Bearer ${token}`,
  accept,
  'x-github-api-version': githubApiVersion,
  'user-agent': githubUserAgent
})

export const githubUrl = (
  path: string,
  query?: Readonly<Record<string, GithubQueryValue>>,
  baseUrl: string = githubApiBaseUrl
) => {
  const url = new URL(`${baseUrl}${path}`)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  return url.toString()
}

/** Single GitHub REST request through the host `ConnectorHttpClient`. */
export const githubRequest = (token: string, input: GithubRequestInput) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const url = githubUrl(input.path, input.query)
    const headers = githubHeaders(token, input.accept)

    const request =
      input.body === undefined
        ? ConnectorHttpRequest.make({ method: input.method, url, headers })
        : ConnectorHttpRequest.make({
            method: input.method,
            url,
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(input.body)
          })

    // Host transport errors may embed the request (and its bearer token): keep only the category.
    const response = yield* http.request(request).pipe(
      Effect.mapError(
        error =>
          new ConnectorError({
            cause: error.cause,
            message: `GitHub ${input.method} request failed before a response`,
            connectorId: githubConnectorId
          })
      )
    )

    return yield* redactGithubErrorBody(response, token)
  })

const redactText = (value: string, token: string) => value.split(token).join('[redacted]')

/** Walks whatever JSON.parse produced (incl. non-finite numbers); only strings/keys change. */
const redactDecoded = (value: unknown, token: string): unknown => {
  if (Predicate.isString(value)) return redactText(value, token)

  if (Array.isArray(value)) return value.map((item: unknown) => redactDecoded(item, token))

  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key, token),
        redactDecoded(item, token)
      ])
    )
  }

  return value
}

/**
 * Error bodies feed failure messages. Decode with the SAME `Schema.Unknown` JSON boundary that
 * `githubFailure` uses, redact every decoded string and key (so `\u`-escaped echoes are
 * caught), and fall back to raw-text redaction only for JSON syntax failures.
 */
const redactGithubErrorBody = (response: ConnectorHttpResponse, token: string) =>
  Effect.gen(function* () {
    if (isGithubSuccess(response.status)) return response

    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      response.body
    ).pipe(Effect.result)

    const body = Result.isSuccess(decoded)
      ? JSON.stringify(redactDecoded(decoded.success, token))
      : redactText(response.body, token)

    return body === response.body
      ? response
      : ConnectorHttpResponse.make({ status: response.status, headers: response.headers, body })
  })

/** Request relative to `/repos/{owner}/{repo}`; `path` is `''` or begins with `/`. */
export const githubRepoRequest = (context: GithubRequestContext, input: GithubRequestInput) =>
  githubRequest(context.token, { ...input, path: `${githubRepoPath(context)}${input.path}` })

export const isGithubSuccess = (status: number) => status >= 200 && status < 300

/** Case-insensitive single header lookup. */
export const githubHeader = (headers: Readonly<Record<string, string>>, name: string) => {
  const lower = name.toLowerCase()

  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1]
}

/** True when the RFC 8288 `Link` header advertises `rel="next"`. */
export const githubHasNextPage = (headers: Readonly<Record<string, string>>) => {
  const link = githubHeader(headers, 'link')

  if (link === undefined) return false

  return link.split(',').some(part =>
    part
      .split(';')
      .slice(1)
      .some(param => {
        const match = /^\s*rel\s*=\s*"?([^"]*)"?\s*$/i.exec(param)

        return match?.[1]?.toLowerCase().split(/\s+/).includes('next') ?? false
      })
  )
}

// ---------------------------------------------------------------------------
// Pagination / truncation
// ---------------------------------------------------------------------------

export const GithubPerPage = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

export const GithubPage = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Spread into list input structs: `{ ...githubPaginationFields, ... }`. */
export const githubPaginationFields = {
  perPage: Schema.optional(GithubPerPage),
  page: Schema.optional(GithubPage)
}

export const githubPaginationQuery = (input: {
  readonly perPage?: number | undefined
  readonly page?: number | undefined
}) => ({ per_page: input.perPage, page: input.page })

/**
 * True when a search query carries a scope qualifier (`repo:`, `org:`, `user:`, `owner:`),
 * including negated (`-repo:`) and grouped (`(repo:`) forms. GitHub ORs repeated `repo:`
 * qualifiers, so any of them could widen a repo-scoped search.
 */
export const githubHasScopeQualifier = (query: string) =>
  /(?:^|[\s(])[-!]?\s*(?:repo|org|user|owner)\s*:/i.test(query)

export const GithubIssueNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export type GithubTruncatedText = {
  readonly text: string
  readonly truncated: boolean
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
export const truncateGithubText = (value: string, max: number): GithubTruncatedText => {
  if (value.length <= max) return { text: value, truncated: false }

  const end = /[\ud800-\udbff]/.test(value.charAt(max - 1)) ? max - 1 : max

  return { text: value.slice(0, end), truncated: true }
}

// ---------------------------------------------------------------------------
// Provider failures
// ---------------------------------------------------------------------------

export type GithubFailureCode =
  | 'github_unauthorized'
  | 'github_forbidden'
  | 'github_not_found'
  | 'github_rate_limited'
  | 'github_validation'
  | 'github_conflict'
  | 'github_not_mergeable'
  | 'github_unsupported_content'
  | 'github_request_failed'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

const isJsonObject = Schema.is(JsonObject)

const decodeErrorBody = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
    Effect.result,
    Effect.map(result =>
      Result.isFailure(result) || !isJsonObject(result.success) ? undefined : result.success
    )
  )

const errorDetails = (errors: unknown) => {
  if (!Array.isArray(errors)) return []

  return errors.flatMap((entry: unknown) => {
    if (Predicate.isString(entry)) return [entry]

    if (!isJsonObject(entry)) return []

    const parts = [entry.resource, entry.field, entry.code, entry.message].filter(
      (part): part is string => Predicate.isString(part) && part !== ''
    )

    return parts.length === 0 ? [] : [parts.join(' ')]
  })
}

const retryAfterSeconds = (headers: Readonly<Record<string, string>>) => {
  const value = githubHeader(headers, 'retry-after')

  return value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined
}

const isRateLimited = (
  status: number,
  headers: Readonly<Record<string, string>>,
  message: string | undefined
) =>
  status === 429 ||
  (status === 403 &&
    (githubHeader(headers, 'x-ratelimit-remaining')?.trim() === '0' ||
      retryAfterSeconds(headers) !== undefined ||
      /rate limit/i.test(message ?? '')))

const retryAfterMs = (headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const seconds = retryAfterSeconds(headers)

    if (seconds !== undefined) {
      const ms = seconds * 1_000

      return Number.isSafeInteger(ms) ? ms : undefined
    }

    const reset = githubHeader(headers, 'x-ratelimit-reset')?.trim()

    if (reset === undefined || !/^\d+$/.test(reset)) return undefined

    const now = yield* Clock.currentTimeMillis
    const ms = Number(reset) * 1_000 - now

    return Number.isSafeInteger(ms) ? Math.max(0, ms) : undefined
  })

const codeForStatus = (status: number): GithubFailureCode => {
  switch (status) {
    case 401:
      return 'github_unauthorized'
    case 403:
      return 'github_forbidden'
    case 404:
    case 410:
      return 'github_not_found'
    case 409:
      return 'github_conflict'
    case 400:
    case 422:
      return 'github_validation'
    case 429:
      return 'github_rate_limited'
    default:
      return 'github_request_failed'
  }
}

export type GithubFailureOptions = {
  /** Short human operation label, e.g. `get issue`. */
  readonly operation: string
  /** Status-specific code overrides (e.g. merge `405` -> `github_not_mergeable`). */
  readonly codes?: Readonly<Partial<Record<number, GithubFailureCode>>>
}

/**
 * Map a non-2xx GitHub response to `ActionResult.failure` with a stable code.
 * `underlying` carries only GitHub's documentation URL and validation detail strings,
 * never request headers, tokens, or the raw body.
 */
export const githubFailure = (response: ConnectorHttpResponse, options: GithubFailureOptions) =>
  Effect.gen(function* () {
    const parsed = yield* decodeErrorBody(response.body)

    const detail =
      parsed !== undefined && Predicate.isString(parsed.message) && parsed.message.trim() !== ''
        ? parsed.message
        : undefined

    const details = parsed === undefined ? [] : errorDetails(parsed.errors)

    const rateLimited = isRateLimited(response.status, response.headers, detail)

    const code =
      options.codes?.[response.status] ??
      (rateLimited ? 'github_rate_limited' : codeForStatus(response.status))

    const base = `GitHub ${options.operation} failed (${response.status})`

    const documentationUrl =
      parsed !== undefined && Predicate.isString(parsed.documentation_url)
        ? parsed.documentation_url
        : undefined

    const failure: ProviderFailureInput = {
      code,
      message: [base, detail, ...details].filter(Predicate.isString).join(': '),
      status: response.status,
      retryAfterMs: rateLimited ? yield* retryAfterMs(response.headers) : undefined,
      underlying:
        documentationUrl === undefined && details.length === 0
          ? undefined
          : { documentationUrl, errors: details }
    }

    return ActionResult.failure(failure)
  })

// ---------------------------------------------------------------------------
// Shared wire + normalized shapes
// ---------------------------------------------------------------------------

export const GithubWireUser = Schema.Struct({
  login: Schema.String,
  type: Schema.optional(Schema.String)
})

const GithubWireLabel = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })
])

export const GithubWireMilestone = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.optional(Schema.String),
  due_on: Schema.optional(Schema.NullOr(Schema.String))
})

export const GithubWireIssue = Schema.Struct({
  id: Schema.Number,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(GithubWireUser)),
  labels: Schema.optional(Schema.Array(GithubWireLabel)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(GithubWireUser))),
  milestone: Schema.optional(Schema.NullOr(GithubWireMilestone)),
  type: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  locked: Schema.optional(Schema.Boolean),
  active_lock_reason: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.Number),
  pull_request: Schema.optional(Schema.Unknown),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String))
})

export type GithubWireIssue = typeof GithubWireIssue.Type

export const GithubMilestoneRef = Schema.Struct({
  number: Schema.Number,
  title: Schema.String
})

/** Normalized issue or pull-request-as-issue. Never a raw GitHub payload. */
export const GithubIssue = Schema.Struct({
  id: Schema.Number,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  isPullRequest: Schema.Boolean,
  type: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  milestone: Schema.NullOr(GithubMilestoneRef),
  locked: Schema.Boolean,
  lockReason: Schema.NullOr(Schema.String),
  comments: Schema.Number,
  body: Schema.NullOr(Schema.String),
  bodyTruncated: Schema.Boolean,
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String)
})

export type GithubIssue = typeof GithubIssue.Type

export const githubLogin = (user: { readonly login: string } | null | undefined) =>
  user === null || user === undefined ? null : user.login

export const githubLabelNames = (labels: ReadonlyArray<typeof GithubWireLabel.Type> | undefined) =>
  (labels ?? []).flatMap(label => {
    if (Predicate.isString(label)) return [label]

    return Predicate.isString(label.name) ? [label.name] : []
  })

export const normalizeGithubIssue = (
  issue: GithubWireIssue,
  bodyMaxChars: number = githubBodyMaxChars
): GithubIssue => {
  const body =
    issue.body === undefined || issue.body === null
      ? { text: null, truncated: false }
      : truncateGithubText(issue.body, bodyMaxChars)

  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
    type: issue.type?.name ?? null,
    author: githubLogin(issue.user),
    labels: githubLabelNames(issue.labels),
    assignees: (issue.assignees ?? []).map(user => user.login),
    milestone:
      issue.milestone === undefined || issue.milestone === null
        ? null
        : { number: issue.milestone.number, title: issue.milestone.title },
    locked: issue.locked ?? false,
    lockReason: issue.active_lock_reason ?? null,
    comments: issue.comments ?? 0,
    body: body.text,
    bodyTruncated: body.truncated,
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? null
  }
}
