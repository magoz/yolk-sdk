/**
 * Notion conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Notion connector relies on, running the REAL connector
 * actions over the connector ports (`ConnectorHttpClient`, `CredentialResolver`) plus the
 * host-supplied `NotionConformanceConfig` seed ids. Every connector action sends `Notion-Version:
 * 2025-09-03`; the pinned-version case observes that header at the `ConnectorHttpClient` port. The
 * same cases run on replay fixtures, an emulator, or by hand against a practice workspace. None is
 * observed live yet (`observed` absent = unverified); sub-claims no live run has settled are marked
 * "(unverified: ...)" in their `wire`.
 *
 * The one write case creates its own page under the seeded parent page and registers its id for
 * the restore before any claim runs (the create and the registration run uninterruptibly). The
 * restore moves the page to the trash again when the claim did not (also after a failed claim or an
 * interruption), verifies it, and reports (never swallows) a failed restore. Any response that
 * shows the page trashed (`archived` or `in_trash` true), or a not-found read after a successful
 * archive, counts as trashed, so an uncertain claim about how a trashed page reads back is reported
 * as a claim failure, never as a failed restore. An ambiguous create (a transport or decoding
 * failure, no status, or HTTP 5xx) fails with `NotionConformanceActionFailed` (`createOutcome:
 * 'unknown'`) and says to trash the page by hand if it exists. Neither the runner nor the bridges set
 * a request timeout, so a hanging create delays an interruption until it answers. Notion keeps
 * trashed pages in the workspace trash (restorable) until they are deleted from there.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import { interruptPending, reportCleanupProblem } from '../../conformance/cleanup-reporter.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import { ConnectorHttpClient, type ConnectorHttpRequest } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  NotionBlockIdInput,
  NotionCreatePageInput,
  NotionDataSourceIdInput,
  NotionDatabaseIdInput,
  NotionGetPageInput,
  NotionGetPagePropertyInput,
  NotionQueryDataSourceInput,
  NotionSearchInput,
  NotionProperties,
  NotionTitleProperty,
  NotionUpdatePageInput,
  notionApiTokenSlotId,
  notionConnectorId,
  notionCreatePageAction,
  notionGetBotUserAction,
  notionGetDataSourceAction,
  notionGetDatabaseAction,
  notionGetPageAction,
  notionGetPageContentAction,
  notionGetPagePropertyAction,
  notionQueryDataSourceAction,
  notionSearchAction,
  notionUpdatePageAction,
  notionVersion,
  type NotionPage
} from '../index.ts'
import { notionArchiveInTrashFixture } from './archive-in-trash.ts'
import { notionBlockChildrenPagingFixture } from './block-children-paging.ts'
import { notionDataSourceSplitFixture } from './data-source-split.ts'
import { notionErrorEnvelopeFixture } from './error-envelope.ts'
import { notionPropertyItemPagingFixture } from './property-item-paging.ts'
import { notionSearchPagingFixture } from './search-paging.ts'
import { notionTitlePlainTextFixture } from './title-plain-text.ts'
import { notionPinnedVersionFixture } from './pinned-version.ts'

const SeedString = Schema.Trimmed.check(Schema.isNonEmpty())

/**
 * Host-supplied seed ids in the practice Notion workspace (every page and database shared with the
 * integration). Cases never hard-code account data. A case whose required seed is missing fails
 * with a `precondition:` `ConformanceMismatch` before any request.
 */
export const NotionConformanceSeeds = Schema.Struct({
  /** A search query matching at least two pages. */
  searchQuery: Schema.optionalKey(SeedString),
  /** A page with a plain-text title (no mentions or equations). */
  titlePageId: Schema.optionalKey(SeedString),
  /** That page's exact plain-text title. */
  titlePageTitle: Schema.optionalKey(SeedString),
  /** A page (or block) with more than two top-level child blocks. */
  blocksPageId: Schema.optionalKey(SeedString),
  /** A page with a paginated property (title, rich_text, relation, or people) of more than two items. */
  propertyPageId: Schema.optionalKey(SeedString),
  /**
   * That property's id exactly as the page object returns it. It must contain a `%XX` escape (for
   * example `abc%3A`), so the case exercises the connector's second percent-encoding of the id.
   */
  propertyId: Schema.optionalKey(SeedString),
  /** A database with at least one data source that holds at least one page. */
  databaseId: Schema.optionalKey(SeedString),
  /** A page the write case creates (and trashes) its own child page under. */
  parentPageId: Schema.optionalKey(SeedString)
})

export type NotionConformanceSeeds = typeof NotionConformanceSeeds.Type

export type NotionConformanceSeedKey = keyof NotionConformanceSeeds

/** Host-supplied seed ids for the Notion conformance cases. */
export class NotionConformanceConfig extends Context.Service<
  NotionConformanceConfig,
  NotionConformanceSeeds
>()('@yolk-sdk/connectors/notion/conformance/NotionConformanceConfig') {}

/**
 * Credential reference the cases bind to the `notion.api_token` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Notion integration token.
 */
export const notionConformanceCredentialRef = 'notion.conformance'

/** The integration every Notion conformance case invokes the connector with. */
export const notionConformanceIntegration = makeIntegration({
  connectorId: notionConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: notionApiTokenSlotId,
      credentialRef: notionConformanceCredentialRef
    })
  ]
})

/** Synthetic marker the case-created page title starts with. */
export const notionConformanceMarker = 'yolk-conformance'

const restoreByHandAdvice = `trash the case-created page by hand if it is not trashed yet (title starts with ${notionConformanceMarker}, under parentPageId).`

/**
 * A connector action failed where the case needed success.
 * `createOutcome: 'unknown'` marks an ambiguous create of the write case's own page (a transport
 * or decoding failure, no status, or HTTP 5xx): Notion may have created it without the case
 * learning its id, so the message adds the manual-recovery advice.
 */
export class NotionConformanceActionFailed extends Data.TaggedError(
  'NotionConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly createOutcome?: 'unknown'
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.createOutcome === 'unknown' ? `; the page may exist anyway: ${restoreByHandAdvice}` : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Trashing the write case's own page failed. `caseOutcome` says whether the claim itself held
 * before the restore; `claimFailure` is a sanitized summary of why it failed.
 */
export class NotionConformanceRestoreFailed extends Data.TaggedError(
  'NotionConformanceRestoreFailed'
)<{
  readonly caseId: string
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

    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type NotionConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | NotionConformanceActionFailed
  | NotionConformanceRestoreFailed

/** What every Notion conformance case requires from the host. */
export type NotionConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | NotionConformanceConfig

export type NotionConformanceCase = ConformanceCase<
  NotionConformanceError,
  NotionConformanceRequirements
>

const integration = notionConformanceIntegration

const requireSeed = <K extends NotionConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* NotionConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: NotionConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, NotionConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new NotionConformanceActionFailed({ actionId, code })
      : new NotionConformanceActionFailed({ actionId, code, status })
  )
}

const failureOf = <A>(result: ActionResult<A>): ProviderFailure | undefined =>
  Predicate.isTagged(result, 'Failure') ? result.error : undefined

/** Decode an untyped action output; a shape mismatch fails the claim with `message`. */
const decodeAs =
  <A>(schema: Schema.Schema<A> & { readonly DecodingServices: never }, message: string) =>
  (value: unknown): Effect.Effect<A, ConformanceMismatch> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new ConformanceMismatch({ message }))
    )

/** Notion ids compare without dashes and case (the API returns dashed ids; seeds may not be). */
const sameId = (left: string, right: string): boolean =>
  left.replaceAll('-', '').toLowerCase() === right.replaceAll('-', '').toLowerCase()

const failureSummaryLength = 60

const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/** Short, sanitized summary of a failure (credential patterns redacted). */
const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)

  if (value instanceof NotionConformanceActionFailed) {
    const status = value.status === undefined ? '' : ` ${value.status}`

    return `${truncated(sanitizeConformanceMessage(`${value.actionId} ${value.code}`), failureSummaryLength - status.length)}${status}`
  }

  const tag = Predicate.hasProperty(value, '_tag') ? String(value._tag) : 'defect'
  const message = Predicate.hasProperty(value, 'message') ? String(value.message) : ''

  const raw =
    message.length === 0
      ? tag
      : value instanceof ConformanceMismatch
        ? message
        : `${tag}: ${message}`

  return truncated(sanitizeConformanceMessage(raw), failureSummaryLength)
}

// Notion error envelope: `{ object: "error", status, code, message }`.

const NotionErrorEnvelope = Schema.Struct({
  object: Schema.Literal('error'),
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String
})

type NotionErrorEnvelope = typeof NotionErrorEnvelope.Type

const decodeErrorEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(NotionErrorEnvelope))

/** The Notion error envelope in a response body, or `undefined`. */
const errorEnvelopeOf = (body: unknown): Effect.Effect<NotionErrorEnvelope | undefined> =>
  Predicate.isString(body)
    ? decodeErrorEnvelope(body).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )
    : Effect.succeed(undefined)

/** Fail unless `envelope` is the error envelope with this `code` and a `status` of `status`. */
const expectEnvelope = (
  envelope: NotionErrorEnvelope | undefined,
  code: string,
  status: number,
  label: string
) =>
  expectEqual(
    envelope === undefined
      ? null
      : { object: envelope.object, code: envelope.code, status: envelope.status },
    { object: 'error', code, status },
    `expected ${label} to carry the error envelope { object: "error", code: "${code}", status: ${status} }`
  )

/** The paging fields every Notion list body carries. */
const listFields = {
  object: Schema.Literal('list'),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String)
}

/** Pages followed at most while paging a list, before the case gives up. */
const pageCap = 10

// Read cases.

const SearchResult = Schema.Struct({ object: Schema.String, id: Schema.String })

const searchPageSize = 1

const searchPage = (query: string, startCursor: string | undefined) =>
  notionSearchAction
    .executeTyped({
      integration,
      input: NotionSearchInput.make({
        query,
        filter: { property: 'object', value: 'page' },
        pageSize: searchPageSize,
        startCursor
      })
    })
    .pipe(Effect.flatMap(result => successValue(notionSearchAction.id, result)))

export const notionSearchPagingCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.search.cursor-paging',
  title: 'Search pages with has_more and next_cursor, ending with an explicit null cursor',
  safety: 'read',
  docs: '`notion.search` sends POST /v1/search with `page_size` and `start_cursor` and returns `{ results, nextCursor, hasMore }`; the connector requires `has_more` and a `next_cursor` key (string or null) on every page and never follows a cursor by itself.',
  wire: '`notion.search` for a query seeded to match at least two pages, filtered to `object: "page"` with `pageSize: 1`, answers one page result, `has_more: true`, and a string `next_cursor`; following `next_cursor` as `startCursor` returns further page results (none repeated) until a page answers `has_more: false` with `next_cursor: null` present (not absent).',
  fixtures: [notionSearchPagingFixture.id],
  run: Effect.gen(function* () {
    const query = yield* requireSeed('searchQuery')
    const first = yield* searchPage(query, undefined)

    if (!first.hasMore) {
      return yield* new ConformanceMismatch({
        message: 'precondition: searchQuery needs at least two matching pages'
      })
    }

    const seen: Array<string> = []
    let page = first

    for (let count = 1; ; count++) {
      const results = yield* decodeAs(
        Schema.Array(SearchResult),
        'expected every search result to carry object and id'
      )(page.results)

      yield* expectConformance(
        results.length <= searchPageSize,
        'expected at most page_size results per search page',
        { actual: results.length }
      )
      yield* expectConformance(
        results.every(result => result.object === 'page'),
        'expected the object filter to return page results only'
      )
      yield* expectConformance(
        results.every(result => !seen.includes(result.id)),
        'expected a later search page to repeat no earlier result'
      )
      seen.push(...results.map(result => result.id))

      if (!page.hasMore) {
        break
      }

      if (!Predicate.isString(page.nextCursor) || page.nextCursor.length === 0) {
        return yield* new ConformanceMismatch({
          message: 'expected a string next_cursor with has_more true'
        })
      }

      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: searchQuery matches more than ${pageCap} pages; narrow the query`
        })
      }

      page = yield* searchPage(query, page.nextCursor)
    }

    yield* expectConformance(seen.length > 1, 'expected the search to page through several results')
    yield* expectEqual(
      page.nextCursor === undefined ? 'absent' : page.nextCursor,
      null,
      'expected the last search page to carry next_cursor null'
    )
  })
})

const BotUser = Schema.Struct({ object: Schema.Literal('user'), type: Schema.Literal('bot') })

/** The `Notion-Version` header of a request, matched case-insensitively. */
const notionVersionOf = (request: ConnectorHttpRequest): string | undefined =>
  Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'notion-version'
  )?.[1]

export const notionPinnedVersionCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.api.pinned-version-accepted',
  title: 'Action requests carry the pinned Notion-Version, and Notion accepts it',
  safety: 'read',
  docs: "Every Notion connector request sends `Notion-Version: 2025-09-03` with the bearer token (`notionAuthorizationHeaders`), and the connector's database, data source, and page-parent handling assume that version. The case observes the outgoing request at the `ConnectorHttpClient` port the host provides; it sends no request of its own.",
  wire: '`notion.get_bot_user` sends exactly one GET /v1/users/me carrying `Notion-Version: 2025-09-03`, and Notion answers it with the bot user (`object: "user"`, `type: "bot"`), not a version error.',
  fixtures: [notionPinnedVersionFixture.id],
  run: Effect.gen(function* () {
    const http = yield* ConnectorHttpClient
    const sent = yield* Ref.make<ReadonlyArray<ConnectorHttpRequest>>([])

    const observing = ConnectorHttpClient.of({
      request: request =>
        Ref.update(sent, requests => [...requests, request]).pipe(
          Effect.andThen(http.request(request))
        )
    })

    yield* notionGetBotUserAction.executeTyped({ integration, input: {} }).pipe(
      Effect.provideService(ConnectorHttpClient, observing),
      Effect.flatMap(result => successValue(notionGetBotUserAction.id, result)),
      Effect.flatMap(
        decodeAs(
          BotUser,
          `expected notion.get_bot_user with Notion-Version ${notionVersion} to answer the bot user`
        )
      )
    )

    const requests = yield* Ref.get(sent)

    yield* expectEqual(
      requests.map(request => [request.method, notionVersionOf(request) ?? null]),
      [['GET', notionVersion]],
      `expected notion.get_bot_user to send one GET carrying Notion-Version ${notionVersion}`
    )
  })
})

/** A well-formed page id that addresses no page (synthetic, never account data). */
const absentPageId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'

/** A page id Notion rejects as malformed. */
const malformedPageId = 'not-a-notion-id'

const getPage = (pageId: string) =>
  notionGetPageAction.executeTyped({ integration, input: NotionGetPageInput.make({ pageId }) })

export const notionErrorEnvelopeCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.errors.error-envelope',
  title: 'Errors carry { object: "error", status, code, message } and keep the HTTP status',
  safety: 'read',
  docs: 'The connector maps a non-2xx Notion response by HTTP status (401/403 `notion_unauthorized`, 404 `notion_not_found`, 429 `notion_rate_limited`, otherwise the action code), appends the body `message` to its failure message, and keeps the body as `underlying`.',
  wire: '`notion.get_page` of a well-formed id that addresses no page answers HTTP 404 with `{ object: "error", status: 404, code: "object_not_found", message }` (`notion_not_found`); a malformed id answers HTTP 400 with `code: "validation_error"` (`notion_get_page_failed`). In both, the envelope `status` equals the HTTP status and the connector message ends with the envelope `message`.',
  fixtures: [notionErrorEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const expectations = [
      {
        pageId: absentPageId,
        status: 404,
        code: 'object_not_found',
        failureCode: 'notion_not_found',
        label: 'the missing page response'
      },
      {
        pageId: malformedPageId,
        status: 400,
        code: 'validation_error',
        failureCode: 'notion_get_page_failed',
        label: 'the malformed id response'
      }
    ] as const

    for (const expected of expectations) {
      const failure = failureOf(yield* getPage(expected.pageId))

      if (failure === undefined) {
        return yield* new ConformanceMismatch({
          message: `expected notion.get_page to fail for ${expected.label}`
        })
      }

      yield* expectEqual(
        [failure.code, failure.status ?? null],
        [expected.failureCode, expected.status],
        `expected ${expected.label} to map to ${expected.failureCode} with HTTP ${expected.status}`
      )

      const envelope = yield* errorEnvelopeOf(failure.underlying)

      yield* expectEnvelope(envelope, expected.code, expected.status, expected.label)
      yield* expectEqual(
        failure.message,
        `Notion get page failed: ${envelope?.message ?? ''}`,
        `expected the connector message to end with the envelope message for ${expected.label}`
      )
    }
  })
})

const TitleValue = Schema.Struct({ type: Schema.Literal('title') })

export const notionTitlePlainTextCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.pages.title-plain-text',
  title: 'A page title is one title property of rich text items with plain_text',
  safety: 'read',
  docs: '`notion.get_page` decodes `NotionPage` with `properties` as an untyped record; the connector exports `NotionTitleProperty` / `NotionRichText` (`type`, `plain_text`, `href`) for reading titles, and `notion.create_page` writes titles as `{ title: [{ text: { content } }] }`.',
  wire: '`notion.get_page` of the seeded page returns exactly one property with `type: "title"`; its `title` array decodes as `NotionTitleProperty`, every item has `type: "text"` and a `plain_text`, and the items\' `plain_text` joined equals the seeded title.',
  fixtures: [notionTitlePlainTextFixture.id],
  run: Effect.gen(function* () {
    const pageId = yield* requireSeed('titlePageId')
    const title = yield* requireSeed('titlePageTitle')

    const page = yield* getPage(pageId).pipe(
      Effect.flatMap(result => successValue(notionGetPageAction.id, result))
    )

    const titles = Object.values(page.properties ?? {}).filter(Schema.is(TitleValue))

    yield* expectEqual(titles.length, 1, 'expected exactly one title property on the page')

    const property = yield* decodeAs(
      NotionTitleProperty,
      'expected the title property to decode as NotionTitleProperty'
    )(titles[0])

    yield* expectConformance(
      property.title.length > 0 &&
        property.title.every(item => item.type === 'text' && Predicate.isString(item.plain_text)),
      'expected every title item to be text with plain_text'
    )
    yield* expectEqual(
      property.title.map(item => item.plain_text ?? '').join(''),
      title,
      'expected the joined plain_text to equal the seeded title'
    )
  })
})

const Block = Schema.Struct({ object: Schema.Literal('block'), id: Schema.String })

const BlockPage = Schema.Struct({
  ...listFields,
  type: Schema.Literal('block'),
  results: Schema.Array(Block)
})

const blockPageSize = 2

const blockPage = (blockId: string, startCursor: string | undefined) =>
  notionGetPageContentAction
    .executeTyped({
      integration,
      input: NotionBlockIdInput.make({ blockId, pageSize: blockPageSize, startCursor })
    })
    .pipe(
      Effect.flatMap(result => successValue(notionGetPageContentAction.id, result)),
      Effect.flatMap(
        decodeAs(
          BlockPage,
          'expected a block children list: object list, type block, has_more, next_cursor'
        )
      )
    )

export const notionBlockChildrenPagingCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.blocks.children-cursor-paging',
  title: 'Block children page with has_more and next_cursor',
  safety: 'read',
  docs: '`notion.get_page_content` sends GET /v1/blocks/{id}/children with `page_size` and `start_cursor` query parameters and returns the list body untyped; hosts follow `next_cursor` themselves.',
  wire: '`notion.get_page_content` with `pageSize: 2` on a page seeded with more than two child blocks answers `{ object: "list", type: "block", results, has_more: true, next_cursor }` with two blocks; following `next_cursor` as `startCursor` returns the remaining blocks (none repeated) and ends with `has_more: false` and `next_cursor: null`.',
  fixtures: [notionBlockChildrenPagingFixture.id],
  run: Effect.gen(function* () {
    const blockId = yield* requireSeed('blocksPageId')
    const first = yield* blockPage(blockId, undefined)

    if (!first.has_more) {
      return yield* new ConformanceMismatch({
        message: 'precondition: blocksPageId needs more than two child blocks'
      })
    }

    yield* expectEqual(
      first.results.length,
      blockPageSize,
      'expected a full first page of child blocks'
    )

    const seen = first.results.map(block => block.id)
    let page = first

    for (let count = 1; page.has_more; count++) {
      if (page.next_cursor === null) {
        return yield* new ConformanceMismatch({
          message: 'expected a string next_cursor with has_more true'
        })
      }

      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: blocksPageId spans more than ${pageCap} pages of child blocks`
        })
      }

      page = yield* blockPage(blockId, page.next_cursor)

      const ids = page.results.map(block => block.id)

      yield* expectConformance(
        ids.every(id => !seen.includes(id)),
        'expected a later block page to repeat no earlier block'
      )
      seen.push(...ids)
    }

    yield* expectConformance(
      seen.length > blockPageSize,
      'expected the next_cursor pages to return further blocks'
    )
    yield* expectEqual(
      page.next_cursor,
      null,
      'expected the last block page to carry next_cursor null'
    )
  })
})

const PropertyItem = Schema.Struct({ object: Schema.Literal('property_item'), type: Schema.String })

const PropertyItemPage = Schema.Struct({
  ...listFields,
  type: Schema.Literal('property_item'),
  results: Schema.Array(PropertyItem),
  property_item: Schema.Struct({ type: Schema.String })
})

const paginatedPropertyTypes: ReadonlyArray<string> = ['title', 'rich_text', 'relation', 'people']

const propertyPageSize = 2

const propertyPage = (pageId: string, propertyId: string, startCursor: string | undefined) =>
  notionGetPagePropertyAction
    .executeTyped({
      integration,
      input: NotionGetPagePropertyInput.make({
        pageId,
        propertyId,
        pageSize: propertyPageSize,
        startCursor
      })
    })
    .pipe(
      Effect.flatMap(result => successValue(notionGetPagePropertyAction.id, result)),
      Effect.flatMap(
        decodeAs(
          PropertyItemPage,
          'expected a paginated property item list: object list, type property_item, property_item, has_more, next_cursor'
        )
      )
    )

const PropertyIds = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }))

const percentEscape = /%[0-9A-Fa-f]{2}/

export const notionPropertyItemPagingCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.pages.property-item-paging',
  title: 'Long page properties page item by item through the property endpoint',
  safety: 'read',
  docs: '`notion.get_page_property` sends GET /v1/pages/{page_id}/properties/{property_id} (the property id percent-encoded again by the connector) with `page_size` and `start_cursor`, and returns the body untyped. Page objects truncate paginated properties (title, rich_text, relation, people) to 25 items, so hosts read long values here.',
  wire: 'Two sub-claims. (1) Notion accepts the property id percent-encoded again: the seeded id, read from the page object exactly as returned and containing a `%XX` escape, is sent as `.../properties/<encodeURIComponent(id)>` (for example `Syn%3Ap` as `Syn%253Ap`) and Notion answers the property rather than 400/404 (unverified: the id\'s own `next_url` uses the single-encoded form). (2) `notion.get_page_property` with `pageSize: 2` for a paginated property of more than two items answers `{ object: "list", type: "property_item", property_item: { type }, results, has_more: true, next_cursor }` whose results are `property_item` objects of the property type; following `next_cursor` returns the remaining items and ends with `has_more: false` and `next_cursor: null`.',
  fixtures: [notionPropertyItemPagingFixture.id],
  run: Effect.gen(function* () {
    const pageId = yield* requireSeed('propertyPageId')
    const propertyId = yield* requireSeed('propertyId')

    yield* expectConformance(
      percentEscape.test(propertyId),
      'precondition: propertyId must contain a %XX escape (exactly as the page returns it), so the second percent-encoding is exercised'
    )

    const owner = yield* getPage(pageId).pipe(
      Effect.flatMap(result => successValue(notionGetPageAction.id, result))
    )

    const properties = owner.properties ?? {}

    const ids = Schema.is(PropertyIds)(properties)
      ? Object.values(properties).map(property => property.id)
      : []

    yield* expectConformance(
      ids.includes(propertyId),
      'precondition: propertyId must be a property id of propertyPageId exactly as the page returns it'
    )

    const firstResult = yield* notionGetPagePropertyAction.executeTyped({
      integration,
      input: NotionGetPagePropertyInput.make({ pageId, propertyId, pageSize: propertyPageSize })
    })

    const rejected = failureOf(firstResult)

    if (rejected !== undefined && (rejected.status === 400 || rejected.status === 404)) {
      return yield* new ConformanceMismatch({
        message: `expected Notion to accept the property id percent-encoded again (HTTP ${rejected.status})`
      })
    }

    const first = yield* successValue(notionGetPagePropertyAction.id, firstResult).pipe(
      Effect.flatMap(
        decodeAs(
          PropertyItemPage,
          'expected a paginated property item list: object list, type property_item, property_item, has_more, next_cursor'
        )
      )
    )

    const type = first.property_item.type

    yield* expectConformance(
      paginatedPropertyTypes.includes(type),
      'precondition: propertyId must name a title, rich_text, relation, or people property',
      { actual: type }
    )

    if (!first.has_more) {
      return yield* new ConformanceMismatch({
        message: 'precondition: the seeded property needs more than two items'
      })
    }

    let page = first
    let items = 0

    for (let count = 1; ; count++) {
      yield* expectConformance(
        page.results.every(item => item.type === type),
        'expected every property item to carry the property type'
      )
      items += page.results.length

      if (!page.has_more) {
        break
      }

      if (page.next_cursor === null) {
        return yield* new ConformanceMismatch({
          message: 'expected a string next_cursor with has_more true'
        })
      }

      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: the seeded property spans more than ${pageCap} pages`
        })
      }

      page = yield* propertyPage(pageId, propertyId, page.next_cursor)
    }

    yield* expectConformance(
      items > propertyPageSize,
      'expected the next_cursor pages to return further property items'
    )
    yield* expectEqual(
      page.next_cursor,
      null,
      'expected the last property page to carry next_cursor null'
    )
  })
})

const DatabaseObject = Schema.Struct({
  object: Schema.Literal('database'),
  id: Schema.String,
  data_sources: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
})

const DataSourceObject = Schema.Struct({
  object: Schema.Literal('data_source'),
  id: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  parent: Schema.Struct({ type: Schema.Literal('database_id'), database_id: Schema.String })
})

const DataSourcePage = Schema.Struct({
  ...listFields,
  results: Schema.Array(
    Schema.Struct({
      object: Schema.Literal('page'),
      id: Schema.String,
      parent: Schema.Struct({ type: Schema.String, data_source_id: Schema.optional(Schema.String) })
    })
  )
})

export const notionDataSourceSplitCase: NotionConformanceCase = defineConformanceCase({
  id: 'notion.data-sources.database-split',
  title: 'Under 2025-09-03 a database lists its data sources, which hold the schema and the rows',
  safety: 'read',
  docs: 'The connector pins `Notion-Version: 2025-09-03` and offers database actions (`notion.get_database`) next to data source actions (`notion.get_data_source`, `notion.query_data_source`); `notion.create_page` accepts a `parentDataSourceId` for pages in a data source.',
  wire: '`notion.get_database` of the seeded database answers `object: "database"` with a non-empty `data_sources` array (`{ id, name }`), which is how hosts discover the ids the data source actions take; `notion.get_data_source` of its first data source answers `object: "data_source"` with the `properties` schema and `parent: { type: "database_id", database_id }` naming the database (unverified: the parent shape); `notion.query_data_source` with `pageSize: 1` answers pages whose `parent` is `{ type: "data_source_id", data_source_id }` naming that data source (unverified: the row parent shape).',
  fixtures: [notionDataSourceSplitFixture.id],
  run: Effect.gen(function* () {
    const databaseId = yield* requireSeed('databaseId')

    const raw = yield* notionGetDatabaseAction
      .executeTyped({ integration, input: NotionDatabaseIdInput.make({ databaseId }) })
      .pipe(Effect.flatMap(result => successValue(notionGetDatabaseAction.id, result)))

    const database = yield* decodeAs(
      DatabaseObject,
      'expected the database object to list data_sources ({ id, name })'
    )(raw)

    const [dataSource] = database.data_sources

    if (dataSource === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected the database to list at least one data source'
      })
    }

    const source = yield* notionGetDataSourceAction
      .executeTyped({
        integration,
        input: NotionDataSourceIdInput.make({ dataSourceId: dataSource.id })
      })
      .pipe(
        Effect.flatMap(result => successValue(notionGetDataSourceAction.id, result)),
        Effect.flatMap(
          decodeAs(
            DataSourceObject,
            'expected a data_source object with properties and a database_id parent'
          )
        )
      )

    yield* expectConformance(
      sameId(source.parent.database_id, databaseId),
      'expected the data source parent to name the seeded database'
    )

    const rows = yield* notionQueryDataSourceAction
      .executeTyped({
        integration,
        input: NotionQueryDataSourceInput.make({ dataSourceId: dataSource.id, pageSize: 1 })
      })
      .pipe(
        Effect.flatMap(result => successValue(notionQueryDataSourceAction.id, result)),
        Effect.flatMap(
          decodeAs(DataSourcePage, 'expected the data source query to answer a list of pages')
        )
      )

    if (rows.results.length === 0) {
      return yield* new ConformanceMismatch({
        message: 'precondition: the first data source of databaseId needs at least one page'
      })
    }

    yield* expectConformance(
      rows.results.every(
        row =>
          row.parent.type === 'data_source_id' &&
          row.parent.data_source_id !== undefined &&
          sameId(row.parent.data_source_id, dataSource.id)
      ),
      'expected every queried page parent to be { type: "data_source_id" } naming the data source'
    )
  })
})

// Write case.

/** The trash flags an archive response or page may carry. */
const TrashFlags = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  in_trash: Schema.optional(Schema.Boolean)
})

/** True when an untyped page body shows the page trashed (`archived` or `in_trash` true). */
const showsTrashed = (value: unknown): boolean =>
  Schema.is(TrashFlags)(value) && (value.archived === true || value.in_trash === true)

const ArchiveResponse = Schema.Struct({
  object: Schema.Literal('page'),
  id: Schema.String,
  archived: Schema.optional(Schema.Boolean),
  in_trash: Schema.optional(Schema.Boolean)
})

const archiveCaseId = 'notion.pages.archive-in-trash'

const archivePageTitle = `${notionConformanceMarker} page: safe to delete`

const archivePage = (pageId: string) =>
  notionUpdatePageAction.executeTyped({
    integration,
    input: NotionUpdatePageInput.make({ pageId, archived: true })
  })

/**
 * Trash a case-created page unless it already is. Proof of trashing: `notion.get_page` reporting
 * `archived`, an archive response showing `archived` or `in_trash`, or a not-found read after an
 * archive succeeded (`archivedOnce`).
 */
const ensureTrashed = (archivedOnce: Ref.Ref<boolean>) => (pageId: string) =>
  Effect.gen(function* () {
    const current = yield* getPage(pageId)

    if (Predicate.isTagged(current, 'Success') && current.value.archived === true) return

    if (Predicate.isTagged(current, 'Failure')) {
      if (current.error.code === 'notion_not_found' && (yield* Ref.get(archivedOnce))) return

      return yield* successValue(notionGetPageAction.id, current).pipe(Effect.asVoid)
    }

    const archived = yield* archivePage(pageId).pipe(
      Effect.flatMap(result => successValue(notionUpdatePageAction.id, result))
    )

    yield* Ref.set(archivedOnce, true)

    if (showsTrashed(archived)) return

    const after = yield* getPage(pageId)

    if (Predicate.isTagged(after, 'Failure') && after.error.code === 'notion_not_found') return

    yield* expectEqual(
      Predicate.isTagged(after, 'Success') ? (after.value.archived ?? null) : null,
      true,
      'expected get_page of the case-created page to report archived after restoring'
    )
  })

/**
 * An ambiguous create failure (transport or decoding failure, no status, or HTTP 5xx), or
 * `undefined` for a failure that proves nothing was created.
 */
const ambiguousCreateFailure = (error: unknown): NotionConformanceActionFailed | undefined => {
  if (error instanceof NotionConformanceActionFailed) {
    if (error.status === undefined) {
      return new NotionConformanceActionFailed({
        actionId: error.actionId,
        code: error.code,
        createOutcome: 'unknown'
      })
    }

    return error.status >= 500
      ? new NotionConformanceActionFailed({
          actionId: error.actionId,
          code: error.code,
          status: error.status,
          createOutcome: 'unknown'
        })
      : undefined
  }

  if (
    error instanceof ConnectorError &&
    (error.cause === 'transport_failed' || error.cause === 'validation_failed')
  ) {
    return new NotionConformanceActionFailed({
      actionId: notionCreatePageAction.id,
      code: error.cause,
      createOutcome: 'unknown'
    })
  }

  return undefined
}

/**
 * Create the case-owned page, run `use`, then ALWAYS trash whatever is still pending. The create,
 * its decoding, and the id registration run uninterruptibly; `use` runs interruptibly; the restore
 * runs uninterruptibly after `use` succeeds, fails, or is interrupted.
 */
const withOwnPage = <A, E, R>(
  parentPageId: string,
  use: (
    page: NotionPage,
    pending: Ref.Ref<ReadonlyArray<string>>,
    archivedOnce: Ref.Ref<boolean>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<ReadonlyArray<string>>([])
    const archivedOnce = yield* Ref.make(false)

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const created = yield* notionCreatePageAction
          .executeTyped({
            integration,
            input: NotionCreatePageInput.make({ parentPageId, title: archivePageTitle })
          })
          .pipe(
            Effect.flatMap(result => successValue(notionCreatePageAction.id, result)),
            Effect.mapError(error => ambiguousCreateFailure(error) ?? error),
            Effect.exit
          )

        if (Exit.isFailure(created)) {
          const error = Cause.findErrorOption(created.cause)

          // An unknown-outcome create is also reported when the case was interrupted meanwhile.
          if (
            Option.isSome(error) &&
            error.value instanceof NotionConformanceActionFailed &&
            error.value.createOutcome === 'unknown' &&
            (yield* interruptPending(unmask))
          ) {
            yield* reportCleanupProblem(error.value)
          }

          return yield* created
        }

        const page = created.value

        yield* Ref.set(pending, [page.id])

        const outcome = yield* Effect.exit(unmask(use(page, pending, archivedOnce)))

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(ids =>
              Effect.forEach(ids, ensureTrashed(archivedOnce), { discard: true })
            )
          )
        )

        if (Exit.isFailure(restored)) {
          const failure = Exit.isSuccess(outcome)
            ? new NotionConformanceRestoreFailed({
                caseId: archiveCaseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim held'
              })
            : new NotionConformanceRestoreFailed({
                caseId: archiveCaseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim failed',
                claimFailure: failureSummary(outcome.cause)
              })

          // An interruption may replace this failure (and its advice): report it first.
          if (
            (Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)) ||
            (yield* interruptPending(unmask))
          ) {
            yield* reportCleanupProblem(failure)
          }

          return yield* failure
        }

        return yield* outcome
      })
    )
  })

export const notionArchiveInTrashCase: NotionConformanceCase = defineConformanceCase({
  id: archiveCaseId,
  title: 'Archiving a page reports archived, and the page reads back archived',
  safety: 'write-reversible',
  docs: '`notion.update_page` sends PATCH /v1/pages/{id} with `archived` (the connector has no delete-page action; archiving is its delete) and returns the body untyped; `notion.get_page` decodes `NotionPage`, whose optional `archived` flag is how hosts see a trashed page.',
  wire: '`notion.update_page` with `archived: true` on the case-owned page answers the page with `archived: true` (unverified: that 2025-09-03 still returns `archived` next to `in_trash`; `in_trash` is not checked); afterwards `notion.get_page` still answers HTTP 200 (not 404) with `archived: true` (unverified: that a trashed page stays readable). The case creates its own page under the seeded parent page with `notion.create_page` and moves it to the trash again whenever the claim did not; trashed pages stay restorable in the workspace trash.',
  fixtures: [notionArchiveInTrashFixture.id],
  run: Effect.gen(function* () {
    const parentPageId = yield* requireSeed('parentPageId')

    yield* withOwnPage(parentPageId, (page, pending, archivedOnce) =>
      Effect.gen(function* () {
        const response = yield* archivePage(page.id).pipe(
          Effect.flatMap(result => successValue(notionUpdatePageAction.id, result))
        )

        yield* Ref.set(archivedOnce, true)

        // The page is known to be trashed: no restore is needed, whatever the claims below find.
        if (showsTrashed(response)) {
          yield* Ref.set(pending, [])
        }

        const archived = yield* decodeAs(
          ArchiveResponse,
          'expected the archive response to be the page object'
        )(response)

        yield* expectEqual(
          archived.archived ?? null,
          true,
          'expected the archive response to report archived true'
        )

        const after = yield* getPage(page.id)

        if (Predicate.isTagged(after, 'Failure')) {
          return yield* new ConformanceMismatch({
            message: 'expected get_page of the archived page to still answer (not 404)',
            actual: after.error.status ?? null
          })
        }

        yield* expectEqual(
          after.value.archived ?? null,
          true,
          'expected get_page of the archived page to report archived true'
        )
        yield* Ref.set(pending, [])
      })
    )
  })
})

/** Search pages read while looking for leftovers, before giving up. */
const leftoverPageCap = 10

const LeftoverCandidate = Schema.Struct({
  object: Schema.String,
  id: Schema.String,
  archived: Schema.optional(Schema.Boolean),
  in_trash: Schema.optional(Schema.Boolean),
  properties: Schema.optional(NotionProperties)
})

/** The plain-text title of a page's `title` property, or `undefined`. */
const pageTitle = (
  properties: (typeof LeftoverCandidate.Type)['properties']
): string | undefined => {
  const title = Object.values(properties ?? {}).find(Schema.is(TitleValue))

  if (title === undefined || !Schema.is(NotionTitleProperty)(title)) {
    return undefined
  }

  return title.title.map(item => item.plain_text ?? '').join('')
}

/**
 * READ-ONLY and best effort: pages titled `yolk-conformance page...` that are not in the trash,
 * found through `notion.search` (whose index can lag behind recent writes). Earlier runs leave them
 * behind when a process is killed or a cleanup fails. Live runners call it before the write case
 * and warn per leftover (`title (id)`); nothing is ever trashed automatically.
 */
export const findNotionConformanceLeftovers: Effect.Effect<
  ReadonlyArray<string>,
  NotionConformanceError,
  NotionConformanceRequirements
> = Effect.gen(function* () {
  const found: Array<string> = []
  let startCursor: string | undefined

  for (let count = 1; count <= leftoverPageCap; count++) {
    const page = yield* notionSearchAction
      .executeTyped({
        integration,
        input: NotionSearchInput.make({
          query: notionConformanceMarker,
          filter: { property: 'object', value: 'page' },
          pageSize: 100,
          startCursor
        })
      })
      .pipe(Effect.flatMap(result => successValue(notionSearchAction.id, result)))

    for (const result of page.results) {
      if (
        !Schema.is(LeftoverCandidate)(result) ||
        result.archived === true ||
        result.in_trash === true
      ) {
        continue
      }

      const title = pageTitle(result.properties)

      if (title?.startsWith(`${notionConformanceMarker} page`) === true) {
        found.push(`${title} (${result.id})`)
      }
    }

    if (!page.hasMore || !Predicate.isString(page.nextCursor)) {
      break
    }

    startCursor = page.nextCursor
  }

  return found
})

/** Every Notion conformance case, in fixture order. */
export const notionConformanceCases: ReadonlyArray<NotionConformanceCase> = [
  notionSearchPagingCase,
  notionPinnedVersionCase,
  notionErrorEnvelopeCase,
  notionTitlePlainTextCase,
  notionBlockChildrenPagingCase,
  notionPropertyItemPagingCase,
  notionDataSourceSplitCase,
  notionArchiveInTrashCase
]
