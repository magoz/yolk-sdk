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
import { classifyWriteExit } from '../../conformance/cleanup-reporter.ts'
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
  failReportingFor,
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

/** One `gmail.list` page: message ids and the opaque `nextPageToken`. */
const GmailListPage = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))),
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

export const gmailListPagingCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.list-page-token',
  title: 'A label listing pages through nextPageToken to exactly the label messagesTotal',
  safety: 'read',
  docs: '`gmail.list` sends GET /gmail/v1/users/me/messages with `labelIds`, `maxResults`, and an opaque `pageToken` passed through unchanged, and returns the JSON answer undecoded (`messages` of `{ id, threadId }` and `nextPageToken`); callers page by feeding `nextPageToken` back as `pageToken`. `gmail.get_label` sends GET .../labels/{id} and decodes `GmailLabel`, including the optional `messagesTotal`.',
  wire: 'For the seeded paging label (3 to 20 messages), `gmail.get_label` answers a `messagesTotal`; `gmail.list` with that `labelId` and `maxResults: 2` answers at most two message ids per page and a `nextPageToken` while messages remain; feeding each token back as `pageToken` continues the listing with no id repeated within or across pages, and the page without `nextPageToken` ends it having listed exactly `messagesTotal` distinct messages (unverified: that `messagesTotal` counts exactly the messages the listing pages through, which needs a label with no message in Trash or Spam). So a `nextPageToken` missing while messages remain fails the case.',
  fixtures: [gmailListPagingFixture.id],
  run: Effect.gen(function* () {
    const labelId = yield* requireSeed('pagingLabelId')

    const label = yield* getLabel(labelId).pipe(
      Effect.flatMap(successValue(gmailGetLabelAction.id))
    )

    const total = label.messagesTotal

    if (total === undefined || total <= listPageSize || total > listPageSize * pageCap) {
      return yield* new ConformanceMismatch({
        message: `precondition: the paging label must report a messagesTotal from ${listPageSize + 1} to ${listPageSize * pageCap}`
      })
    }

    const seen: Array<string> = []
    let pageToken: string | undefined

    for (let page = 1; ; page++) {
      const listing = yield* gmailListAction
        .executeTyped({
          integration,
          input: GmailListInput.make(
            pageToken === undefined
              ? { labelId, maxResults: listPageSize }
              : { labelId, maxResults: listPageSize, pageToken }
          )
        })
        .pipe(
          Effect.flatMap(successValue(gmailListAction.id)),
          Effect.flatMap(
            decodeOutput(GmailListPage, 'gmail.list to answer messages and nextPageToken')
          )
        )

      const ids = (listing.messages ?? []).map(message => message.id)

      yield* expectConformance(
        ids.length <= listPageSize,
        'expected at most maxResults messages on every page',
        { actual: ids.length }
      )
      yield* expectConformance(
        new Set(ids).size === ids.length,
        'expected every page to list each message once'
      )
      yield* expectConformance(
        ids.every(id => !seen.includes(id)),
        'expected a later page to repeat no message from an earlier page'
      )
      seen.push(...ids)

      if (listing.nextPageToken === undefined) {
        break
      }

      if (page >= pageCap) {
        return yield* new ConformanceMismatch({
          message: `expected the listing to end within ${pageCap} pages`
        })
      }

      pageToken = listing.nextPageToken
    }

    yield* expectEqual(
      seen.length,
      total,
      'expected the pages to list exactly the label messagesTotal messages'
    )
  })
})

/** Decoded byte length of a base64url string, or `undefined` when it does not decode. */
const base64UrlByteLength = (data: string): number | undefined => {
  const unpadded = data.replace(/=+$/, '')
  const base64 = unpadded.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  const decoded = Result.try(() => atob(padded))

  return Result.isSuccess(decoded) ? decoded.success.length : undefined
}

export const gmailAttachmentCase: GoogleConformanceCase = defineConformanceCase({
  id: 'google.gmail.attachment-base64url',
  title: 'An attachment listed with its part size answers base64url data of exactly that size',
  safety: 'read',
  docs: '`gmail.list_attachments` sends GET .../messages/{id}?format=full and walks the payload `parts` for attachment metadata (`partId`, `filename`, `mimeType`, `body.size`, `body.attachmentId`), never content; `gmail.get_attachment` sends GET .../messages/{id}/attachments/{attachmentId}, requires `size` (a non-negative integer) and `data` in the base64url alphabet (no `+` or `/`), keeps `data`, and adds standard-base64 `contentBase64`.',
  wire: 'For the seeded attachment message, `gmail.list_attachments` lists at least one part with an `attachmentId` and a `size`; `gmail.get_attachment` of it answers `data` in the base64url alphabet (a standard-base64 answer fails the connector decoding) that decodes to exactly `size` bytes, and that `size` equals the listed part size (unverified: that the payload part `body.size` and the attachment answer `size` agree).',
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
    yield* expectEqual(
      fetched.size,
      attachment.size ?? null,
      'expected the attachment size to equal the listed part size'
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
        label.name === name && label.type !== 'system'
          ? undefined
          : `label ${label.id} named "${label.name}"`,
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

/** Register the message id of a successful draft answer (a draft update replaces the message). */
const registerDraftMessage = (
  current: Ref.Ref<string>,
  result: ActionResult<GmailDraftAnswer>
): Effect.Effect<void> =>
  Predicate.isTagged(result, 'Success') ? Ref.set(current, result.value.message.id) : Effect.void

export const gmailDraftLifecycleCase: GoogleConformanceCase = defineConformanceCase({
  id: draftCaseId,
  title: 'A draft round-trips its UTF-8 text through compose, update, and get_thread, then deletes',
  safety: 'write-reversible',
  docs: '`gmail.draft_compose` and `gmail.draft_update` build a text/plain MIME message (`Subject` RFC 2047-encoded when not ASCII, `Content-Type: text/plain; charset=utf-8`, the body as UTF-8 bytes, no transfer encoding), base64url-encode it, and send POST .../drafts `{ message: { raw } }` or PUT .../drafts/{id} `{ id, message: { raw } }`, returning the draft answer undecoded; `gmail.get_thread` with `format: "full"` decodes each text part from its base64url `body.data` as UTF-8 (then quoted-printable or base64 when the part says so), prefers text/plain, and keeps selected headers; `gmail.draft_delete` sends DELETE .../drafts/{id} and treats any 2xx as deleted without reading the (empty) body.',
  wire: '`gmail.draft_compose` with no recipient, a run-scoped subject, and a body with non-ASCII characters answers a draft id and a message id and thread id; `gmail.get_thread` of that thread reads back the subject and exactly that body (trailing whitespace aside) as text/plain (unverified: that Gmail keeps the 8-bit part as written, so `body.data` carries the UTF-8 bytes the connector sent); `gmail.draft_update` of the same draft with a new subject and body answers the same draft id with a new message, which `gmail.get_thread` reads back the same way; `gmail.draft_delete` answers 2xx; afterwards `gmail.get_message` of the draft message answers `google_not_found` (unverified: deleting a draft deletes its message), and deleting the draft again answers `google_not_found` (unverified: 404 for a deleted draft), which the cleanup relies on. The draft has no recipient, so nothing can be sent; the case deletes it again, by id, even when a step fails.',
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
      refuse: (draft: GmailDraftAnswer) =>
        draft.message.labelIds === undefined || draft.message.labelIds.includes('DRAFT')
          ? undefined
          : `draft ${draft.id} whose message is not a draft`,
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
            isNotFound(again),
            'expected deleting the deleted draft again to answer google_not_found',
            { actual: outcomeOf(again) }
          )
        })
    })
  })
})

const trashCaseId = 'google.gmail.trash-untrash'

const sortedLabels = (labels: ReadonlyArray<string>) => [...labels].sort()

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
  title: 'The work message trashed and untrashed reads back with exactly its earlier labels',
  safety: 'write-reversible',
  docs: '`gmail.trash` and `gmail.untrash` send POST .../messages/{id}/trash and .../untrash (no body) and return the message answer undecoded; `gmail.get_message` with `format: "minimal"` decodes `labelIds`. The connector has no other Trash model: a trashed message is one whose labels include `TRASH`.',
  wire: 'For the seeded work message, not in Trash: `gmail.trash` answers the message with `TRASH` among its `labelIds`, and `gmail.get_message` lists `TRASH`; `gmail.untrash` answers the message without `TRASH`, and `gmail.get_message` then lists exactly the labels it had before the trash (unverified: that untrash restores every earlier label, INBOX included). The case refuses to start while the message is in Trash (so it never untrashes a message it did not trash), and untrashes it and re-adds missing earlier labels even when a step fails. Concurrent runs are not supported.',
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
      refuse: message => (message.id === messageId ? undefined : `message ${message.id}`),
      recovery: () =>
        `untrash message ${messageId} by hand and re-add its labels ${before.join(', ')}`,
      restore: () => ensureMessageRestored(messageId, before),
      use: (trashed, pending) =>
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

          yield* expectEqual(
            sortedLabels(after),
            sortedLabels(before),
            'expected untrash to restore exactly the labels the message had before'
          )
          yield* Ref.set(pending, false)
        })
    })
  })
})

const sendCaseId = 'google.gmail.send-practice-address'

/** The recipient headers (`To`, `Cc`, `Bcc`) of a MIME message, as `name: value` lines. */
const recipientHeaders = (mime: string): ReadonlyArray<string> =>
  (mime.split('\r\n\r\n', 1)[0] ?? '')
    .split('\r\n')
    .filter(line => /^(?:to|cc|bcc|resent-[a-z]+):/i.test(line))

const base64UrlOfAscii = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export const gmailSendPracticeCase: GoogleConformanceCase = defineConformanceCase({
  id: sendCaseId,
  title: 'A message sent to the practice address answers an id that reads back its recipient',
  safety: 'write-irreversible',
  docs: '`gmail.send_message` takes a complete host-generated base64url MIME message, sends 7-bit MIME as one multipart media upload (POST https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart, `multipart/related`: `{}` JSON metadata, then the `message/rfc822` bytes), never retries, and on 2xx decodes `{ id, threadId? }` into `{ accepted: true, id, threadId }`; a non-2xx status among 400, 401, 403, 404, 405, 413, 415, 422, and 429 is `gmail_send_message_rejected`, any other `gmail_send_message_unknown` ("Reconcile before considering another send"). Success means submission, not delivery. The connector cannot unsend.',
  wire: '`gmail.send_message` of a 7-bit text/plain message whose only recipient header is `To: <practiceAddress>` (the case refuses to send any other) and whose subject names the run id sends one multipart upload and answers 2xx with a message `id`; `gmail.get_message` of that id with `format: "metadata"` answers the `To` header equal to the practice address and the run-scoped `Subject`, so the answered id addresses the message sent. The message stays in the Sent folder and in the practice mailbox: this case is write-irreversible, runs only when requested by its exact id, and never sends to anyone but the seeded practice address.',
  fixtures: [gmailSendPracticeFixture.id],
  run: Effect.gen(function* () {
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
        return yield* ambiguous ? failReportingFor(sendCaseId, unmask, error) : Effect.fail(error)
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
