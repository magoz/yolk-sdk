/**
 * Dropbox conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim the Dropbox connector relies on, running the REAL connector
 * actions (and the host-only `createDropboxFile` / `updateDropboxFile` upload helpers) over the
 * connector ports (`ConnectorHttpClient`, `ConnectorBinaryWriteHttpClient`, `CredentialResolver`)
 * plus the host-supplied `DropboxConformanceConfig` seed paths. The same cases run on replay
 * fixtures, an emulator, or by hand against a practice Dropbox account. None is observed live yet
 * (`observed` absent = unverified).
 *
 * Every write case works inside its own `yolk-conformance-*` folder under the seeded
 * `workFolderPath`. Before writing, it proves the folder path is absent; it then registers that
 * path for the restore BEFORE the create, so whatever the create outcome (success, rejection,
 * transport failure, or interruption) the restore deletes the path again, accepting "already gone",
 * and verifies that `get_metadata` answers not-found afterwards. Dropbox addresses items by path,
 * so no create outcome can leave an item the restore cannot name. A failed restore is reported as
 * `DropboxConformanceRestoreFailed` (never swallowed). Deleted items stay restorable in the
 * account's deleted files for the Dropbox retention period.
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
import type { ConnectorBinaryWriteHttpClient } from '../../binary-write-http.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type {
  ConnectorFileTransferBudget,
  ConnectorFileTransferError
} from '../../file-transfer.ts'
import type { ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult, ProviderFailure } from '../../result.ts'
import {
  DropboxCopyInput,
  DropboxCreateFolderInput,
  DropboxCursorInput,
  DropboxDeleteInput,
  DropboxGetMetadataInput,
  DropboxListFolderInput,
  DropboxMoveInput,
  DropboxSearchInput,
  dropboxCopyAction,
  dropboxCreateFolderAction,
  dropboxDeleteAction,
  dropboxGetMetadataAction,
  dropboxListFolderAction,
  dropboxListFolderContinueAction,
  dropboxMoveAction,
  dropboxSearchAction,
  dropboxSearchContinueAction,
  type DropboxFolderMetadata,
  type DropboxMetadata
} from '../index.ts'
import { dropboxConnectorId, dropboxOAuthSlotId } from '../shared.ts'
import { createDropboxFile, updateDropboxFile } from '../write.ts'
import { dropboxCopyMoveMetadataFixture } from './copy-move-metadata.ts'
import { dropboxCreateFolderConflictFixture } from './create-folder-conflict.ts'
import { dropboxDeleteThenNotFoundFixture } from './delete-then-not-found.ts'
import { dropboxListFolderPagingFixture } from './list-folder-paging.ts'
import { dropboxNotFoundEnvelopeFixture } from './not-found-envelope.ts'
import { dropboxPathLowerLookupFixture } from './path-lower-lookup.ts'
import { dropboxSearchContinueFixture } from './search-continue.ts'
import { dropboxUploadRevPreconditionFixture } from './upload-rev-precondition.ts'

const SeedString = Schema.Trimmed.check(Schema.isNonEmpty())

/** An absolute Dropbox path: `/`-separated, non-empty components, no trailing slash. */
const SeedPath = Schema.String.check(Schema.isPattern(/^(?:\/[^/\s][^/]*)+$/))

/**
 * Host-supplied seed paths in the practice Dropbox account. Cases never hard-code account data. A
 * case whose required seed is missing fails with a `precondition:` `ConformanceMismatch` before
 * any request.
 */
export const DropboxConformanceSeeds = Schema.Struct({
  /** A folder holding more than two entries, for list paging. */
  pagingFolderPath: Schema.optionalKey(SeedPath),
  /**
   * An existing file or folder whose last path component has upper-case letters, in its exact
   * display casing (for example `/Conformance/Mixed Case Notes.txt`).
   */
  mixedCasePath: Schema.optionalKey(SeedPath),
  /** A search query matching at least two entries (by file name). */
  searchQuery: Schema.optionalKey(SeedString),
  /**
   * An existing folder the write cases create (and remove) their own `yolk-conformance-*` folders
   * under; the error-envelope case looks up an absent child of it.
   */
  workFolderPath: Schema.optionalKey(SeedPath),
  /** A small file the copy/move case copies into its own folder. */
  copySourcePath: Schema.optionalKey(SeedPath)
})

export type DropboxConformanceSeeds = typeof DropboxConformanceSeeds.Type

export type DropboxConformanceSeedKey = keyof DropboxConformanceSeeds

/** Host-supplied seed paths for the Dropbox conformance cases. */
export class DropboxConformanceConfig extends Context.Service<
  DropboxConformanceConfig,
  DropboxConformanceSeeds
>()('@yolk-sdk/connectors/dropbox/conformance/DropboxConformanceConfig') {}

/**
 * Credential reference the cases bind to the `dropbox.oauth` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Dropbox OAuth or bearer credential.
 */
export const dropboxConformanceCredentialRef = 'dropbox.conformance'

/** The integration every Dropbox conformance case invokes the connector with. */
export const dropboxConformanceIntegration = makeIntegration({
  connectorId: dropboxConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: dropboxOAuthSlotId,
      credentialRef: dropboxConformanceCredentialRef
    })
  ]
})

/** Synthetic marker every case-created folder and file name starts with. */
export const dropboxConformanceMarker = 'yolk-conformance'

const restoreByHandAdvice = `delete the case-created folder by hand if it still exists (its name starts with ${dropboxConformanceMarker}, under workFolderPath).`

/**
 * A connector action or upload helper failed where the case needed success. `code` and `status`
 * keep the underlying classification (a `ConnectorError` cause such as `transport_failed`, or a
 * `ConnectorFileTransferError` code).
 */
export class DropboxConformanceActionFailed extends Data.TaggedError(
  'DropboxConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    return `${this.actionId} failed: ${this.code}${status}`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Removing a write case's own folder failed. `caseOutcome` says whether the claim itself held
 * before the restore; `claimFailure` is a sanitized summary of why it failed. The folder may or may
 * not still exist: check it, and delete it by hand only if it does.
 */
export class DropboxConformanceRestoreFailed extends Data.TaggedError(
  'DropboxConformanceRestoreFailed'
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

    // Conformance reports cap failure messages at 300 characters: the advice comes first.
    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type DropboxConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | DropboxConformanceActionFailed
  | DropboxConformanceRestoreFailed

/** What every Dropbox conformance case requires from the host. */
export type DropboxConformanceRequirements =
  | ConnectorHttpClient
  | ConnectorBinaryWriteHttpClient
  | CredentialResolver
  | DropboxConformanceConfig

export type DropboxConformanceCase = ConformanceCase<
  DropboxConformanceError,
  DropboxConformanceRequirements
>

const integration = dropboxConformanceIntegration

const requireSeed = <K extends DropboxConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* DropboxConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: DropboxConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, DropboxConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new DropboxConformanceActionFailed({ actionId, code })
      : new DropboxConformanceActionFailed({ actionId, code, status })
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

/** Longest failure summary embedded in a `DropboxConformanceRestoreFailed` message. */
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

  if (value instanceof DropboxConformanceActionFailed) {
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

// Dropbox error envelope: `{ error_summary, error: { ".tag": ..., <tag>: { ".tag": ... } } }`.

const TaggedUnion = Schema.Struct({ '.tag': Schema.String })

const DropboxErrorEnvelope = Schema.Struct({
  error_summary: Schema.String,
  error: Schema.Struct({
    '.tag': Schema.String,
    path: Schema.optional(
      Schema.Struct({
        '.tag': Schema.String,
        conflict: Schema.optional(TaggedUnion)
      })
    )
  })
})

type DropboxErrorEnvelope = typeof DropboxErrorEnvelope.Type

const decodeErrorEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(DropboxErrorEnvelope))

/** The Dropbox error envelope a failure's `underlying` body carries, or `undefined`. */
const errorEnvelope = (failure: ProviderFailure) =>
  Predicate.isString(failure.underlying)
    ? decodeErrorEnvelope(failure.underlying).pipe(
        Effect.result,
        Effect.map(result => (Result.isSuccess(result) ? result.success : undefined))
      )
    : Effect.succeed(undefined)

/** `.tag` chain of an envelope (`path/not_found`, `path/conflict/folder`) for mismatch details. */
const tagChain = (envelope: DropboxErrorEnvelope | undefined): string | null => {
  if (envelope === undefined) {
    return null
  }

  const { error } = envelope

  return [error['.tag'], error.path?.['.tag'], error.path?.conflict?.['.tag']]
    .filter(Predicate.isNotUndefined)
    .join('/')
}

/** The last `/`-separated component of a path. */
const lastComponent = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const pathKey = (entry: DropboxMetadata): string => entry.pathLower ?? entry.name

// Connector action shorthands.

const getMetadata = (path: string, includeDeleted?: boolean) =>
  dropboxGetMetadataAction.executeTyped({
    integration,
    input: DropboxGetMetadataInput.make(
      includeDeleted === undefined ? { path } : { path, includeDeleted }
    )
  })

const createFolder = (path: string) =>
  dropboxCreateFolderAction.executeTyped({
    integration,
    input: DropboxCreateFolderInput.make({ path, autorename: false })
  })

const deletePath = (path: string) =>
  dropboxDeleteAction.executeTyped({ integration, input: DropboxDeleteInput.make({ path }) })

const isNotFound = <A>(result: ActionResult<A>): boolean =>
  failureOf(result)?.code === 'dropbox_not_found'

// Write-case folders: absence proven first, path registered before the create, always restored.

/** Paths the restore must delete; a case drops a path once it has itself proven it is gone. */
type PendingPaths = Ref.Ref<ReadonlyArray<string>>

/** Fail unless nothing exists at `path` (before any write). */
const requireAbsent = (path: string) =>
  Effect.gen(function* () {
    const found = yield* getMetadata(path)

    if (Predicate.isTagged(found, 'Success')) {
      return yield* new ConformanceMismatch({
        message: `precondition: a Dropbox entry already exists at the case folder ${lastComponent(path)} under workFolderPath (left by an earlier run?); delete it by hand; nothing was written`
      })
    }

    if (!isNotFound(found)) {
      return yield* successValue(dropboxGetMetadataAction.id, found).pipe(Effect.asVoid)
    }
  })

/** Delete a case-created path that may still exist, then verify `get_metadata` answers not-found. */
const ensureAbsent = (path: string) =>
  Effect.gen(function* () {
    const deleted = yield* deletePath(path)

    if (!Predicate.isTagged(deleted, 'Success') && !isNotFound(deleted)) {
      return yield* successValue(dropboxDeleteAction.id, deleted).pipe(Effect.asVoid)
    }

    const after = yield* getMetadata(path)

    yield* expectConformance(
      isNotFound(after),
      'expected get_metadata of the case-created folder to answer not_found after restoring',
      { actual: outcomeOf(after) }
    )
  })

/**
 * Prove `path` is absent, register it, create the folder there, run `use`, then ALWAYS delete
 * every pending path and verify it is gone.
 *
 * The path is registered BEFORE the create: absence was just proven, so anything at the path
 * afterwards is the case's own, whatever the create answered (a rejection, a transport failure, an
 * interruption). The create and `use` run interruptibly; the restore runs uninterruptibly after
 * they succeed, fail, or are interrupted, and does nothing once `pending` is empty. A failed
 * restore fails the case with `DropboxConformanceRestoreFailed`, which says whether the claim
 * itself held; otherwise the outcome of `use` is returned unchanged.
 */
const withOwnFolder = <A, E, R>(
  caseId: string,
  path: string,
  use: (folder: DropboxFolderMetadata, pending: PendingPaths) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    yield* requireAbsent(path)

    const pending: PendingPaths = yield* Ref.make<ReadonlyArray<string>>([path])

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(
          unmask(
            createFolder(path).pipe(
              Effect.flatMap(result => successValue(dropboxCreateFolderAction.id, result)),
              Effect.flatMap(folder => use(folder, pending))
            )
          )
        )

        const restored = yield* Effect.exit(
          Ref.get(pending).pipe(
            Effect.flatMap(paths => Effect.forEach(paths, ensureAbsent, { discard: true }))
          )
        )

        if (Exit.isFailure(restored)) {
          return yield* Exit.isSuccess(outcome)
            ? new DropboxConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim held'
              })
            : new DropboxConformanceRestoreFailed({
                caseId,
                reason: failureSummary(restored.cause),
                caseOutcome: 'claim failed',
                claimFailure: failureSummary(outcome.cause)
              })
        }

        return yield* outcome
      })
    )
  })

/** The case folder path `<workFolderPath>/<name>`. */
const caseFolderPath = (name: string) =>
  requireSeed('workFolderPath').pipe(Effect.map(work => `${work}/${name}`))

// Read cases.

/** List page size (Dropbox treats `limit` as approximate), and the page cap. */
const listLimit = 2

const pageCap = 10

export const dropboxListFolderPagingCase: DropboxConformanceCase = defineConformanceCase({
  id: 'dropbox.files.list-folder-cursor-paging',
  title: 'A folder listing larger than the limit pages through list_folder/continue',
  safety: 'read',
  docs: '`dropbox.list_folder` sends `/files/list_folder` with an optional `limit` and returns `{ entries, cursor, hasMore }`; `dropbox.list_folder_continue` sends `/files/list_folder/continue` with that cursor. The connector requires `cursor` and `has_more` on every page and never follows a cursor by itself.',
  wire: '`dropbox.list_folder` with `limit: 2` on a folder seeded with more than two entries answers `has_more: true` with a non-empty `cursor`; following it through `dropbox.list_folder_continue` returns the remaining entries (none repeated, compared by `path_lower`) and ends with `has_more: false` and a cursor still present. Dropbox documents `limit` as approximate, so the case does not pin the page size.',
  fixtures: [dropboxListFolderPagingFixture.id],
  run: Effect.gen(function* () {
    const path = yield* requireSeed('pagingFolderPath')

    const first = yield* dropboxListFolderAction
      .executeTyped({ integration, input: DropboxListFolderInput.make({ path, limit: listLimit }) })
      .pipe(Effect.flatMap(result => successValue(dropboxListFolderAction.id, result)))

    if (!first.hasMore) {
      return yield* new ConformanceMismatch({
        message:
          first.entries.length <= listLimit
            ? 'precondition: pagingFolderPath needs more than two entries'
            : 'expected has_more for a listing larger than the limit'
      })
    }

    yield* expectConformance(
      first.cursor.length > 0,
      'expected a non-empty cursor with has_more true'
    )

    const seen = first.entries.map(pathKey)
    let page = first

    for (let count = 1; page.hasMore; count++) {
      if (count >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `precondition: the paging folder spans more than ${pageCap} pages; use a smaller folder`
        })
      }

      page = yield* dropboxListFolderContinueAction
        .executeTyped({ integration, input: DropboxCursorInput.make({ cursor: page.cursor }) })
        .pipe(Effect.flatMap(result => successValue(dropboxListFolderContinueAction.id, result)))

      const keys = page.entries.map(pathKey)

      yield* expectConformance(
        keys.every(key => !seen.includes(key)),
        'expected list_folder/continue to repeat no entry from an earlier page',
        { actual: keys.filter(key => seen.includes(key)).length }
      )
      seen.push(...keys)
    }

    yield* expectConformance(
      seen.length > first.entries.length,
      'expected list_folder/continue to return further entries'
    )
    yield* expectConformance(
      page.cursor.length > 0,
      'expected the last page to still carry a cursor (has_more false)'
    )
  })
})

export const dropboxPathLowerLookupCase: DropboxConformanceCase = defineConformanceCase({
  id: 'dropbox.files.path-lower-lookup',
  title: 'Path lookups are case-insensitive and path_lower is the lower-cased path',
  safety: 'read',
  docs: 'Dropbox metadata carries `path_lower` (the lower-cased path, for comparisons) and `path_display` (display casing; only the last component is guaranteed to keep the user casing). The connector exposes both unchanged as `pathLower` and `pathDisplay` and accepts any-cased paths as input.',
  wire: '`dropbox.get_metadata` of the seeded mixed-case path, and of the same path lower-cased, return the same entry id; `pathLower` equals the lower-cased seeded path in both, and the last component of `pathDisplay` keeps the seeded casing even when the lookup was lower-cased.',
  fixtures: [dropboxPathLowerLookupFixture.id],
  run: Effect.gen(function* () {
    const path = yield* requireSeed('mixedCasePath')
    const lower = path.toLowerCase()

    yield* expectConformance(
      lower !== path,
      'precondition: mixedCasePath needs upper-case letters in its last component'
    )

    const exact = yield* getMetadata(path).pipe(
      Effect.flatMap(result => successValue(dropboxGetMetadataAction.id, result))
    )

    const lowered = yield* getMetadata(lower).pipe(
      Effect.flatMap(result => successValue(dropboxGetMetadataAction.id, result))
    )

    if (exact.type === 'deleted' || lowered.type === 'deleted') {
      return yield* new ConformanceMismatch({
        message: 'precondition: mixedCasePath must name an existing file or folder'
      })
    }

    yield* expectEqual(
      lowered.id,
      exact.id,
      'expected the lower-cased lookup to return the same entry id'
    )

    for (const entry of [exact, lowered]) {
      yield* expectEqual(
        entry.pathLower ?? null,
        lower,
        'expected path_lower to equal the lower-cased seeded path'
      )
      yield* expectEqual(
        lastComponent(entry.pathDisplay ?? ''),
        lastComponent(path),
        'expected the last component of path_display to keep the seeded casing'
      )
    }
  })
})

const searchPageSize = 1

export const dropboxSearchContinueCase: DropboxConformanceCase = defineConformanceCase({
  id: 'dropbox.files.search-continue',
  title: 'Search pages through search/continue_v2 with nested match metadata',
  safety: 'read',
  docs: '`dropbox.search` sends `/files/search_v2` (`options.max_results`) and `dropbox.search_continue` sends `/files/search/continue_v2`. The connector decodes each match as `{ metadata: { ".tag": "metadata", metadata: <file or folder> } }` and treats `cursor` as optional.',
  wire: '`dropbox.search` with `maxResults: 1` for a query seeded to match at least two entries returns at most one match (with the nested metadata envelope the connector decodes), `has_more: true`, and a `cursor`; `dropbox.search_continue` with that cursor returns at least one further match, none repeated from the first page (compared by `path_lower`).',
  fixtures: [dropboxSearchContinueFixture.id],
  run: Effect.gen(function* () {
    const query = yield* requireSeed('searchQuery')

    const first = yield* dropboxSearchAction
      .executeTyped({
        integration,
        input: DropboxSearchInput.make({ query, maxResults: searchPageSize, filenameOnly: true })
      })
      .pipe(Effect.flatMap(result => successValue(dropboxSearchAction.id, result)))

    yield* expectConformance(
      first.matches.length <= searchPageSize,
      'expected at most max_results matches on the first page',
      { actual: first.matches.length }
    )

    if (!first.hasMore) {
      return yield* new ConformanceMismatch({
        message: 'precondition: searchQuery needs at least two matching entries'
      })
    }

    if (first.cursor === undefined || first.cursor.length === 0) {
      return yield* new ConformanceMismatch({
        message: 'expected a search cursor with has_more true'
      })
    }

    const second = yield* dropboxSearchContinueAction
      .executeTyped({ integration, input: DropboxCursorInput.make({ cursor: first.cursor }) })
      .pipe(Effect.flatMap(result => successValue(dropboxSearchContinueAction.id, result)))

    const firstKeys = first.matches.map(match => pathKey(match.metadata))

    yield* expectConformance(
      second.matches.length > 0,
      'expected search/continue_v2 to return further matches'
    )
    yield* expectConformance(
      second.matches.every(match => !firstKeys.includes(pathKey(match.metadata))),
      'expected search/continue_v2 to repeat no match from the first page'
    )
  })
})

const absentChildName = `${dropboxConformanceMarker}-absent`

export const dropboxNotFoundEnvelopeCase: DropboxConformanceCase = defineConformanceCase({
  id: 'dropbox.errors.not-found-409-envelope',
  title: 'A missing path answers HTTP 409 with a path/not_found error envelope',
  safety: 'read',
  docs: 'Dropbox RPC endpoints answer route errors with HTTP 409 and a JSON body `{ error_summary, error: { ".tag": ... } }`. The connector classifies 409 from `error_summary`, not the status alone (`not_found` becomes `dropbox_not_found`, `conflict` becomes `dropbox_conflict`), and keeps the body as `underlying`.',
  wire: '`dropbox.get_metadata` of an absent child of the seeded work folder fails with HTTP 409 (not 404), an `error_summary` starting `path/not_found/`, and `error` tagged `path` with `path: { ".tag": "not_found" }`; the connector reports it as `dropbox_not_found` with status 409.',
  fixtures: [dropboxNotFoundEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const path = yield* caseFolderPath(absentChildName)
    const result = yield* getMetadata(path)
    const failure = failureOf(result)

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: ${absentChildName} must not exist under workFolderPath`
      })
    }

    yield* expectEqual(failure.status ?? null, 409, 'expected HTTP 409 for a missing path')
    yield* expectEqual(
      failure.code,
      'dropbox_not_found',
      'expected the connector to classify the 409 as dropbox_not_found'
    )

    const envelope = yield* errorEnvelope(failure)

    yield* expectConformance(
      envelope?.error_summary.startsWith('path/not_found/') === true,
      'expected an error_summary starting path/not_found/',
      { actual: envelope?.error_summary ?? null }
    )
    yield* expectEqual(
      tagChain(envelope),
      'path/not_found',
      'expected the error envelope tagged path/not_found'
    )
  })
})

// Write cases.

const conflictFolderName = `${dropboxConformanceMarker}-folder`

const createFolderConflictCaseId = 'dropbox.files.create-folder-conflict'

/** A conflicting create: register any path a surprising success created, then return the failure. */
const conflictingCreate = (path: string, pending: PendingPaths) =>
  Effect.gen(function* () {
    const result = yield* createFolder(path)

    if (Predicate.isTagged(result, 'Success')) {
      const created = result.value.pathLower ?? path.toLowerCase()

      // Dropbox paths are case-insensitive: a path already pending (in any casing) is covered.
      yield* Ref.update(pending, paths =>
        paths.some(pendingPath => pendingPath.toLowerCase() === created)
          ? paths
          : [...paths, created]
      )
    }

    return result
  })

const expectFolderConflict = <A>(result: ActionResult<A>, message: string) =>
  Effect.gen(function* () {
    const failure = failureOf(result)

    yield* expectConformance(
      failure?.code === 'dropbox_conflict' && failure.status === 409,
      message,
      { actual: outcomeOf(result) }
    )

    const envelope = failure === undefined ? undefined : yield* errorEnvelope(failure)

    yield* expectEqual(
      tagChain(envelope),
      'path/conflict/folder',
      'expected the conflict error envelope tagged path/conflict/folder'
    )
  })

export const dropboxCreateFolderConflictCase: DropboxConformanceCase = defineConformanceCase({
  id: createFolderConflictCaseId,
  title: 'Creating an existing folder, in any casing, is a path/conflict/folder error',
  safety: 'write-reversible',
  docs: '`dropbox.create_folder` sends `/files/create_folder_v2` with `autorename` and decodes `{ metadata }` (the folder metadata of this route may omit `.tag`). The connector maps a 409 whose `error_summary` contains `conflict` to `dropbox_conflict`.',
  wire: 'Creating the case-owned folder (autorename false) returns folder metadata with the requested name; creating it again fails with HTTP 409 and `error_summary` `path/conflict/folder/...` (`dropbox_conflict`), and creating the same name upper-cased fails the same way, because Dropbox paths are case-insensitive. The case works in its own folder under the seeded work folder and deletes it again even when a step fails.',
  fixtures: [dropboxCreateFolderConflictFixture.id],
  run: Effect.gen(function* () {
    const path = yield* caseFolderPath(conflictFolderName)

    yield* withOwnFolder(createFolderConflictCaseId, path, (folder, pending) =>
      Effect.gen(function* () {
        yield* expectEqual(
          folder.name,
          conflictFolderName,
          'expected the created folder to carry the requested name'
        )
        yield* expectEqual(
          folder.pathLower ?? null,
          path.toLowerCase(),
          'expected the created folder path_lower to equal the requested path lower-cased'
        )

        yield* expectFolderConflict(
          yield* conflictingCreate(path, pending),
          'expected creating the same folder again to fail with dropbox_conflict (HTTP 409)'
        )

        const upperPath = `${path.slice(0, path.lastIndexOf('/'))}/${conflictFolderName.toUpperCase()}`

        yield* expectFolderConflict(
          yield* conflictingCreate(upperPath, pending),
          'expected creating the folder name upper-cased to fail with dropbox_conflict (HTTP 409)'
        )
      })
    )
  })
})

const deleteFolderName = `${dropboxConformanceMarker}-delete`

const deleteCaseId = 'dropbox.files.delete-then-not-found'

export const dropboxDeleteThenNotFoundCase: DropboxConformanceCase = defineConformanceCase({
  id: deleteCaseId,
  title: 'A deleted folder answers not_found, and deleted metadata only on request',
  safety: 'write-reversible',
  docs: '`dropbox.delete` sends `/files/delete_v2` and decodes `{ metadata }` of the deleted item; `dropbox.get_metadata` sends `include_deleted` and decodes file, folder, or `deleted` metadata.',
  wire: '`dropbox.delete` of the case-owned folder returns its metadata tagged `folder` (the item as it was, not `deleted`); afterwards `dropbox.get_metadata` fails with 409 `path/not_found` (`dropbox_not_found`), while `dropbox.get_metadata` with `includeDeleted: true` returns metadata tagged `deleted` for the same path. The case works in its own folder under the seeded work folder and deletes it again whenever the claim did not.',
  fixtures: [dropboxDeleteThenNotFoundFixture.id],
  run: Effect.gen(function* () {
    const path = yield* caseFolderPath(deleteFolderName)

    yield* withOwnFolder(deleteCaseId, path, (_folder, pending) =>
      Effect.gen(function* () {
        const deleted = yield* deletePath(path).pipe(
          Effect.flatMap(result => successValue(dropboxDeleteAction.id, result))
        )

        yield* expectEqual(
          deleted.type,
          'folder',
          'expected delete_v2 to return the deleted item metadata tagged folder'
        )
        yield* expectEqual(
          deleted.pathLower ?? null,
          path.toLowerCase(),
          'expected delete_v2 to return the deleted folder path'
        )

        const after = yield* getMetadata(path)

        yield* expectConformance(
          isNotFound(after) && failureOf(after)?.status === 409,
          'expected get_metadata after delete to fail with dropbox_not_found (HTTP 409)',
          { actual: outcomeOf(after) }
        )
        yield* Ref.set(pending, [])

        const tombstone = yield* getMetadata(path, true).pipe(
          Effect.flatMap(result => successValue(dropboxGetMetadataAction.id, result))
        )

        yield* expectEqual(
          tombstone.type,
          'deleted',
          'expected get_metadata with include_deleted to return deleted metadata'
        )
        yield* expectEqual(
          tombstone.pathLower ?? null,
          path.toLowerCase(),
          'expected the deleted metadata to name the deleted path'
        )
      })
    )
  })
})

const copyFolderName = `${dropboxConformanceMarker}-copy`

const copyCaseId = 'dropbox.files.copy-move-metadata'

export const dropboxCopyMoveMetadataCase: DropboxConformanceCase = defineConformanceCase({
  id: copyCaseId,
  title: 'Single-item copy_v2 and move_v2 answer the relocated metadata synchronously',
  safety: 'write-reversible',
  docs: '`dropbox.copy` sends `/files/copy_v2` and `dropbox.move` sends `/files/move_v2`; the connector decodes the single-item result `{ metadata }` (async job unions belong to the batch routes the connector does not call).',
  wire: '`dropbox.copy` of the seeded source file into the case-owned folder answers `{ metadata }` for a NEW file (a different id) at the destination path with the source size and content hash; `dropbox.move` of that copy to a new name answers `{ metadata }` for the SAME id at the new path. Neither answers an async job. The case works in its own folder under the seeded work folder and deletes it (with the copy) again even when a step fails.',
  fixtures: [dropboxCopyMoveMetadataFixture.id],
  run: Effect.gen(function* () {
    const sourcePath = yield* requireSeed('copySourcePath')
    const path = yield* caseFolderPath(copyFolderName)

    const source = yield* getMetadata(sourcePath).pipe(
      Effect.flatMap(result => successValue(dropboxGetMetadataAction.id, result))
    )

    if (source.type !== 'file') {
      return yield* new ConformanceMismatch({
        message: 'precondition: copySourcePath must name a file'
      })
    }

    yield* withOwnFolder(copyCaseId, path, () =>
      Effect.gen(function* () {
        const copyPath = `${path}/${dropboxConformanceMarker}-copied`
        const movePath = `${path}/${dropboxConformanceMarker}-moved`

        const copied = yield* dropboxCopyAction
          .executeTyped({
            integration,
            input: DropboxCopyInput.make({
              fromPath: sourcePath,
              toPath: copyPath,
              autorename: false
            })
          })
          .pipe(Effect.flatMap(result => successValue(dropboxCopyAction.id, result)))

        if (copied.type !== 'file') {
          return yield* new ConformanceMismatch({
            message: 'expected copy_v2 to return file metadata for a copied file',
            actual: copied.type
          })
        }

        yield* expectConformance(
          copied.id !== source.id,
          'expected the copy to be a new file with its own id'
        )
        yield* expectEqual(
          copied.pathLower ?? null,
          copyPath.toLowerCase(),
          'expected copy_v2 metadata at the destination path'
        )
        yield* expectConformance(
          copied.size === source.size &&
            (source.contentHash === undefined || copied.contentHash === source.contentHash),
          'expected the copy to carry the source size and content hash'
        )

        const moved = yield* dropboxMoveAction
          .executeTyped({
            integration,
            input: DropboxMoveInput.make({
              fromPath: copyPath,
              toPath: movePath,
              autorename: false
            })
          })
          .pipe(Effect.flatMap(result => successValue(dropboxMoveAction.id, result)))

        if (moved.type !== 'file') {
          return yield* new ConformanceMismatch({
            message: 'expected move_v2 to return file metadata for a moved file',
            actual: moved.type
          })
        }

        yield* expectEqual(moved.id, copied.id, 'expected the moved file to keep its id')
        yield* expectEqual(
          moved.pathLower ?? null,
          movePath.toLowerCase(),
          'expected move_v2 metadata at the new path'
        )
      })
    )
  })
})

const uploadFolderName = `${dropboxConformanceMarker}-upload`

const uploadCaseId = 'dropbox.files.upload-rev-precondition'

/** Trusted conformance transfer limits for the tiny upload bodies below. */
const uploadBudget: ConnectorFileTransferBudget = {
  maxBytes: 4096,
  maxMetadataBytes: 65_536,
  maxErrorBodyBytes: 65_536
}

const uploadBytes = (version: string) =>
  new TextEncoder().encode(`${dropboxConformanceMarker} synthetic upload ${version}\n`)

const uploadActionIds = {
  create: 'dropbox.conformance.upload_create',
  update: 'dropbox.conformance.upload_update'
} as const

/** Map a transfer failure to a case failure (the upload helpers return code-only errors). */
const transferFailed = (actionId: string) => (error: ConnectorFileTransferError) =>
  error.status === undefined
    ? new DropboxConformanceActionFailed({ actionId, code: error.code })
    : new DropboxConformanceActionFailed({ actionId, code: error.code, status: error.status })

/** The outcome of an upload that must be rejected: `code status`, or `success`. */
const rejectedUpload = <A, R>(upload: Effect.Effect<A, ConnectorFileTransferError, R>) =>
  upload.pipe(
    Effect.map(() => 'success'),
    Effect.catchTag('ConnectorFileTransferError', error =>
      Effect.succeed(`${error.code} ${error.status ?? 'no-status'}`)
    )
  )

export const dropboxUploadRevPreconditionCase: DropboxConformanceCase = defineConformanceCase({
  id: uploadCaseId,
  title: 'Upload add never overwrites and a stale rev update is a conflict',
  safety: 'write-reversible',
  docs: '`createDropboxFile` uploads through `/files/upload` with mode `add`, and `updateDropboxFile` with mode `{ ".tag": "update", update: <rev> }` addressed by file id; both send `autorename: false` and `strict_conflict: true`, and map HTTP 409 to the code-only transfer error `conflict`.',
  wire: 'In the case-owned folder: an `add` upload creates the file (rev A); an `update` with rev A replaces it under the same id (rev B); an `update` that still names rev A fails with HTTP 409 (`conflict`), and a second `add` to the same path fails with HTTP 409 too; `dropbox.get_metadata` then still reports rev B and its size, so neither rejected write changed the file. The case works in its own folder under the seeded work folder and deletes it again even when a step fails.',
  fixtures: [dropboxUploadRevPreconditionFixture.id],
  run: Effect.gen(function* () {
    const path = yield* caseFolderPath(uploadFolderName)

    yield* withOwnFolder(uploadCaseId, path, () =>
      Effect.gen(function* () {
        const filePath = `${path}/${dropboxConformanceMarker}-upload.txt`
        const second = uploadBytes('v2')

        const created = yield* createDropboxFile(
          integration,
          { path: filePath, bytes: uploadBytes('v1') },
          uploadBudget
        ).pipe(Effect.mapError(transferFailed(uploadActionIds.create)))

        const updated = yield* updateDropboxFile(
          integration,
          { fileId: created.id, expectedRev: created.rev, bytes: second },
          uploadBudget
        ).pipe(Effect.mapError(transferFailed(uploadActionIds.update)))

        yield* expectEqual(updated.id, created.id, 'expected the update to keep the file id')
        yield* expectConformance(
          updated.rev !== created.rev,
          'expected the update to produce a new rev'
        )

        yield* expectEqual(
          yield* rejectedUpload(
            updateDropboxFile(
              integration,
              { fileId: created.id, expectedRev: created.rev, bytes: uploadBytes('v3') },
              uploadBudget
            )
          ),
          'conflict 409',
          'expected an update naming a stale rev to fail with conflict (HTTP 409)'
        )
        yield* expectEqual(
          yield* rejectedUpload(
            createDropboxFile(
              integration,
              { path: filePath, bytes: uploadBytes('v3') },
              uploadBudget
            )
          ),
          'conflict 409',
          'expected an add upload to an existing path to fail with conflict (HTTP 409)'
        )

        const current = yield* getMetadata(filePath).pipe(
          Effect.flatMap(result => successValue(dropboxGetMetadataAction.id, result))
        )

        yield* expectConformance(
          current.type === 'file' &&
            current.rev === updated.rev &&
            current.size === second.byteLength,
          'expected the rejected writes to leave the updated rev and size unchanged',
          { expected: updated.rev, actual: current.type === 'file' ? current.rev : current.type }
        )
      })
    )
  })
})

/** Every Dropbox conformance case, in fixture order. */
export const dropboxConformanceCases: ReadonlyArray<DropboxConformanceCase> = [
  dropboxListFolderPagingCase,
  dropboxPathLowerLookupCase,
  dropboxSearchContinueCase,
  dropboxNotFoundEnvelopeCase,
  dropboxCreateFolderConflictCase,
  dropboxDeleteThenNotFoundCase,
  dropboxCopyMoveMetadataCase,
  dropboxUploadRevPreconditionCase
]
