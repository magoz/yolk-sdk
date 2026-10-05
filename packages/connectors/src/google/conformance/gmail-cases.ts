/**
 * Gmail conformance cases (internal module; exported through `cases.ts`). See `cases.ts` for the
 * write-safety contract every write case follows.
 */
import { Effect, Predicate, Ref, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual
} from '@yolk-sdk/conformance/case'
import { classifyWriteExit, failReportingForCase } from '../../conformance/cleanup-reporter.ts'
import type { ActionResult } from '../../result.ts'
import {
  gmailCreateLabelAction,
  GmailCreateLabelInput,
  gmailDeleteLabelAction,
  gmailDraftComposeAction,
  GmailDraftComposeInput,
  gmailDraftDeleteAction,
  GmailDraftIdInput,
  gmailDraftUpdateAction,
  GmailDraftUpdateInput,
  gmailGetAttachmentAction,
  GmailGetAttachmentInput,
  gmailGetLabelAction,
  gmailGetMessageAction,
  GmailGetMessageInput,
  gmailGetThreadAction,
  GmailGetThreadInput,
  GmailLabelIdInput,
  gmailListAction,
  gmailListAttachmentsAction,
  GmailListAttachmentsInput,
  GmailListInput,
  gmailListThreadsAction,
  GmailListThreadsInput,
  GmailMessageIdInput,
  gmailModifyLabelsAction,
  GmailModifyLabelsInput,
  gmailSendMessageAction,
  gmailTrashAction,
  gmailUntrashAction
} from '../gmail.ts'
import { gmailAttachmentFixture } from './gmail-attachment.ts'
import { gmailDraftLifecycleFixture } from './gmail-draft-lifecycle.ts'
import { gmailLabelLifecycleFixture } from './gmail-label-lifecycle.ts'
import { gmailListPagingFixture } from './gmail-list-paging.ts'
import { gmailListThreadsPagingFixture } from './gmail-list-threads-paging.ts'
import { gmailMetadataHeadersFixture } from './gmail-metadata-headers.ts'
import { gmailNotFoundEnvelopeFixture } from './gmail-not-found-envelope.ts'
import { gmailSendPracticeFixture } from './gmail-send-practice.ts'
import { gmailTrashUntrashFixture } from './gmail-trash-untrash.ts'
import {
  gmailConformanceDraftText,
  gmailConformancePracticeMime,
  gmailConformanceUpdatedDraftText
} from './synthetic.ts'
import {
  decodeBody,
  decodeOutput,
  decodeWriteAnswer,
  failureOf,
  GoogleConformanceActionFailed,
  googleConformanceIntegration as integration,
  googleConformanceMarker,
  isNotFound,
  observed,
  outcomeOf,
  requireSeed,
  runText,
  successValue,
  withOwnedWrite,
  type GoogleConformanceCase
} from './shared.ts'

/** The `{ id, labelIds }` of a Gmail message answer (modify, trash, untrash). */
const GmailMessageLabels = Schema.Struct({
  id: Schema.NonEmptyString,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String))
})

/** One `gmail.list` page: message ids (with their thread ids) and the opaque `nextPageToken`. */
const GmailListPage = Schema.Struct({
  messages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        threadId: Schema.optionalKey(Schema.NonEmptyString)
      })
    )
  ),
  nextPageToken: Schema.optionalKey(Schema.NonEmptyString)
})

/** A draft answer: the draft id and its message. */
const GmailDraftAnswer = Schema.Struct({
  id: Schema.NonEmptyString,
  message: Schema.Struct({
    id: Schema.NonEmptyString,
    threadId: Schema.NonEmptyString,
    labelIds: Schema.optionalKey(Schema.Array(Schema.String))
  })
})

type GmailDraftAnswer = typeof GmailDraftAnswer.Type

/** The Google error envelope field the connector reads first for a JSON object body. */
const GoogleErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.NonEmptyString })
})

// Connector action shorthands.

/** The labels of a message (`format: 'minimal'`); omitted labels read as none. */
const messageLabels = (messageId: string) =>
  gmailGetMessageAction
    .executeTyped({
      integration,
      input: GmailGetMessageInput.make({ id: messageId, format: 'minimal' })
    })
    .pipe(
      Effect.flatMap(successValue(gmailGetMessageAction.id)),
      Effect.map(message => message.labelIds ?? [])
    )

const getLabel = (id: string) =>
  gmailGetLabelAction.executeTyped({ integration, input: GmailLabelIdInput.make({ id }) })

const deleteLabel = (id: string) =>
  gmailDeleteLabelAction.executeTyped({ integration, input: GmailLabelIdInput.make({ id }) })

const modifyLabels = (
  messageId: string,
  delta: {
    readonly addLabelIds?: ReadonlyArray<string>
    readonly removeLabelIds?: ReadonlyArray<string>
  }
) =>
  gmailModifyLabelsAction
    .executeTyped({ integration, input: GmailModifyLabelsInput.make({ messageId, ...delta }) })
    .pipe(
      Effect.flatMap(successValue(gmailModifyLabelsAction.id)),
      Effect.flatMap(
        decodeOutput(GmailMessageLabels, 'gmail.modify_labels to answer the message with labelIds')
      )
    )

const untrash = (messageId: string) =>
  gmailUntrashAction
    .executeTyped({ integration, input: GmailMessageIdInput.make({ messageId }) })
    .pipe(
      Effect.flatMap(successValue(gmailUntrashAction.id)),
      Effect.flatMap(
        decodeOutput(GmailMessageLabels, 'gmail.untrash to answer the message with labelIds')
      )
    )

const deleteDraft = (draftId: string) =>
  gmailDraftDeleteAction.executeTyped({ integration, input: GmailDraftIdInput.make({ draftId }) })

const getMessageMinimal = (id: string) =>
  gmailGetMessageAction.executeTyped({
    integration,
    input: GmailGetMessageInput.make({ id, format: 'minimal' })
  })

const header = (
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  name: string
) => headers.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value ?? null

// Read cases.

const listPageSize = 2

const pageCap = 10

/** Page size of the single listing the pages are compared with. */
const singleListingSize = 100

/** The item ids of one listing page and its opaque `nextPageToken`. */
type IdPage = { readonly ids: ReadonlyArray<string>; readonly nextPageToken: string | undefined }

/**
 * The paging claim shared by the message and thread listings: `single` (one large page) lists 3 to
 * 20 items without a `nextPageToken` (a precondition), and pages of `listPageSize` fetched through
 * `page`, each `nextPageToken` fed back, list exactly those items, none repeated.
 */
const pagesMatchSingleListing = <E, R>(
  noun: 'message' | 'thread',
  single: IdPage,
  page: (pageToken: string | undefined) => Effect.Effect<IdPage, E, R>
) =>
  Effect.gen(function* () {
    const all = single.ids

    if (
      single.nextPageToken !== undefined ||
      all.length <= listPageSize ||
      all.length > listPageSize * pageCap
    ) {
      return yield* new ConformanceMismatch({
        message: `precondition: the paging label must hold ${listPageSize + 1} to ${listPageSize * pageCap} ${noun}s`
      })
    }

    const seen: Array<string> = []
    let pageToken: string | undefined

    for (let pageNumber = 1; ; pageNumber++) {
      const listing = yield* page(pageToken)
      const ids = listing.ids

      yield* expectConformance(
        ids.length <= listPageSize,
        `expected at most maxResults ${noun}s on every page`,
        { actual: ids.length }
      )
      yield* expectConformance(
        new Set(ids).size === ids.length,
        `expected every page to list each ${noun} once`
      )
      yield* expectConformance(
        ids.every(id => !seen.includes(id)),
        `expected a later page to repeat no ${noun} from an earlier page`
      )
      seen.push(...ids)

      if (listing.nextPageToken === undefined) {
        break
      }

      if (pageNumber >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `expected the listing to end within ${pageCap} pages`
        })
      }

      pageToken = listing.nextPageToken
    }

    yield* expectEqual(
      [...seen].sort(),
      [...all].sort(),
      `expected the pages to list exactly the ${noun}s of the single listing`
    )
  })

/** One `gmail.list` page of the label's messages. */
const listPage = (labelId: string, maxResults: number, pageToken?: string) =>
  gmailListAction
    .executeTyped({
      integration,
      input: GmailListInput.make(
        pageToken === undefined ? { labelId, maxResults } : { labelId, maxResults, pageToken }
      )
    })
    .pipe(
      Effect.flatMap(successValue(gmailListAction.id)),
      Effect.flatMap(decodeOutput(GmailListPage, 'gmail.list to answer messages and nextPageToken'))
    )

const messageIdPage = (labelId: string, maxResults: number, pageToken?: string) =>
  Effect.map(listPage(labelId, maxResults, pageToken), (listing): IdPage => ({
    ids: (listing.messages ?? []).map(message => message.id),
    nextPageToken: listing.nextPageToken
  }))

export const gmailListPagingCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.list-page-token',
  title: 'A label listing pages through nextPageToken to the same messages as one large page',
  safety: 'read',
  docs: '`gmail.list` sends GET /gmail/v1/users/me/messages with `labelIds`, `maxResults`, and an opaque `pageToken` passed through unchanged, and returns the JSON answer undecoded (`messages` of `{ id, threadId }` and `nextPageToken`); callers page by feeding `nextPageToken` back as `pageToken`.',
  wire: 'For the seeded paging label (3 to 20 messages), `gmail.list` with that `labelId` and `maxResults: 100` answers every message on one page (no `nextPageToken`); with `maxResults: 2` each page answers at most two message ids and a `nextPageToken` while messages remain, and feeding each token back as `pageToken` lists exactly the messages of the single page, none repeated within or across pages. So a `nextPageToken` missing while messages remain fails the case.',
  fixtures: [gmailListPagingFixture.id],
  run: Effect.gen(function* () {
    const labelId = yield* requireSeed('pagingLabelId')
    const single = yield* messageIdPage(labelId, singleListingSize)

    yield* pagesMatchSingleListing('message', single, pageToken =>
      messageIdPage(labelId, listPageSize, pageToken)
    )
  })
})

/** One `gmail.list_threads` page of the label's threads. */
const threadIdPage = (labelId: string, maxResults: number, pageToken?: string) =>
  gmailListThreadsAction
    .executeTyped({
      integration,
      input: GmailListThreadsInput.make(
        pageToken === undefined ? { labelId, maxResults } : { labelId, maxResults, pageToken }
      )
    })
    .pipe(
      Effect.flatMap(successValue(gmailListThreadsAction.id)),
      Effect.map((listing): IdPage => ({
        ids: (listing.threads ?? []).map(thread => thread.id),
        nextPageToken: listing.nextPageToken
      }))
    )

export const gmailListThreadsPagingCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.list-threads-page-token',
  title:
    "A label's thread listing names the threads of its messages and pages through nextPageToken",
  safety: 'read',
  docs: '`gmail.list_threads` sends GET /gmail/v1/users/me/threads with `labelIds`, `maxResults`, and an opaque `pageToken` passed through unchanged (the same filters as `gmail.list`), and decodes `threads` of `{ id, snippet?, historyId? }`, `nextPageToken`, and `resultSizeEstimate` (a missing `threads` reads as none); callers page by feeding `nextPageToken` back as `pageToken`.',
  wire: 'For the seeded paging label (3 to 20 threads), `gmail.list_threads` with that `labelId` and `maxResults: 100` answers every thread on one page (no `nextPageToken`), each with a non-empty id, and those ids are exactly the distinct `threadId`s `gmail.list` answers for the label on one page (unverified: that Gmail lists a thread when any of its messages carries the label, and never a thread none of them carries); with `maxResults: 2` each page answers at most two thread ids and a `nextPageToken` while threads remain, and feeding each token back as `pageToken` lists exactly the threads of the single page, none repeated within or across pages. `snippet`, `historyId`, and `resultSizeEstimate` are not compared (the connector only decodes them).',
  fixtures: [gmailListThreadsPagingFixture.id],
  run: Effect.gen(function* () {
    const labelId = yield* requireSeed('pagingLabelId')
    const single = yield* threadIdPage(labelId, singleListingSize)

    yield* expectConformance(
      single.ids.every(id => id !== ''),
      'expected every listed thread to carry a non-empty id'
    )

    const messages = yield* listPage(labelId, singleListingSize)

    if (messages.nextPageToken !== undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: the paging label must hold at most ${singleListingSize} messages`
      })
    }

    const threadIds = (messages.messages ?? []).flatMap(message =>
      message.threadId === undefined ? [] : [message.threadId]
    )

    yield* expectConformance(
      threadIds.length === (messages.messages ?? []).length,
      'expected gmail.list to answer a threadId for every message'
    )
    yield* expectEqual(
      [...single.ids].sort(),
      [...new Set(threadIds)].sort(),
      'expected the thread listing to name exactly the threads of the label messages'
    )

    yield* pagesMatchSingleListing('thread', single, pageToken =>
      threadIdPage(labelId, listPageSize, pageToken)
    )
  })
})

/**
 * Decoded byte length of a base64url string, or `undefined` when it does not decode. Padding is
 * counted with one backward scan: an unanchored `/=+$/` is quadratic on long untrusted input.
 */
const base64UrlByteLength = (data: string): number | undefined => {
  let end = data.length

  while (end > 0 && data.charCodeAt(end - 1) === 61) end -= 1

  const unpadded = data.slice(0, end)
  const base64 = unpadded.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  const decoded = Result.try(() => atob(padded))

  return Result.isSuccess(decoded) ? decoded.success.length : undefined
}

export const gmailAttachmentCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.attachment-base64url',
  title: 'A listed attachment answers base64url data of exactly its size',
  safety: 'read',
  docs: '`gmail.list_attachments` sends GET .../messages/{id}?format=full and walks the payload `parts` for attachment metadata (`partId`, `filename`, `mimeType`, `body.size`, `body.attachmentId`), never content; `gmail.get_attachment` sends GET .../messages/{id}/attachments/{attachmentId}, requires `size` (a non-negative integer) and `data` in the base64url alphabet (no `+` or `/`), keeps `data`, and adds standard-base64 `contentBase64`.',
  wire: 'For the seeded attachment message, `gmail.list_attachments` lists at least one part with an `attachmentId` and a `size`; `gmail.get_attachment` of it answers `data` in the base64url alphabet (a standard-base64 answer fails the connector decoding) that decodes to exactly `size` bytes. The listed part `size` is not compared: the connector never relies on it matching.',
  fixtures: [gmailAttachmentFixture.id],
  run: Effect.gen(function* () {
    const messageId = yield* requireSeed('attachmentMessageId')

    const listed = yield* gmailListAttachmentsAction
      .executeTyped({ integration, input: GmailListAttachmentsInput.make({ messageId }) })
      .pipe(Effect.flatMap(successValue(gmailListAttachmentsAction.id)))

    const attachment = [...listed.attachments].find(entry => entry.attachmentId !== undefined)

    if (attachment?.attachmentId === undefined) {
      return yield* new ConformanceMismatch({
        message: 'precondition: attachmentMessageId must carry an attachment with an attachmentId'
      })
    }

    const fetched = yield* gmailGetAttachmentAction
      .executeTyped({
        integration,
        input: GmailGetAttachmentInput.make({ messageId, attachmentId: attachment.attachmentId })
      })
      .pipe(Effect.flatMap(successValue(gmailGetAttachmentAction.id)))

    yield* expectEqual(
      base64UrlByteLength(fetched.data) ?? null,
      fetched.size,
      'expected the base64url data to decode to exactly size bytes'
    )
  })
})

/** A message id the practice mailbox never holds (synthetic, never account data). */
export const gmailAbsentMessageId = 'ffffffffffffffff'

export const gmailNotFoundEnvelopeCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.not-found-envelope',
  title: 'An unknown message id answers 404 with the Google JSON error envelope',
  safety: 'read',
  docs: 'The Google actions map a non-2xx answer by HTTP status (401 `google_unauthorized`; 403 `google_rate_limited` when an `error.errors[].reason` is a rate-limit reason, else `google_unauthorized`; 404 `google_not_found`; 429 `google_rate_limited`; anything else the action code), append the first non-empty string among the body `message`, `error_description`, `error`, and `error.message` to the action message (`Gmail get message failed: <message>`), and keep the raw body as `underlying`.',
  wire: '`gmail.get_message` of the id `ffffffffffffffff`, which the practice mailbox never holds, answers HTTP 404 (unverified: that an unused 16-hex-digit id answers 404 rather than 400 `Invalid id value`), which the connector maps to `google_not_found`, with a JSON body whose `error.message` is a non-empty string (observed at the `ConnectorHttpClient` port), so the connector message is exactly `Gmail get message failed: <error.message>`. The `error.errors` reasons and the body `status` are not checked (the connector reads reasons only for 403).',
  fixtures: [gmailNotFoundEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const { value, responses } = yield* observed(getMessageMinimal(gmailAbsentMessageId))
    const failure = failureOf(value)

    if (failure === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected gmail.get_message of an unused id to fail'
      })
    }

    yield* expectConformance(
      failure.code === 'google_not_found',
      'expected an unused message id to map to google_not_found',
      { actual: outcomeOf(value) }
    )

    const body = yield* decodeBody(GoogleErrorBody, responses.at(-1)?.body)

    if (body === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected the not-found body to be JSON with a non-empty error.message'
      })
    }

    yield* expectEqual(
      failure.message,
      `Gmail get message failed: ${body.error.message}`,
      'expected the connector message to carry the body error.message'
    )
  })
})

/** The header names the metadata case selects, in their usual spelling. */
const gmailMetadataHeaderSelection: ReadonlyArray<string> = ['Subject', 'From']

const headerLines = (
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
): ReadonlyArray<string> => headers.map(entry => `${entry.name}: ${entry.value}`)

/** `gmail.get_message` of `id` with `format: "metadata"` and the optional selection. */
const getMessageMetadata = (id: string, metadataHeaders?: ReadonlyArray<string>) =>
  gmailGetMessageAction
    .executeTyped({
      integration,
      input: GmailGetMessageInput.make(
        metadataHeaders === undefined
          ? { id, format: 'metadata' }
          : { id, format: 'metadata', metadataHeaders }
      )
    })
    .pipe(Effect.flatMap(successValue(gmailGetMessageAction.id)))

export const gmailMetadataHeadersCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.metadata-headers',
  title:
    'A metadata read with metadataHeaders answers only the requested headers, for a message and in its thread',
  safety: 'read',
  docs: '`gmail.get_message` and `gmail.get_thread` send `format=metadata` and, when `metadataHeaders` is given (1 to 50 header names, accepted only with `format: "metadata"`), one `metadataHeaders` query parameter per name, in order. `gmail.get_message` decodes `payload.headers` as answered; `gmail.get_thread` keeps for each message the top-level `payload.headers` whose names are among the requested ones (compared case-insensitively) instead of its default conversation headers.',
  wire: 'For the seeded attachment message, `gmail.get_message` with `format: "metadata"` answers its `threadId` and headers, among them `Subject` and at least one header named neither `Subject` nor `From` (a precondition, so the selection has something to leave out); with `metadataHeaders: ["Subject", "From"]` it answers exactly the headers of that unfiltered read named `Subject` or `From` (compared case-insensitively; unverified: that Gmail also matches a header spelled in another case), in the same order (unverified: that Gmail keeps the order of the unfiltered read) with the same values, and no other header; `gmail.get_thread` of its `threadId` with the same format and selection lists the message with exactly those headers. Bodies and labels are not compared.',
  fixtures: [gmailMetadataHeadersFixture.id],
  run: Effect.gen(function* () {
    const messageId = yield* requireSeed('attachmentMessageId')
    const unfiltered = yield* getMessageMetadata(messageId)
    const all = unfiltered.payload?.headers ?? []
    const selected = new Set(gmailMetadataHeaderSelection.map(name => name.toLowerCase()))
    const isSelected = (entry: { readonly name: string }) => selected.has(entry.name.toLowerCase())

    if (!all.some(entry => entry.name.toLowerCase() === 'subject') || all.every(isSelected)) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: attachmentMessageId must carry a Subject header and a header other than Subject and From'
      })
    }

    const threadId = unfiltered.threadId

    if (threadId === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected the metadata read to answer the message threadId'
      })
    }

    const expected = headerLines(all.filter(isSelected))
    const filtered = yield* getMessageMetadata(messageId, gmailMetadataHeaderSelection)

    yield* expectEqual(
      headerLines(filtered.payload?.headers ?? []),
      expected,
      'expected get_message with metadataHeaders to answer exactly the selected headers of the unfiltered read'
    )

    const thread = yield* gmailGetThreadAction
      .executeTyped({
        integration,
        input: GmailGetThreadInput.make({
          threadId,
          format: 'metadata',
          metadataHeaders: gmailMetadataHeaderSelection
        })
      })
      .pipe(Effect.flatMap(successValue(gmailGetThreadAction.id)))

    const inThread = thread.messages.find(entry => entry.id === messageId)

    if (inThread === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected get_thread of the message threadId to list the message'
      })
    }

    yield* expectEqual(
      headerLines(inThread.headers),
      expected,
      'expected get_thread with metadataHeaders to keep exactly the selected headers of the message'
    )
  })
})

// Write cases.

const labelCaseId = 'google.gmail.label-create-apply-delete'

/** Delete a label that may still exist, by id, then verify `get_label` answers not found. */
const ensureLabelAbsent = (id: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteLabel(id)

    if (!isNotFound(deleted)) {
      yield* successValue(gmailDeleteLabelAction.id)(deleted)
    }

    const read = yield* getLabel(id)

    yield* expectConformance(
      isNotFound(read),
      'expected get_label to answer google_not_found after restoring',
      { actual: outcomeOf(read) }
    )
  })

export const gmailLabelLifecycleCase: GoogleConformanceCase = defineConformanceCase({
  id: labelCaseId,
  title:
    'A run label created, applied to the work message, and deleted leaves the message without it',
  safety: 'write-reversible',
  docs: '`gmail.create_label` sends POST .../labels `{ name }` and decodes `GmailLabel` (`id`, `name`, `type`); `gmail.modify_labels` sends POST .../messages/{id}/modify `{ addLabelIds, removeLabelIds }` and returns the message answer undecoded; `gmail.delete_label` sends DELETE .../labels/{id} and treats any 2xx as deleted without reading the (empty) body; `gmail.get_label` and `gmail.get_message` map 404 to `google_not_found`.',
  wire: '`gmail.create_label` with a run-scoped name answers a user label with that name and an id; `gmail.modify_labels` adding it to the seeded work message answers the message with that label id, and `gmail.get_message` lists it; `gmail.delete_label` answers 2xx; afterwards `gmail.get_label` of the id answers `google_not_found`, and `gmail.get_message` no longer lists the label on the message (deleting a label removes it from every message). The case deletes its label again, by id, even when a step fails. Nothing remains: the label is gone and the message has its earlier labels.',
  fixtures: [gmailLabelLifecycleFixture.id],
  run: Effect.gen(function* () {
    const messageId = yield* requireSeed('workMessageId')
    const runId = yield* requireSeed('runId')
    const name = `${googleConformanceMarker} ${runId} label`

    yield* withOwnedWrite({
      caseId: labelCaseId,
      actionId: gmailCreateLabelAction.id,
      create: gmailCreateLabelAction.executeTyped({
        integration,
        input: GmailCreateLabelInput.make({ name })
      }),
      unknownRecovery: `delete the Gmail label "${name}" by hand if it exists`,
      refuse: label =>
        Effect.succeed(
          label.name === name && label.type !== 'system'
            ? undefined
            : `label ${label.id} named "${label.name}"`
        ),
      recovery: label =>
        `delete the Gmail label ${label.id} ("${name}") by hand if it still exists`,
      restore: label => ensureLabelAbsent(label.id),
      use: (label, pending) =>
        Effect.gen(function* () {
          const applied = yield* modifyLabels(messageId, { addLabelIds: [label.id] }).pipe(
            Effect.uninterruptible
          )

          yield* expectConformance(
            applied.id === messageId && (applied.labelIds ?? []).includes(label.id),
            'expected modify_labels to answer the work message with the new label'
          )

          const withLabel = yield* messageLabels(messageId)

          yield* expectConformance(
            withLabel.includes(label.id),
            'expected get_message to list the applied label'
          )

          yield* deleteLabel(label.id).pipe(
            Effect.flatMap(successValue(gmailDeleteLabelAction.id)),
            Effect.uninterruptible
          )

          const gone = yield* getLabel(label.id)

          yield* expectConformance(
            isNotFound(gone),
            'expected get_label of the deleted label to answer google_not_found',
            { actual: outcomeOf(gone) }
          )
          yield* Ref.set(pending, false)

          const after = yield* messageLabels(messageId)

          yield* expectConformance(
            !after.includes(label.id),
            'expected get_message to drop the deleted label from the work message'
          )
        })
    })
  })
})

const draftCaseId = 'google.gmail.draft-compose-update-delete'

/** The subject header and the decoded body of one message of a `format: 'full'` thread. */
const draftAsRead = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const thread = yield* gmailGetThreadAction
      .executeTyped({ integration, input: GmailGetThreadInput.make({ threadId, format: 'full' }) })
      .pipe(Effect.flatMap(successValue(gmailGetThreadAction.id)))

    const message = thread.messages.find(entry => entry.id === messageId)

    if (message === undefined) {
      return yield* new ConformanceMismatch({
        message: 'expected get_thread to list the draft message'
      })
    }

    return [
      header(message.headers, 'subject'),
      message.body?.trimEnd() ?? null,
      message.bodyMimeType ?? null
    ]
  })

/** Delete a draft that may still exist, by id, then verify its latest message answers not found. */
const ensureDraftAbsent = (draftId: string, messageId: string) =>
  Effect.gen(function* () {
    const deleted = yield* deleteDraft(draftId)

    if (!isNotFound(deleted)) {
      yield* successValue(gmailDraftDeleteAction.id)(deleted)
    }

    const read = yield* getMessageMinimal(messageId)

    yield* expectConformance(
      isNotFound(read),
      'expected get_message of the draft message to answer google_not_found after restoring',
      { actual: outcomeOf(read) }
    )
  })

/** The draft message's recipient headers: a draft the case composed has none. */
const recipientHeaderNames = /^(?:to|cc|bcc)$/i

/**
 * `undefined` when the composed draft is provably this run's own: its message (read with
 * `format: "metadata"`) is the answered message, carries the `DRAFT` label, the run-scoped subject,
 * and no recipient header. Otherwise the refused item: a foreign or unverifiable draft is never
 * updated or deleted. Never fails (a failed read is an unverifiable draft).
 */
const refuseForeignDraft = (draft: GmailDraftAnswer, subject: string) =>
  gmailGetMessageAction
    .executeTyped({
      integration,
      input: GmailGetMessageInput.make({ id: draft.message.id, format: 'metadata' })
    })
    .pipe(
      Effect.map(result => {
        if (!Predicate.isTagged(result, 'Success')) {
          return `draft ${draft.id}, whose message could not be read to prove it is this run's draft (${outcomeOf(result)})`
        }

        const message = result.value
        const headers = message.payload?.headers ?? []

        const own =
          message.id === draft.message.id &&
          (message.labelIds ?? []).includes('DRAFT') &&
          header(headers, 'subject') === subject &&
          !headers.some(entry => recipientHeaderNames.test(entry.name))

        return own
          ? undefined
          : `draft ${draft.id}, which is not this run's draft (another subject, a recipient, or no DRAFT label)`
      }),
      Effect.catch(error =>
        Effect.succeed(
          `draft ${draft.id}, whose message could not be read to prove it is this run's draft (${error.cause})`
        )
      )
    )

/** Register the message id of a successful draft answer (a draft update replaces the message). */
const registerDraftMessage = (
  current: Ref.Ref<string>,
  result: ActionResult<GmailDraftAnswer>
): Effect.Effect<void> =>
  Predicate.isTagged(result, 'Success') ? Ref.set(current, result.value.message.id) : Effect.void

export const gmailDraftLifecycleCase: GoogleConformanceCase = defineConformanceCase({
  id: draftCaseId,
  title:
    'A draft round-trips its subject and UTF-8 body through compose, update, and get_thread, then deletes',
  safety: 'write-reversible',
  docs: '`gmail.draft_compose` and `gmail.draft_update` build a text/plain MIME message (`Subject` RFC 2047-encoded when not ASCII, `Content-Type: text/plain; charset=utf-8`, the body as UTF-8 bytes, no transfer encoding), base64url-encode it, and send POST .../drafts `{ message: { raw } }` or PUT .../drafts/{id} `{ id, message: { raw } }`, returning the draft answer undecoded; `gmail.get_thread` with `format: "full"` decodes each text part from its base64url `body.data` as UTF-8 (then quoted-printable or base64 when the part says so), prefers text/plain, and keeps selected headers; `gmail.draft_delete` sends DELETE .../drafts/{id} and treats any 2xx as deleted without reading the (empty) body.',
  wire: '`gmail.draft_compose` with no recipient, a run-scoped ASCII subject, and a body with non-ASCII characters answers a draft id and a message id and thread id, and `gmail.get_message` of that message (`format: "metadata"`) reads the `DRAFT` label, the run-scoped subject, and no recipient header (unverified: that a metadata read of a fresh draft returns `DRAFT` and the subject exactly as sent; if not, the case refuses its own draft and leaves it for the leftover lookup) (checked before the case adopts the draft: a draft that is not provably its own is never updated or deleted); `gmail.get_thread` of that thread reads back the subject and exactly that body (trailing whitespace aside) as text/plain (unverified: that Gmail keeps the 8-bit part as written, so `body.data` carries the UTF-8 bytes the connector sent); `gmail.draft_update` of the same draft with a new subject and body answers the same draft id with a new message, which `gmail.get_thread` reads back the same way; `gmail.draft_delete` answers 2xx; afterwards `gmail.get_message` of the draft message answers `google_not_found` (unverified: deleting a draft deletes its message), and deleting the draft again answers 2xx or `google_not_found` (unverified: which), after which its message still answers `google_not_found`; the cleanup accepts either answer and then verifies the message is gone. The draft has no recipient, so nothing can be sent; the case deletes it again, by id, even when a step fails.',
  fixtures: [gmailDraftLifecycleFixture.id],
  run: Effect.gen(function* () {
    const subject = yield* runText('draft', 'synthetic conformance draft, safe to delete')

    const updatedSubject = yield* runText(
      'draft updated',
      'synthetic conformance draft, safe to delete'
    )

    // The draft's current message id: a draft update replaces the message.
    const currentMessage = yield* Ref.make('')

    yield* withOwnedWrite({
      caseId: draftCaseId,
      actionId: gmailDraftComposeAction.id,
      create: gmailDraftComposeAction
        .executeTyped({
          integration,
          input: GmailDraftComposeInput.make({ to: [], subject, body: gmailConformanceDraftText })
        })
        .pipe(
          Effect.flatMap(decodeWriteAnswer(GmailDraftAnswer, gmailDraftComposeAction.id)),
          Effect.flatMap(result => Effect.as(registerDraftMessage(currentMessage, result), result))
        ),
      unknownRecovery: `delete the Gmail draft with subject "${subject}" by hand if it exists`,
      refuse: (draft: GmailDraftAnswer) => refuseForeignDraft(draft, subject),
      recovery: draft => `delete the Gmail draft ${draft.id} by hand if it still exists`,
      restore: draft =>
        Effect.flatMap(Ref.get(currentMessage), messageId =>
          ensureDraftAbsent(draft.id, messageId)
        ),
      use: (draft, pending) =>
        Effect.gen(function* () {
          yield* expectEqual(
            yield* draftAsRead(draft.message.threadId, draft.message.id),
            [subject, gmailConformanceDraftText, 'text/plain'],
            'expected get_thread to read back the draft subject and UTF-8 body exactly'
          )

          const updated = yield* gmailDraftUpdateAction
            .executeTyped({
              integration,
              input: GmailDraftUpdateInput.make({
                draftId: draft.id,
                to: [],
                subject: updatedSubject,
                body: gmailConformanceUpdatedDraftText
              })
            })
            .pipe(
              Effect.flatMap(successValue(gmailDraftUpdateAction.id)),
              Effect.flatMap(
                decodeOutput(GmailDraftAnswer, 'gmail.draft_update to answer the draft')
              ),
              Effect.tap(answer => Ref.set(currentMessage, answer.message.id)),
              Effect.uninterruptible
            )

          yield* expectEqual(
            updated.id,
            draft.id,
            'expected draft_update to answer the same draft id'
          )
          yield* expectEqual(
            yield* draftAsRead(updated.message.threadId, updated.message.id),
            [updatedSubject, gmailConformanceUpdatedDraftText, 'text/plain'],
            'expected get_thread to read back the updated subject and body exactly'
          )

          yield* deleteDraft(draft.id).pipe(
            Effect.flatMap(successValue(gmailDraftDeleteAction.id)),
            Effect.uninterruptible
          )

          const gone = yield* getMessageMinimal(updated.message.id)

          yield* expectConformance(
            isNotFound(gone),
            'expected get_message of the deleted draft message to answer google_not_found',
            { actual: outcomeOf(gone) }
          )
          yield* Ref.set(pending, false)

          const again = yield* deleteDraft(draft.id).pipe(Effect.uninterruptible)

          yield* expectConformance(
            Predicate.isTagged(again, 'Success') || isNotFound(again),
            'expected deleting the deleted draft again to answer 2xx or google_not_found',
            { actual: outcomeOf(again) }
          )

          const still = yield* getMessageMinimal(updated.message.id)

          yield* expectConformance(
            isNotFound(still),
            'expected the draft message to stay gone after the repeated delete',
            { actual: outcomeOf(still) }
          )
        })
    })
  })
})

const trashCaseId = 'google.gmail.trash-untrash'

/**
 * Bring the work message out of Trash with every label it had before: untrash when it still
 * carries TRASH, re-add any missing earlier label, then verify.
 */
const ensureMessageRestored = (messageId: string, before: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let current = yield* messageLabels(messageId)

    if (current.includes('TRASH')) {
      yield* untrash(messageId)
      current = yield* messageLabels(messageId)
    }

    const absent = before.filter(label => !current.includes(label))

    if (absent.length > 0) {
      yield* modifyLabels(messageId, { addLabelIds: absent })
    }

    const final = yield* messageLabels(messageId)

    yield* expectConformance(
      !final.includes('TRASH') && before.every(label => final.includes(label)),
      'expected the work message out of Trash with its earlier labels after restoring'
    )
  })

export const gmailTrashUntrashCase: GoogleConformanceCase = defineConformanceCase({
  id: trashCaseId,
  title: 'The work message trashed reads TRASH, and untrashed reads without it',
  safety: 'write-reversible',
  docs: '`gmail.trash` and `gmail.untrash` send POST .../messages/{id}/trash and .../untrash (no body) and return the message answer undecoded; `gmail.get_message` with `format: "minimal"` decodes `labelIds`. The connector has no other Trash model: a trashed message is one whose labels include `TRASH`.',
  wire: 'For the seeded work message, not in Trash: `gmail.trash` answers the message with `TRASH` among its `labelIds`, and `gmail.get_message` lists `TRASH`; `gmail.untrash` answers the message without `TRASH`, and `gmail.get_message` then lists no `TRASH`. Whether untrash restores every earlier label is not a connector claim: the cleanup always runs, untrashes the message if it is still in Trash, re-adds any earlier label it lacks, and verifies them all. The case refuses to start while the message is in Trash (so it never untrashes a message it did not trash). Concurrent runs are not supported.',
  fixtures: [gmailTrashUntrashFixture.id],
  run: Effect.gen(function* () {
    const messageId = yield* requireSeed('workMessageId')
    const before = yield* messageLabels(messageId)

    if (before.includes('TRASH')) {
      return yield* new ConformanceMismatch({
        message:
          'precondition: workMessageId is in Trash (a leftover or a concurrent run); untrash it by hand first'
      })
    }

    yield* withOwnedWrite({
      caseId: trashCaseId,
      actionId: gmailTrashAction.id,
      create: gmailTrashAction
        .executeTyped({ integration, input: GmailMessageIdInput.make({ messageId }) })
        .pipe(Effect.flatMap(decodeWriteAnswer(GmailMessageLabels, gmailTrashAction.id))),
      unknownRecovery: `untrash message ${messageId} by hand if it is in Trash`,
      refuse: message =>
        Effect.succeed(message.id === messageId ? undefined : `message ${message.id}`),
      recovery: () =>
        `untrash message ${messageId} by hand and re-add its labels ${before.join(', ')}`,
      restore: () => ensureMessageRestored(messageId, before),
      use: trashed =>
        Effect.gen(function* () {
          yield* expectConformance(
            (trashed.labelIds ?? []).includes('TRASH'),
            'expected trash to answer the message with the TRASH label'
          )

          const inTrash = yield* messageLabels(messageId)

          yield* expectConformance(
            inTrash.includes('TRASH'),
            'expected get_message to list TRASH after the trash'
          )

          const untrashed = yield* untrash(messageId).pipe(Effect.uninterruptible)

          yield* expectConformance(
            !(untrashed.labelIds ?? []).includes('TRASH'),
            'expected untrash to answer the message without the TRASH label'
          )

          const after = yield* messageLabels(messageId)

          yield* expectConformance(
            !after.includes('TRASH'),
            'expected get_message to list no TRASH after the untrash'
          )
          // `pending` stays set: the cleanup always restores and verifies the earlier labels.
        })
    })
  })
})

const sendCaseId = 'google.gmail.send-practice-address'

/**
 * The recipient header lines (`To`, `Cc`, `Bcc`, `Resent-*`) of a MIME message's header block, which
 * ends at the first empty line; any line break (CRLF, bare CR, bare LF) splits lines.
 */
const recipientHeaders = (mime: string): ReadonlyArray<string> => {
  const lines = mime.split(/\r\n|\r|\n/)
  const end = lines.indexOf('')

  return (end === -1 ? lines : lines.slice(0, end)).filter(line =>
    /^(?:to|cc|bcc|resent-[a-z]+):/i.test(line)
  )
}

const base64UrlOfAscii = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export const gmailSendPracticeCase: GoogleConformanceCase = defineConformanceCase({
  id: sendCaseId,
  title: 'A message sent to the practice address answers an id that reads back its recipient',
  safety: 'write-irreversible',
  docs: '`gmail.send_message` takes a complete host-generated base64url MIME message, sends 7-bit MIME as one multipart media upload (POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart, `multipart/related`: `{}` JSON metadata, then the `message/rfc822` bytes), never retries, and on 2xx decodes `{ id, threadId? }` into `{ accepted: true, id, threadId }`; a non-2xx status among 400, 401, 403, 404, 405, 413, 415, 422, and 429 is `gmail_send_message_rejected`, any other `gmail_send_message_unknown` ("Reconcile before considering another send"). Success means submission, not delivery. The connector cannot unsend.',
  wire: '`gmail.send_message` of a 7-bit text/plain message whose only recipient header is `To: <practiceAddress>` (the case decodes `practiceAddress` again as exactly one plain address `local@domain`, with no display name, list, angle brackets, whitespace, or control characters, and the `runId` as `run-...`, and refuses anything else with a precondition before any request) and whose subject names the run id sends one multipart upload and answers 2xx with a message `id`; `gmail.get_message` of that id with `format: "metadata"` answers the `To` header equal to the practice address and the run-scoped `Subject`, so the answered id addresses the message sent. The message stays in the Sent folder and in the practice mailbox: this case is write-irreversible, runs only when requested by its exact id, and never sends to anyone but the seeded practice address.',
  fixtures: [gmailSendPracticeFixture.id],
  run: Effect.gen(function* () {
    // Decoded again here (a host may bypass the branded types): exactly one plain address.
    const practiceAddress = yield* requireSeed('practiceAddress')
    const subject = yield* runText('send', 'synthetic conformance message, safe to delete')
    const mime = gmailConformancePracticeMime(practiceAddress, subject)

    // Never send to anyone but the seeded practice address.
    yield* expectEqual(
      recipientHeaders(mime),
      [`To: ${practiceAddress}`],
      'precondition: the message must name the practice address as its only recipient'
    )

    const recovery = `look for a message with subject "${subject}" in the Sent folder and at the practice address; never resend automatically`

    const sent = yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          gmailSendMessageAction.executeTyped({
            integration,
            input: { raw: base64UrlOfAscii(mime) }
          })
        )

        const outcome = classifyWriteExit(exit)
        const actionId = gmailSendMessageAction.id

        // The connector itself calls some 4xx answers unconfirmed (`gmail_send_message_unknown`).
        const ambiguous =
          outcome.kind === 'ambiguous' ||
          (outcome.kind === 'rejected' && outcome.failure.code === 'gmail_send_message_unknown')

        if (outcome.kind === 'success') {
          return outcome.value
        }

        const error = ambiguous
          ? new GoogleConformanceActionFailed({
              actionId,
              ...outcome.failure,
              writeOutcome: 'unknown',
              recovery
            })
          : new GoogleConformanceActionFailed({ actionId, ...outcome.failure })

        // An interruption may replace this failure, and with it the advice to look for the message.
        return yield* ambiguous
          ? failReportingForCase(sendCaseId, unmask, error)
          : Effect.fail(error)
      })
    )

    const message = yield* gmailGetMessageAction
      .executeTyped({
        integration,
        input: GmailGetMessageInput.make({ id: sent.id, format: 'metadata' })
      })
      .pipe(Effect.flatMap(successValue(gmailGetMessageAction.id)))

    const headers = message.payload?.headers ?? []

    yield* expectEqual(
      [message.id, header(headers, 'to'), header(headers, 'subject')],
      [sent.id, practiceAddress, subject],
      'expected get_message of the sent id to read back the practice address and the run subject'
    )
  })
})
