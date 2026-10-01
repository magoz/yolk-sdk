/**
 * GitHub conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the GitHub connector relies on, running the REAL connector
 * actions over the connector ports (`ConnectorHttpClient`, `CredentialResolver`) plus the
 * host-supplied `GithubConformanceConfig` seeds (the practice repository's `owner` and `repo`, and
 * a few seeded items in it). Claims about response bodies the actions only partly read are observed
 * by wrapping the host's `ConnectorHttpClient` (the cases send no request of their own). The same
 * cases run on replay fixtures, an emulator, or by hand against a practice repository. None is
 * observed live yet (`observed` absent = unverified); sub-claims no live run has settled are marked
 * "(unverified: ...)" in their `wire`.
 *
 * Write ownership. Every write names the per-invocation `runId` seed (`run-<hex>`; fixtures replay
 * with `run-synthetic`, the live runner generates a fresh one each time) or works only on the seeded
 * work issue and label:
 *
 * - The comment case posts a `yolk-conformance <runId> comment` on the seeded work issue and
 *   deletes it again by id (write-reversible).
 * - The label case adds the seeded label to the seeded work issue and removes it again. It starts
 *   only when the label is NOT on the issue yet (so it never removes a label it did not add) and
 *   when the label already exists in the repository (adding a missing label would create it, which
 *   the connector cannot undo). Concurrent runs of this case are not supported (write-reversible).
 * - The lifecycle case opens an issue titled `yolk-conformance <runId> lifecycle ...` and closes
 *   it. GitHub issues cannot be deleted through the REST API (the connector has no delete), so the
 *   closed issue stays in the repository: the case is `write-irreversible` and runs only when a
 *   person names its exact id.
 *
 * The create request (comment create, label add, issue create), its decoding, its classification,
 * and the registration of what it created run uninterruptibly together. A definitive rejection
 * (HTTP 4xx other than 408) changed nothing: the case fails and undoes NOTHING. An ambiguous outcome
 * (a transport or decoding failure, no status, HTTP 408, or HTTP 5xx) may have written anyway
 * without the case learning what: it fails with `GithubConformanceActionFailed`
 * (`writeOutcome: 'unknown'`) naming the exact item to check by hand, and undoes nothing. A create
 * that answers an item outside the run namespace (a comment without the requested body, an issue
 * without the requested title, a pull request, or the seeded work issue) is never adopted:
 * `GithubConformanceCleanupRefused`. Every later write is masked too, so an aborted request cannot
 * land after the cleanup. The cleanup undoes by id (comment id, issue number, or the seeded issue and
 * label) and then verifies the result; a failed cleanup is reported as
 * `GithubConformanceRestoreFailed` naming the item (never swallowed), also through the
 * `ConformanceCleanupReporter` when the case is being interrupted. Neither the runner nor the
 * bridges set a request timeout, so a hanging request delays an interruption until it answers.
 * `findGithubConformanceLeftovers` lists (read-only) what earlier runs left behind.
 */
import { Context, Data, Effect, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import {
  withOwnedWrite as sharedWithOwnedWrite,
  type OwnedWrite as SharedOwnedWrite,
  type OwnedWriteErrors
} from '../../conformance/owned-write.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import { ConnectorHttpClient, type ConnectorHttpResponse } from '../../http.ts'
import { makeIntegration, type ConnectorIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  githubAddLabelsAction,
  githubCreateIssueAction,
  githubCreateIssueCommentAction,
  githubDeleteIssueCommentAction,
  githubGetFileContentsAction,
  githubGetIssueAction,
  githubListIssueCommentsAction,
  githubListIssuesAction,
  githubListLabelsAction,
  githubRemoveLabelAction,
  githubSearchIssuesAction,
  githubUpdateIssueAction,
  type GithubComment,
  type GithubIssue
} from '../index.ts'
import {
  githubConnectorId,
  githubTokenSlotId,
  isValidGithubOwner,
  isValidGithubRepo
} from '../shared.ts'
import { githubCommentLifecycleFixture } from './comment-lifecycle.ts'
import { githubFileContentsFixture } from './file-contents.ts'
import { githubIssueLabelsFixture } from './issue-labels.ts'
import { githubIssueLifecycleFixture } from './issue-lifecycle.ts'
import { githubLabelsPagingFixture } from './labels-paging.ts'
import { githubNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { githubConformanceLongSearchQuery } from './synthetic.ts'
import { githubValidationEnvelopeFixture } from './validation-envelope.ts'

const Owner = Schema.String.check(Schema.makeFilter(isValidGithubOwner))

const Repo = Schema.String.check(Schema.makeFilter(isValidGithubRepo))

/** An issue number, as a decimal string (seeds are strings). */
const IssueNumber = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,9}$/))

/** A label name in plain characters (no spaces, not dot-only). */
const LabelName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/))

/** A relative file path whose segments never start with a dot (no `.`/`..` segments). */
const FilePath = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/),
  Schema.isMaxLength(200)
)

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seeds for the practice repository. Cases never hard-code account data. A case whose
 * required seed is missing fails with a `precondition:` `ConformanceMismatch` before any request.
 */
export const GithubConformanceSeeds = Schema.Struct({
  /** Owner (user or organization) of the practice repository: integration config `owner`. */
  owner: Schema.optionalKey(Owner),
  /** The practice repository (3 to 20 labels): integration config `repo`. */
  repo: Schema.optionalKey(Repo),
  /**
   * An open practice issue (not a pull request) that nobody else watches, which the comment and
   * label cases work on: they post and delete their own comment there, and add and remove the
   * `labelName` label. Its subscribers are notified of each comment, and every label add and
   * remove stays on its timeline.
   */
  workIssueNumber: Schema.optionalKey(IssueNumber),
  /** An existing repository label that is NOT on the work issue. */
  labelName: Schema.optionalKey(LabelName),
  /**
   * A UTF-8 text file in the default branch: more than 45 bytes, at least one non-ASCII
   * character, and under 100,000 characters (the connector truncates longer content).
   */
  filePath: Schema.optionalKey(FilePath),
  /**
   * Invocation-unique segment of every comment body and issue title a case writes. Replay uses the
   * fixed synthetic id of the fixtures; the live runner generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type GithubConformanceSeeds = typeof GithubConformanceSeeds.Type

export type GithubConformanceSeedKey = keyof GithubConformanceSeeds

/** Host-supplied seeds for the GitHub conformance cases. */
export class GithubConformanceConfig extends Context.Service<
  GithubConformanceConfig,
  GithubConformanceSeeds
>()('@yolk-sdk/connectors/github/conformance/GithubConformanceConfig') {}

/**
 * Credential reference the cases bind to the `github.token` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves it
 * to a GitHub token for the practice repository.
 */
export const githubConformanceCredentialRef = 'github.conformance'

/** The integration a GitHub conformance case invokes the connector with (`owner`/`repo` config). */
export const githubConformanceIntegration = (owner: string, repo: string): ConnectorIntegration =>
  makeIntegration({
    connectorId: githubConnectorId,
    config: { owner, repo },
    credentialBindings: [
      makeCredentialBinding({
        slotId: githubTokenSlotId,
        credentialRef: githubConformanceCredentialRef
      })
    ]
  })

/** Synthetic marker every case-written comment body and issue title starts with. */
export const githubConformanceMarker = 'yolk-conformance'

/** Prefix of every run-scoped comment body and issue title: `yolk-conformance run-`. */
export const githubConformanceRunPrefix = `${githubConformanceMarker} run-`

/**
 * A connector action failed where the case needed success. `code` and `status` keep the underlying
 * classification (a `ConnectorError` cause such as `transport_failed`, or a provider failure code).
 *
 * `writeOutcome: 'unknown'` marks an ambiguous write (a transport or decoding failure, no status,
 * HTTP 408, or HTTP 5xx): GitHub may have written without the case learning what, so the message
 * carries `recovery`, the exact item to check by hand.
 */
export class GithubConformanceActionFailed extends Data.TaggedError(
  'GithubConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly writeOutcome?: 'unknown'
  readonly recovery?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.writeOutcome === 'unknown'
        ? `; write outcome unknown: ${this.recovery ?? 'check the practice repository by hand'}`
        : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/**
 * A write answered an item outside the run namespace. The case never undoes anything outside its
 * own namespace, so nothing was changed there: check `item` by hand.
 */
export class GithubConformanceCleanupRefused extends Data.TaggedError(
  'GithubConformanceCleanupRefused'
)<{
  readonly caseId: string
  readonly item: string
}> {
  override get message(): string {
    return `${this.caseId}: cleanup refused; a write answered ${this.item}, outside the run namespace, so nothing was undone there; check it by hand.`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Undoing what a write case created failed. `recovery` says what to do by hand; `caseOutcome` says
 * whether the claim itself held before the restore; `claimFailure` is a sanitized summary of why it
 * failed.
 */
export class GithubConformanceRestoreFailed extends Data.TaggedError(
  'GithubConformanceRestoreFailed'
)<{
  readonly caseId: string
  readonly recovery: string
  readonly reason: string
  readonly caseOutcome: 'claim held' | 'claim failed'
  readonly claimFailure?: string
}> {
  override get message(): string {
    const claim =
      this.caseOutcome === 'claim held'
        ? 'Claim held first.'
        : this.claimFailure === undefined
          ? 'Claim failed first.'
          : `Claim failed first: ${this.claimFailure}`

    // Conformance reports cap failure messages at 300 characters: the advice comes first.
    return `${this.caseId}: restore failed; ${this.recovery}. Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type GithubConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | GithubConformanceActionFailed
  | GithubConformanceCleanupRefused
  | GithubConformanceRestoreFailed

/** What every GitHub conformance case requires from the host. */
export type GithubConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | GithubConformanceConfig

export type GithubConformanceCase = ConformanceCase<
  GithubConformanceError,
  GithubConformanceRequirements
>

const requireSeed = <K extends GithubConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* GithubConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: GithubConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

/** The integration for the seeded practice repository. */
const repoIntegration = Effect.gen(function* () {
  const owner = yield* requireSeed('owner')
  const repo = yield* requireSeed('repo')

  return githubConformanceIntegration(owner, repo)
})

const requireIssueNumber = Effect.map(requireSeed('workIssueNumber'), Number)

const successValue =
  (actionId: string) =>
  <A>(result: ActionResult<A>): Effect.Effect<A, GithubConformanceActionFailed> => {
    if (Predicate.isTagged(result, 'Success')) {
      return Effect.succeed(result.value)
    }

    const { code, status } = result.error

    return Effect.fail(
      status === undefined
        ? new GithubConformanceActionFailed({ actionId, code })
        : new GithubConformanceActionFailed({ actionId, code, status })
    )
  }

/** The provider failure of a result, or `undefined` for a success. */
const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** `code status` of a result for mismatch details (`success` for a success). */
const outcomeOf = <A>(result: ActionResult<A>): string => {
  const failure = failureOf(result)

  return failure === undefined ? 'success' : `${failure.code} ${failure.status ?? 'no-status'}`
}

const isNotFound = <A>(result: ActionResult<A>): boolean =>
  failureOf(result)?.code === 'github_not_found'

/**
 * Run `effect` with the host's `ConnectorHttpClient` wrapped so every response is observed; the
 * requests and responses are the host's own, unchanged.
 */
const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const responses = yield* Ref.make<ReadonlyArray<ConnectorHttpResponse>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        http
          .request(request)
          .pipe(Effect.tap(response => Ref.update(responses, list => [...list, response])))
    })

    const value = yield* effect.pipe(Effect.provideService(ConnectorHttpClient, observing))

    return { value, responses: yield* Ref.get(responses) }
  })

/** Decode a JSON text body with `schema`, or `undefined`. */
const decodeBody = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  body: string | undefined
): Effect.Effect<A | undefined> =>
  body === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )

// Connector action shorthands (each resolves the seeded repository first).

const getIssue = (issueNumber: number) =>
  Effect.flatMap(repoIntegration, integration =>
    githubGetIssueAction.executeTyped({ integration, input: { issueNumber } })
  )

const listLabels = (perPage: number, page?: number) =>
  Effect.flatMap(repoIntegration, integration =>
    githubListLabelsAction
      .executeTyped({ integration, input: page === undefined ? { perPage } : { perPage, page } })
      .pipe(Effect.flatMap(successValue(githubListLabelsAction.id)))
  )

const updateIssue = (input: {
  readonly issueNumber: number
  readonly title?: string
  readonly state?: 'open' | 'closed'
  readonly stateReason?: 'completed' | 'not_planned'
}) =>
  Effect.flatMap(repoIntegration, integration =>
    githubUpdateIssueAction.executeTyped({ integration, input })
  )

const deleteComment = (commentId: number) =>
  Effect.flatMap(repoIntegration, integration =>
    githubDeleteIssueCommentAction.executeTyped({ integration, input: { commentId } })
  )

const removeLabel = (issueNumber: number, label: string) =>
  Effect.flatMap(repoIntegration, integration =>
    githubRemoveLabelAction.executeTyped({ integration, input: { issueNumber, label } })
  )

// Owned writes: the shared `withOwnedWrite` (`../../conformance/owned-write.ts`) runs the create,
// its decoding, its classification, and the registration uninterruptibly together; the cleanup
// undoes by id and verifies.

const githubWriteErrors: OwnedWriteErrors<
  GithubConformanceActionFailed,
  GithubConformanceCleanupRefused,
  GithubConformanceRestoreFailed
> = {
  actionFailed: fields => new GithubConformanceActionFailed(fields),
  cleanupRefused: fields => new GithubConformanceCleanupRefused(fields),
  restoreFailed: fields => new GithubConformanceRestoreFailed(fields),
  isActionFailed: (value): value is GithubConformanceActionFailed =>
    value instanceof GithubConformanceActionFailed
}

type OwnedWrite<T, A, E, R> = Omit<
  SharedOwnedWrite<T, A, E, R, GithubConformanceRequirements, never, GithubConformanceRequirements>,
  'refuse'
> & {
  /** The item, when the answer lies outside the run namespace (never adopted), else `undefined`. */
  readonly refuse: (value: T) => string | undefined
}

/**
 * Create one owned item, run `use`, then ALWAYS undo it while `pending` (see
 * `../../conformance/owned-write.ts`). A definitive create rejection undoes nothing; an ambiguous
 * one is reported with `unknownRecovery`; an answer outside the run namespace is refused. A failed
 * restore fails the case with `GithubConformanceRestoreFailed`, which says whether the claim itself
 * held; otherwise the outcome of `use` is returned unchanged.
 */
const withOwnedWrite = <T, A, E, R>(spec: OwnedWrite<T, A, E, R>) =>
  sharedWithOwnedWrite(githubWriteErrors, {
    ...spec,
    refuse: value => Effect.succeed(spec.refuse(value))
  })

/** `<marker> <runId> <kind>: <text>`, the run-scoped text of a comment body or issue title. */
const runText = (kind: string, text: string) =>
  Effect.map(requireSeed('runId'), runId => `${githubConformanceMarker} ${runId} ${kind}: ${text}`)

// Read cases.

/** Label listing page size, and the page cap. */
const labelPageSize = 2

const pageCap = 10

export const githubLabelsPagingCase: GithubConformanceCase = defineConformanceCase({
  id: 'github.labels.list-link-paging',
  title: 'A label listing larger than per_page advertises rel="next" until its last page',
  safety: 'read',
  docs: '`github.list_labels` sends GET /repos/{owner}/{repo}/labels with `per_page` and `page` query parameters and reports `hasNextPage` from the RFC 8288 `Link` response header (true when it lists `rel="next"`); like every GitHub list action it never follows the `Link` URL itself: callers ask for the next `page` number.',
  wire: '`github.list_labels` with `perPage: 2` for a repository with more than two labels answers two labels and a `Link` header listing `rel="next"` (`hasNextPage: true`); asking for `page` 2, 3, and so on returns further labels (none repeated within a page or across pages, compared by name), and the page whose `Link` lists no `rel="next"` is really the last: the page after it answers no labels. So a `rel="next"` missing while labels remain fails the case.',
  fixtures: [githubLabelsPagingFixture.id],
  run: Effect.gen(function* () {
    const seen: Array<string> = []
    let page = 1

    for (;;) {
      const listing = yield* listLabels(labelPageSize, page === 1 ? undefined : page)
      const names = listing.labels.map(label => label.name)

      yield* expectConformance(
        names.length <= labelPageSize,
        'expected at most per_page labels on every page',
        { actual: names.length }
      )
      yield* expectConformance(
        new Set(names).size === names.length,
        'expected every page to list each label once'
      )
      yield* expectConformance(
        names.every(name => !seen.includes(name)),
        'expected a later page to repeat no label from an earlier page'
      )
      seen.push(...names)

      if (!listing.hasNextPage) {
        break
      }

      if (page >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: the repository has more than ${pageCap * labelPageSize} labels; use a smaller one`
        })
      }

      page += 1
    }

    const after = yield* listLabels(labelPageSize, page + 1)

    yield* expectConformance(
      after.labels.length === 0,
      `expected page ${page + 1}, after a page whose Link lists no rel="next", to answer no labels`,
      { actual: after.labels.length }
    )
    yield* expectConformance(
      seen.length > labelPageSize,
      'precondition: the practice repository needs more than two labels'
    )
  })
})

/** An issue number the practice repository has not reached (synthetic, never account data). */
const absentIssueNumber = 99_999_999

/** The error body fields the connector reads first: `message` and `documentation_url`. */
const GithubNotFoundBody = Schema.Struct({
  message: Schema.NonEmptyString,
  documentation_url: Schema.String
})

/** `[documentationUrl, number of errors]` of a failure's `underlying`, or `null`. */
const underlyingDetails = (underlying: unknown): readonly [string, number] | null =>
  Predicate.hasProperty(underlying, 'documentationUrl') &&
  Predicate.hasProperty(underlying, 'errors') &&
  Predicate.isString(underlying.documentationUrl) &&
  Array.isArray(underlying.errors)
    ? [underlying.documentationUrl, underlying.errors.length]
    : null

export const githubNotFoundEnvelopeCase: GithubConformanceCase = defineConformanceCase({
  id: 'github.errors.not-found-envelope',
  title: 'An unused issue number answers not found with a JSON message and documentation_url',
  safety: 'read',
  docs: 'The connector maps a non-2xx GitHub answer by HTTP status (401 `github_unauthorized`; 403 `github_forbidden`, or `github_rate_limited` when the rate limit is exhausted; 404 and 410 `github_not_found`; 409 `github_conflict`; 400 and 422 `github_validation`; 429 `github_rate_limited`), appends the JSON body `message` to its failure message (`GitHub <operation> failed (<status>): <message>`), and keeps only `documentation_url` and the `errors` details as `underlying`.',
  wire: '`github.get_issue` of issue number 99999999, which the practice repository has not reached, answers a status the connector maps to `github_not_found` (404 or 410; unverified: that an unused number answers 404 rather than another status) with a JSON body whose `message` is a non-empty string and whose `documentation_url` is a string (observed at the `ConnectorHttpClient` port), so the connector message starts with `GitHub get issue failed (<status>): <message>` and `underlying.documentationUrl` is that `documentation_url` (any `errors` details are not checked).',
  fixtures: [githubNotFoundEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const { value, responses } = yield* observed(getIssue(absentIssueNumber))
    const failure = failureOf(value)

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected github.get_issue of an unused issue number to fail'
      })
    }

    yield* expectConformance(
      failure.code === 'github_not_found',
      'expected an unused issue number to map to github_not_found',
      { actual: outcomeOf(value) }
    )

    const body = yield* decodeBody(GithubNotFoundBody, responses.at(-1)?.body)

    if (body === undefined) {
      return yield* new ConformanceMismatch({
        message:
          'expected the not-found body to be JSON with a non-empty message and a documentation_url'
      })
    }

    yield* expectConformance(
      failure.message.startsWith(
        `GitHub get issue failed (${failure.status ?? 'no-status'}): ${body.message}`
      ),
      'expected the connector message to start with the body message'
    )
    yield* expectEqual(
      underlyingDetails(failure.underlying)?.[0] ?? null,
      body.documentation_url,
      'expected underlying.documentationUrl to carry the body documentation_url'
    )
  })
})

/** The validation body fields the connector reads: `message` and a non-empty `errors` array. */
const GithubValidationBody = Schema.Struct({
  message: Schema.NonEmptyString,
  errors: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1))
})

export const githubValidationEnvelopeCase: GithubConformanceCase = defineConformanceCase({
  id: 'github.errors.validation-envelope',
  title: 'A refused search answers github_validation with errors details the connector reads',
  safety: 'read',
  docs: 'The connector maps 400 and 422 to `github_validation`, appends the body `message` and then one detail per `errors` entry (the entry itself when it is a string, else its string `resource`, `field`, `code`, and `message` joined by spaces) to its failure message, and keeps the details as `underlying.errors`. `github.search_issues` prefixes `repo:{owner}/{repo}` to the query.',
  wire: '`github.search_issues` with a query longer than 256 characters answers a status the connector maps to `github_validation` (400 or 422; unverified: that GitHub refuses an overlong search with 422 rather than answering 200) with a JSON body whose `message` is a non-empty string and whose `errors` array is non-empty (observed at the `ConnectorHttpClient` port) and holds entries in a shape the connector reads, so `underlying.errors` is non-empty and the connector message starts with `GitHub search issues failed (<status>): <message>`. The case reads no search results, so search index consistency does not matter.',
  fixtures: [githubValidationEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const integration = yield* repoIntegration

    const { value, responses } = yield* observed(
      githubSearchIssuesAction.executeTyped({
        integration,
        input: { query: githubConformanceLongSearchQuery }
      })
    )

    const failure = failureOf(value)

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected github.search_issues with an overlong query to fail'
      })
    }

    yield* expectConformance(
      failure.code === 'github_validation',
      'expected an overlong search to map to github_validation',
      { actual: outcomeOf(value) }
    )

    const body = yield* decodeBody(GithubValidationBody, responses.at(-1)?.body)

    if (body === undefined) {
      return yield* new ConformanceMismatch({
        message:
          'expected the validation body to be JSON with a message and a non-empty errors array'
      })
    }

    yield* expectConformance(
      failure.message.startsWith(
        `GitHub search issues failed (${failure.status ?? 'no-status'}): ${body.message}`
      ),
      'expected the connector message to start with the body message'
    )

    const details = underlyingDetails(failure.underlying)?.[1] ?? 0

    yield* expectConformance(
      details > 0,
      'expected errors entries in a shape the connector reads (underlying.errors non-empty)'
    )
  })
})

/** The contents answer field the case observes: the raw base64 `content`. */
const GithubContentsBody = Schema.Struct({ content: Schema.String })

/** Smallest seeded file size whose base64 spans more than one 60-character line. */
const minimumFileBytes = 46

export const githubFileContentsCase: GithubConformanceCase = defineConformanceCase({
  id: 'github.contents.base64-file',
  title: 'A text file answers folded base64 that decodes to exactly size UTF-8 bytes',
  safety: 'read',
  docs: '`github.get_file_contents` sends GET /repos/{owner}/{repo}/contents/{path} (each segment percent-encoded) and requires `{ type: "file", encoding: "base64", content, size?, path?, sha? }`; it removes all whitespace from `content`, decodes the base64, refuses NUL bytes and invalid UTF-8 (`github_unsupported_content`), and returns `{ path, sha, size, content, truncated }` with `size` taken from the answer.',
  wire: 'For the seeded `filePath` (a UTF-8 text file of more than 45 bytes with at least one non-ASCII character), the answer carries `type: "file"`, `encoding: "base64"`, and a `content` broken into lines (unverified: GitHub folds the base64 every 60 characters; the connector strips the line breaks), and the connector returns the file untruncated with `path` equal to the seed and `size` equal to the UTF-8 byte length of the decoded text (observed at the `ConnectorHttpClient` port), so `size` counts the bytes the base64 carries.',
  fixtures: [githubFileContentsFixture.id],
  run: Effect.gen(function* () {
    const path = yield* requireSeed('filePath')
    const integration = yield* repoIntegration

    const { value, responses } = yield* observed(
      githubGetFileContentsAction.executeTyped({ integration, input: { path } })
    )

    const file = yield* successValue(githubGetFileContentsAction.id)(value)
    const byteLength = new TextEncoder().encode(file.content).byteLength

    yield* expectConformance(
      !file.truncated && byteLength >= minimumFileBytes && /[^\u0000-\u007f]/.test(file.content),
      'precondition: filePath must name an untruncated UTF-8 text file of more than 45 bytes with a non-ASCII character'
    )
    yield* expectEqual(file.path, path, 'expected the answer path to equal the seeded filePath')
    yield* expectEqual(
      file.size,
      byteLength,
      'expected size to equal the UTF-8 byte length of the decoded content'
    )

    const body = yield* decodeBody(GithubContentsBody, responses.at(-1)?.body)

    yield* expectConformance(
      body !== undefined && body.content.includes('\n'),
      'expected the base64 content to be broken into lines'
    )
  })
})

// Write cases.

const commentCaseId = 'github.comments.create-delete'

/** Comment listing page size for the since-bounded lookups. */
const commentPageSize = 100

/** Ids of the work issue's comments updated at or after `since` (one bounded page). */
const commentsSince = (issueNumber: number, since: string) =>
  Effect.gen(function* () {
    const integration = yield* repoIntegration

    const listing = yield* githubListIssueCommentsAction
      .executeTyped({ integration, input: { issueNumber, since, perPage: commentPageSize } })
      .pipe(Effect.flatMap(successValue(githubListIssueCommentsAction.id)))

    if (listing.hasNextPage) {
      return yield* new ConformanceMismatch({
        message: `precondition: more than ${commentPageSize} comments on the work issue since the case comment`
      })
    }

    return listing.comments.map(comment => comment.id)
  })

/** Delete an owned comment that may still exist, by id, then verify the listing omits it. */
const ensureCommentAbsent = (issueNumber: number, comment: GithubComment) =>
  Effect.gen(function* () {
    const deleted = yield* deleteComment(comment.id)

    if (!Predicate.isTagged(deleted, 'Success') && !isNotFound(deleted)) {
      return yield* successValue(githubDeleteIssueCommentAction.id)(deleted).pipe(Effect.asVoid)
    }

    const listed = yield* commentsSince(issueNumber, comment.createdAt)

    yield* expectConformance(
      !listed.includes(comment.id),
      'expected list_issue_comments to omit the case comment after restoring'
    )
  })

export const githubCommentLifecycleCase: GithubConformanceCase = defineConformanceCase({
  id: commentCaseId,
  title: 'A comment created on the work issue is listed, deleted by id, then gone',
  safety: 'write-reversible',
  docs: '`github.create_issue_comment` sends POST /repos/{owner}/{repo}/issues/{number}/comments `{ body }` and decodes the comment (`id`, `body`, `html_url`, `created_at`, `updated_at`); `github.list_issue_comments` sends GET .../comments with `since`, `per_page`, and `page` and reports `hasNextPage` from `Link`; `github.delete_issue_comment` sends DELETE /repos/{owner}/{repo}/issues/comments/{id} and treats any 2xx as deleted without reading the body; 404 maps to `github_not_found`.',
  wire: '`github.create_issue_comment` on the seeded work issue answers the comment with the requested run-scoped body and an id; `github.list_issue_comments` with `since` set to its `created_at` lists it (unverified: that `since` includes a comment created at exactly that instant); `github.delete_issue_comment` answers 2xx; afterwards the same listing omits it, and deleting it again answers `github_not_found` (unverified: 404 for an already deleted comment), which the cleanup relies on. The case deletes its own comment again, by id, even when a step fails. Residue the connector cannot undo: subscribers of the work issue are notified of the comment (use a practice issue nobody else watches); the comment itself is gone, so the case stays write-reversible.',
  fixtures: [githubCommentLifecycleFixture.id],
  run: Effect.gen(function* () {
    const issueNumber = yield* requireIssueNumber
    const integration = yield* repoIntegration
    const body = yield* runText('comment', 'synthetic conformance comment, safe to delete')

    yield* withOwnedWrite({
      caseId: commentCaseId,
      actionId: githubCreateIssueCommentAction.id,
      create: githubCreateIssueCommentAction.executeTyped({
        integration,
        input: { issueNumber, body }
      }),
      unknownRecovery: `delete the comment "${body}" on issue #${issueNumber} by hand if it exists`,
      refuse: comment =>
        comment.body === body ? undefined : `comment ${comment.id} with another body`,
      recovery: comment =>
        `delete comment ${comment.id} on issue #${issueNumber} by hand if it still exists`,
      restore: comment => ensureCommentAbsent(issueNumber, comment),
      use: (comment, pending) =>
        Effect.gen(function* () {
          const listed = yield* commentsSince(issueNumber, comment.createdAt)

          yield* expectConformance(
            listed.includes(comment.id),
            "expected list_issue_comments since the comment's created_at to list it"
          )

          yield* deleteComment(comment.id).pipe(
            Effect.flatMap(successValue(githubDeleteIssueCommentAction.id)),
            Effect.uninterruptible
          )

          const after = yield* commentsSince(issueNumber, comment.createdAt)

          yield* expectConformance(
            !after.includes(comment.id),
            'expected list_issue_comments to omit the deleted comment'
          )
          yield* Ref.set(pending, false)

          const again = yield* deleteComment(comment.id).pipe(Effect.uninterruptible)

          yield* expectConformance(
            isNotFound(again),
            'expected deleting the deleted comment again to answer github_not_found',
            { actual: outcomeOf(again) }
          )
        })
    })
  })
})

const labelCaseId = 'github.labels.add-remove'

/** Repository label listing page size (the GitHub maximum) for the label-exists precondition. */
const repositoryLabelPageSize = 100

/** Remove the seeded label from the work issue if it is there, then verify it is gone. */
const ensureLabelAbsent = (issueNumber: number, label: string) =>
  Effect.gen(function* () {
    const removed = yield* removeLabel(issueNumber, label)

    if (!Predicate.isTagged(removed, 'Success') && !isNotFound(removed)) {
      return yield* successValue(githubRemoveLabelAction.id)(removed).pipe(Effect.asVoid)
    }

    const issue = yield* getIssue(issueNumber).pipe(
      Effect.flatMap(successValue(githubGetIssueAction.id))
    )

    yield* expectConformance(
      !issue.labels.includes(label),
      'expected get_issue to omit the case label after restoring'
    )
  })

export const githubIssueLabelsCase: GithubConformanceCase = defineConformanceCase({
  id: labelCaseId,
  title: 'A label added to the work issue is listed, removed by name, then gone',
  safety: 'write-reversible',
  docs: '`github.add_labels` sends POST /repos/{owner}/{repo}/issues/{number}/labels `{ labels }` and `github.remove_label` DELETE .../labels/{name}; both decode the answer as an array of `{ name }` and return it as the issue `labels`; `github.get_issue` reports the issue `labels` as names. Adding a label the repository does not have creates it, and the connector cannot delete repository labels.',
  wire: 'For the seeded label, which exists in the repository and is not on the seeded work issue: `github.add_labels` answers the issue label names including it, and `github.get_issue` lists it; `github.remove_label` answers the remaining names without it, and `github.get_issue` omits it; removing it again answers `github_not_found` (unverified: 404 for a label not on the issue), which the cleanup relies on. The case refuses to start when the label is already on the issue, so it never removes a label it did not add, and removes its label again even when a step fails. Residue the connector cannot undo: the add and the remove stay on the issue timeline as `labeled` / `unlabeled` events (use a practice issue nobody else watches); the label state itself is restored, so the case stays write-reversible.',
  fixtures: [githubIssueLabelsFixture.id],
  run: Effect.gen(function* () {
    const issueNumber = yield* requireIssueNumber
    const label = yield* requireSeed('labelName')
    const integration = yield* repoIntegration

    const before = yield* getIssue(issueNumber).pipe(
      Effect.flatMap(successValue(githubGetIssueAction.id))
    )

    if (before.labels.includes(label)) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: labelName is already on workIssueNumber (a leftover or a concurrent run); remove it by hand first'
      })
    }

    const names: Array<string> = []

    for (let page = 1; page <= pageCap; page++) {
      const listing = yield* listLabels(repositoryLabelPageSize, page === 1 ? undefined : page)

      names.push(...listing.labels.map(entry => entry.name))

      if (!listing.hasNextPage || names.includes(label)) {
        break
      }
    }

    if (!names.includes(label)) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: labelName must be an existing repository label (adding a missing label creates it, which the connector cannot undo)'
      })
    }

    yield* withOwnedWrite({
      caseId: labelCaseId,
      actionId: githubAddLabelsAction.id,
      create: githubAddLabelsAction.executeTyped({
        integration,
        input: { issueNumber, labels: [label] }
      }),
      unknownRecovery: `remove label ${label} from issue #${issueNumber} by hand if it is there`,
      // The seeded issue and label are the namespace, and the label was proven absent before.
      refuse: () => undefined,
      recovery: () =>
        `remove label ${label} from issue #${issueNumber} by hand if it is still there`,
      restore: () => ensureLabelAbsent(issueNumber, label),
      use: (added, pending) =>
        Effect.gen(function* () {
          yield* expectConformance(
            added.labels.includes(label),
            'expected add_labels to answer the issue labels including the added label'
          )

          const withLabel = yield* getIssue(issueNumber).pipe(
            Effect.flatMap(successValue(githubGetIssueAction.id))
          )

          yield* expectConformance(
            withLabel.labels.includes(label),
            'expected get_issue to list the added label'
          )

          const removed = yield* removeLabel(issueNumber, label).pipe(
            Effect.flatMap(successValue(githubRemoveLabelAction.id)),
            Effect.uninterruptible
          )

          yield* expectConformance(
            !removed.labels.includes(label),
            'expected remove_label to answer the remaining labels without it'
          )

          const without = yield* getIssue(issueNumber).pipe(
            Effect.flatMap(successValue(githubGetIssueAction.id))
          )

          yield* expectConformance(
            !without.labels.includes(label),
            'expected get_issue to omit the removed label'
          )
          yield* Ref.set(pending, false)

          const again = yield* removeLabel(issueNumber, label).pipe(Effect.uninterruptible)

          yield* expectConformance(
            isNotFound(again),
            'expected removing the removed label again to answer github_not_found',
            { actual: outcomeOf(again) }
          )
        })
    })
  })
})

const lifecycleCaseId = 'github.issues.lifecycle-close'

/** Close an owned issue that may still be open (`not_planned`), then verify it reads closed. */
const ensureIssueClosed = (issue: GithubIssue) =>
  Effect.gen(function* () {
    yield* updateIssue({
      issueNumber: issue.number,
      state: 'closed',
      stateReason: 'not_planned'
    }).pipe(Effect.flatMap(successValue(githubUpdateIssueAction.id)))

    const after = yield* getIssue(issue.number).pipe(
      Effect.flatMap(successValue(githubGetIssueAction.id))
    )

    yield* expectConformance(
      after.state === 'closed',
      'expected get_issue of the case issue to read closed after restoring',
      { actual: after.state }
    )
  })

export const githubIssueLifecycleCase: GithubConformanceCase = defineConformanceCase({
  id: lifecycleCaseId,
  title: 'An issue created, read, renamed, and closed reads back closed as completed',
  safety: 'write-irreversible',
  docs: '`github.create_issue` sends POST /repos/{owner}/{repo}/issues and `github.update_issue` PATCH /repos/{owner}/{repo}/issues/{number} (JSON, undefined fields omitted; `stateReason` as `state_reason`), and `github.get_issue` GET .../issues/{number}; all decode the issue and normalize it (`state`, `stateReason`, `closedAt`, `isPullRequest` from `pull_request`). The connector has no delete action, and GitHub cannot delete issues through the REST API: a created issue can only be closed.',
  wire: '`github.create_issue` with a run-scoped title answers an open issue (not a pull request) with that title; `github.get_issue` answers the same number and title; `github.update_issue` with a new run-scoped title answers it; `github.update_issue` with `state: "closed"` and `stateReason: "completed"` answers `state: "closed"`, `stateReason: "completed"`, and a `closedAt`; and `github.get_issue` then reads it closed. The closed issue stays in the repository: that is state the connector cannot undo (not only a notification or a timeline event), so this case is write-irreversible and runs only when requested by its exact id; if a step fails, the cleanup closes the issue as `not_planned`.',
  fixtures: [githubIssueLifecycleFixture.id],
  run: Effect.gen(function* () {
    const integration = yield* repoIntegration
    const seeds = yield* GithubConformanceConfig
    const title = yield* runText('lifecycle', 'synthetic conformance issue, safe to ignore')

    const renamedTitle = yield* runText(
      'lifecycle renamed',
      'synthetic conformance issue, safe to ignore'
    )

    yield* withOwnedWrite({
      caseId: lifecycleCaseId,
      actionId: githubCreateIssueAction.id,
      create: githubCreateIssueAction.executeTyped({
        integration,
        input: {
          title,
          body: 'Synthetic conformance issue. GitHub issues cannot be deleted through the REST API, so it stays closed.'
        }
      }),
      unknownRecovery: `close the issue titled "${title}" by hand if it exists`,
      refuse: issue =>
        issue.title !== title ||
        issue.isPullRequest ||
        String(issue.number) === seeds.workIssueNumber
          ? `issue #${issue.number} titled "${issue.title}"`
          : undefined,
      recovery: issue => `close issue #${issue.number} by hand if it is still open`,
      restore: ensureIssueClosed,
      use: (issue, pending) =>
        Effect.gen(function* () {
          yield* expectEqual(issue.state, 'open', 'expected create_issue to answer an open issue')

          const fetched = yield* getIssue(issue.number).pipe(
            Effect.flatMap(successValue(githubGetIssueAction.id))
          )

          yield* expectEqual(
            [fetched.number, fetched.title],
            [issue.number, title],
            'expected get_issue to answer the created issue'
          )

          const renamed = yield* updateIssue({
            issueNumber: issue.number,
            title: renamedTitle
          }).pipe(Effect.flatMap(successValue(githubUpdateIssueAction.id)), Effect.uninterruptible)

          yield* expectEqual(
            [renamed.number, renamed.title],
            [issue.number, renamedTitle],
            'expected update_issue to answer the same issue with the new title'
          )

          const closed = yield* updateIssue({
            issueNumber: issue.number,
            state: 'closed',
            stateReason: 'completed'
          }).pipe(Effect.flatMap(successValue(githubUpdateIssueAction.id)), Effect.uninterruptible)

          yield* expectEqual(
            [closed.state, closed.stateReason, closed.closedAt !== null],
            ['closed', 'completed', true],
            'expected update_issue to answer the issue closed as completed with a closedAt'
          )

          const after = yield* getIssue(issue.number).pipe(
            Effect.flatMap(successValue(githubGetIssueAction.id))
          )

          yield* expectEqual(after.state, 'closed', 'expected get_issue to read the issue closed')
          yield* Ref.set(pending, false)
        })
    })
  })
})

/** Listing page size (the GitHub maximum), and the pages read before giving up. */
const leftoverPageSize = 100

const leftoverPageCap = 10

/**
 * READ-ONLY and bounded: what earlier runs left behind in the practice repository (a killed
 * process, a failed or ambiguous cleanup): OPEN issues titled `yolk-conformance run-*` (at most 10
 * pages of 100 open issues), `yolk-conformance run-*` comments on the seeded work issue (at most 10
 * pages of 100), and the seeded label on the seeded work issue. Closed `yolk-conformance run-*`
 * issues are the lifecycle case's documented leftover (issues cannot be deleted) and are not
 * listed. Live runners call it before any write case and warn per leftover; nothing is ever changed
 * automatically.
 */
export const findGithubConformanceLeftovers: Effect.Effect<
  ReadonlyArray<string>,
  GithubConformanceError,
  GithubConformanceRequirements
> = Effect.gen(function* () {
  const integration = yield* repoIntegration
  const seeds = yield* GithubConformanceConfig
  const found: Array<string> = []

  for (let page = 1; page <= leftoverPageCap; page++) {
    const listing = yield* githubListIssuesAction
      .executeTyped({ integration, input: { state: 'open', perPage: leftoverPageSize, page } })
      .pipe(Effect.flatMap(successValue(githubListIssuesAction.id)))

    for (const issue of listing.issues) {
      if (!issue.isPullRequest && issue.title.startsWith(githubConformanceRunPrefix)) {
        found.push(`open issue #${issue.number} "${issue.title}"`)
      }
    }

    if (!listing.hasNextPage) {
      break
    }
  }

  if (seeds.workIssueNumber === undefined) {
    return found
  }

  const issueNumber = Number(seeds.workIssueNumber)

  for (let page = 1; page <= leftoverPageCap; page++) {
    const listing = yield* githubListIssueCommentsAction
      .executeTyped({ integration, input: { issueNumber, perPage: leftoverPageSize, page } })
      .pipe(Effect.flatMap(successValue(githubListIssueCommentsAction.id)))

    for (const comment of listing.comments) {
      if (comment.body.startsWith(githubConformanceRunPrefix)) {
        found.push(`comment ${comment.id} on issue #${issueNumber}`)
      }
    }

    if (!listing.hasNextPage) {
      break
    }
  }

  if (seeds.labelName !== undefined) {
    const issue = yield* getIssue(issueNumber).pipe(
      Effect.flatMap(successValue(githubGetIssueAction.id))
    )

    if (issue.labels.includes(seeds.labelName)) {
      found.push(`label ${seeds.labelName} on issue #${issueNumber}`)
    }
  }

  return found
})

/** Every GitHub conformance case, in fixture order. */
export const githubConformanceCases: ReadonlyArray<GithubConformanceCase> = [
  githubLabelsPagingCase,
  githubNotFoundEnvelopeCase,
  githubValidationEnvelopeCase,
  githubFileContentsCase,
  githubCommentLifecycleCase,
  githubIssueLabelsCase,
  githubIssueLifecycleCase
]
