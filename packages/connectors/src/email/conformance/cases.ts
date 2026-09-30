/**
 * Generic email conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Yolk never speaks IMAP, POP3, or SMTP: generic email goes through the host-provided
 * `EmailClient` port. Each case runs the REAL connector email actions over that port plus the
 * connector `CredentialResolver` and the host-supplied `EmailConformanceConfig` seeds, and checks
 * one `EmailClient` invariant from the connector contract (headers, filtered listing without
 * fallback, Drafts discovery, Sent-copy statuses, message state, trash/untrash, moves, POP3
 * rejections, and SMTP acceptance). The same cases run against replayed `PortFixture`s (through
 * `makeEmailReplayBackend` and `emailClientLayerFromBackend`), a fixture-driven fake backend such
 * as `@yolk-sdk/emulators/email`, or, by hand, a host `EmailClient` implementation connected to a
 * practice mailbox. None is observed live yet (`observed` absent = unverified).
 *
 * Some claims need a host that behaves in a particular way (a legacy host without
 * `listMessagesFiltered` or `sentCopy`): those cases wrap the `EmailClient` they are given with a
 * small port-level shim and say so in their `wire` text. Nothing here parses host message ids:
 * ids stay opaque.
 *
 * Write cases never touch seeded messages except the flag case, which restores the seeded flags.
 * Draft, trash, and move cases create their own `yolk-conformance` draft, track its location
 * across moves, and permanently delete it again through `email.delete_permanently` (also after a
 * failed claim or an interruption). A failed removal is reported with
 * `EmailConformanceRestoreFailed`, never swallowed. Send cases are `write-irreversible`: they
 * submit real mail (to the practice mailbox itself, or to a seeded undeliverable address) and only
 * run live when started by id.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { sanitizeConformanceMessage } from '@yolk-sdk/conformance/runner'
import { CredentialResolver, makeCredentialBinding } from '../../credential.ts'
import { ConnectorError } from '../../error.ts'
import { makeIntegration, type ConnectorIntegration } from '../../integration.ts'
import type { ActionResult } from '../../result.ts'
import {
  EmailAddress,
  EmailBody,
  EmailClient,
  EmailComposeMessage,
  EmailCreateDraftInput,
  EmailFolderName,
  EmailGetMessageInput,
  EmailIncomingCredentialSlot,
  EmailListMessagesInput,
  EmailModifyLabelsInput,
  EmailMoveInput,
  EmailSendMessageInput,
  EmailSendMessageOutput,
  EmailSendMessageRequest,
  EmailSetFlagInput,
  EmailSetReadInput,
  EmailSmtpCredentialSlot,
  EmailTrashInput,
  EmailUntrashInput,
  emailConnectorId,
  emailCreateDraftAction,
  emailDeletePermanentlyAction,
  emailGetMessageAction,
  emailListMessagesAction,
  emailBatchModifyLabelsAction,
  emailBatchMoveAction,
  emailBatchSetFlagAction,
  emailBatchSetReadAction,
  emailBatchTrashAction,
  emailBatchUntrashAction,
  emailModifyLabelsAction,
  emailMoveAction,
  emailSendMessageAction,
  emailSetFlagAction,
  emailSetReadAction,
  emailTrashAction,
  emailUntrashAction,
  type EmailClientApi,
  type EmailMessage
} from '../index.ts'

const SeedString = Schema.Trimmed.check(Schema.isNonEmpty())

/**
 * Host-supplied seeds for the practice mailbox. Cases never hard-code account data. A case whose
 * required seed is missing fails with a `precondition:` `ConformanceMismatch` before any port call.
 */
export const EmailConformanceSeeds = Schema.Struct({
  /** IMAP host of the practice mailbox (`incomingHost`; TLS on 993). */
  imapHost: Schema.optionalKey(SeedString),
  /** POP3 host of the same practice mailbox (`incomingHost`; TLS on 995). */
  pop3Host: Schema.optionalKey(SeedString),
  /** SMTP submission host (`smtpHost`; STARTTLS on 587). */
  smtpHost: Schema.optionalKey(SeedString),
  /** Opaque id of a seeded INBOX message that is unread and unflagged. */
  unreadMessageId: Schema.optionalKey(SeedString),
  /**
   * Name of the mailbox advertised with the `\Drafts` SPECIAL-USE attribute. Use a practice
   * mailbox where it is not literally `Drafts`, so discovery differs from a fallback name.
   */
  draftsFolder: Schema.optionalKey(SeedString),
  /** Name of the mailbox advertised with `\Sent`. */
  sentFolder: Schema.optionalKey(SeedString),
  /** Name of the mailbox advertised with `\Trash`. */
  trashFolder: Schema.optionalKey(SeedString),
  /** An existing mailbox other than INBOX and the Drafts mailbox, for the move case. */
  moveDestinationFolder: Schema.optionalKey(SeedString),
  /** The practice mailbox's own address: the only recipient the send cases deliver to. */
  recipient: Schema.optionalKey(SeedString),
  /** An address the SMTP server accepts for submission but cannot deliver (it bounces later). */
  undeliverableRecipient: Schema.optionalKey(SeedString)
})

export type EmailConformanceSeeds = typeof EmailConformanceSeeds.Type

export type EmailConformanceSeedKey = keyof EmailConformanceSeeds

/** Host-supplied seeds for the email conformance cases. */
export class EmailConformanceConfig extends Context.Service<
  EmailConformanceConfig,
  EmailConformanceSeeds
>()('@yolk-sdk/connectors/email/conformance/EmailConformanceConfig') {}

/**
 * Credential references the cases bind to the incoming (`email.incoming`) and SMTP (`email.smtp`)
 * slots. A host `CredentialResolver` (for example `staticCredentialResolverLayer` from
 * `@yolk-sdk/connectors/conformance`) resolves them to `UsernamePasswordCredential`s.
 */
export const emailConformanceCredentialRefs = {
  incoming: 'email.conformance.incoming',
  smtp: 'email.conformance.smtp'
} as const

/** The integration the cases invoke the connector with, for a given email config. */
export const emailConformanceIntegration = (
  config: Readonly<Record<string, string>>
): ConnectorIntegration =>
  makeIntegration({
    connectorId: emailConnectorId,
    config,
    credentialBindings: [
      makeCredentialBinding({
        slotId: EmailIncomingCredentialSlot.id,
        credentialRef: emailConformanceCredentialRefs.incoming
      }),
      makeCredentialBinding({
        slotId: EmailSmtpCredentialSlot.id,
        credentialRef: emailConformanceCredentialRefs.smtp
      })
    ]
  })

/** Synthetic marker every case-created draft or sent message carries in its subject. */
export const emailConformanceMarker = 'yolk-conformance'

const restoreByHandAdvice =
  'remove the case-created message by hand if it still exists (subjects start with yolk-conformance).'

/**
 * A connector action returned a failure where the case needed success. `createOutcome: 'unknown'`
 * marks a failed create of a case-owned draft: the host may have appended it anyway, so the
 * message adds the manual-recovery advice.
 */
export class EmailConformanceActionFailed extends Data.TaggedError('EmailConformanceActionFailed')<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly createOutcome?: 'unknown'
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (status ${this.status})`

    const advice =
      this.createOutcome === 'unknown' ? `; the draft may exist anyway: ${restoreByHandAdvice}` : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/** `text` ending in a period. */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Restoring what a write case changed failed (removing its own draft, or putting the seeded flags
 * back). `caseOutcome` says whether the claim itself held before the restore; `claimFailure` is a
 * sanitized summary of why it failed.
 */
export class EmailConformanceRestoreFailed extends Data.TaggedError(
  'EmailConformanceRestoreFailed'
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

export type EmailConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | EmailConformanceActionFailed
  | EmailConformanceRestoreFailed

/** What every email conformance case requires from the host. */
export type EmailConformanceRequirements = EmailClient | CredentialResolver | EmailConformanceConfig

export type EmailConformanceCase = ConformanceCase<
  EmailConformanceError,
  EmailConformanceRequirements
>

const requireSeed = <K extends EmailConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* EmailConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: EmailConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const requireFolderSeed = (
  key: 'draftsFolder' | 'sentFolder' | 'trashFolder' | 'moveDestinationFolder'
) => Effect.map(requireSeed(key), EmailFolderName.make)

const inbox = EmailFolderName.make('INBOX')

/** IMAP incoming (plus SMTP when seeded) integration for the practice mailbox. */
const imapIntegration = Effect.gen(function* () {
  const seeds = yield* EmailConformanceConfig
  const incomingHost = yield* requireSeed('imapHost')

  return emailConformanceIntegration(
    seeds.smtpHost === undefined
      ? { incomingProtocol: 'imap', incomingHost }
      : { incomingProtocol: 'imap', incomingHost, smtpHost: seeds.smtpHost }
  )
})

/** IMAP incoming plus SMTP integration for the send cases. */
const sendIntegration = Effect.gen(function* () {
  const incomingHost = yield* requireSeed('imapHost')
  const smtpHost = yield* requireSeed('smtpHost')

  return emailConformanceIntegration({ incomingProtocol: 'imap', incomingHost, smtpHost })
})

const pop3Integration = Effect.gen(function* () {
  const incomingHost = yield* requireSeed('pop3Host')

  return emailConformanceIntegration({ incomingProtocol: 'pop3', incomingHost })
})

const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, EmailConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new EmailConformanceActionFailed({ actionId, code })
      : new EmailConformanceActionFailed({ actionId, code, status })
  )
}

/** Longest failure summary embedded in an `EmailConformanceRestoreFailed` message. */
const failureSummaryLength = 60

const truncated = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length - 3).trimEnd()}...` : text

/** Short, sanitized `Tag: message` summary of a failure (credential patterns redacted). */
const failureSummary = (cause: Cause.Cause<unknown>): string => {
  if (Cause.hasInterruptsOnly(cause)) {
    return 'interrupted'
  }

  const error = Cause.findErrorOption(cause)
  const value = Option.isSome(error) ? error.value : Cause.squash(cause)
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

/**
 * Run `use`, then ALWAYS run `restore` (uninterruptibly; also after a failed claim or an
 * interruption). A failed restore fails the case with `EmailConformanceRestoreFailed`; otherwise
 * the outcome of `use` is returned unchanged.
 */
const withRestore = <A, E, R, E2, R2>(
  caseId: string,
  use: Effect.Effect<A, E, R>,
  restore: Effect.Effect<void, E2, R2>
): Effect.Effect<A, E | EmailConformanceRestoreFailed, R | R2> =>
  Effect.uninterruptibleMask(unmask =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(unmask(use))
      const restored = yield* Effect.exit(restore)

      if (Exit.isFailure(restored)) {
        return yield* Exit.isSuccess(outcome)
          ? new EmailConformanceRestoreFailed({
              caseId,
              reason: failureSummary(restored.cause),
              caseOutcome: 'claim held'
            })
          : new EmailConformanceRestoreFailed({
              caseId,
              reason: failureSummary(restored.cause),
              caseOutcome: 'claim failed',
              claimFailure: failureSummary(outcome.cause)
            })
      }

      return yield* outcome
    })
  )

const composed = (to: ReadonlyArray<string>, subject: string, text: string) =>
  EmailComposeMessage.make({
    to: to.map(address => EmailAddress.make({ address })),
    subject,
    body: EmailBody.make({ text })
  })

const listMessages = (integration: ConnectorIntegration, input: EmailListMessagesInput) =>
  emailListMessagesAction
    .executeTyped({ integration, input })
    .pipe(Effect.flatMap(result => successValue(emailListMessagesAction.id, result)))

const getMessageResult = (
  integration: ConnectorIntegration,
  messageId: string,
  folder?: EmailFolderName
) =>
  emailGetMessageAction.executeTyped({
    integration,
    input: EmailGetMessageInput.make(folder === undefined ? { messageId } : { messageId, folder })
  })

const getMessage = (
  integration: ConnectorIntegration,
  messageId: string,
  folder?: EmailFolderName
) =>
  getMessageResult(integration, messageId, folder).pipe(
    Effect.flatMap(result => successValue(emailGetMessageAction.id, result)),
    Effect.map(output => output.message)
  )

/** Case-insensitive header lookup. */
const headerValues = (message: EmailMessage, name: string): ReadonlyArray<string> =>
  message.headers
    .filter(header => header.name.toLowerCase() === name.toLowerCase())
    .map(header => header.value)

/** Succeeds when `effect` fails with a `validation_failed` `ConnectorError`. */
const expectValidationRejection = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)

    if (Exit.isSuccess(exit)) {
      return yield* new ConformanceMismatch({
        message: `expected ${label} to be rejected with validation_failed, but it succeeded`
      })
    }

    const error = Cause.findErrorOption(exit.cause)

    yield* expectConformance(
      Option.isSome(error) &&
        error.value instanceof ConnectorError &&
        error.value.cause === 'validation_failed',
      `expected ${label} to be rejected with a validation_failed ConnectorError`
    )
  })

// Port-level shims. They wrap the host's own `EmailClient` for one claim; `method.call(client, ...)`
// keeps adapters that rely on `this` working.

type CallLog = Ref.Ref<ReadonlyArray<string>>

const logged =
  <I, A, E>(
    calls: CallLog,
    name: string,
    client: EmailClientApi,
    method: (this: EmailClientApi, input: I) => Effect.Effect<A, E>
  ) =>
  (input: I): Effect.Effect<A, E> =>
    Ref.update(calls, current => [...current, name]).pipe(
      Effect.andThen(Effect.suspend(() => method.call(client, input)))
    )

const loggedOptional = <I, A, E>(
  calls: CallLog,
  name: string,
  client: EmailClientApi,
  method: ((this: EmailClientApi, input: I) => Effect.Effect<A, E>) | undefined
) => (method === undefined ? undefined : logged(calls, name, client, method))

/** The host client with every port call appended to `calls` (method names only). */
const loggingClient = (client: EmailClientApi, calls: CallLog): EmailClientApi => ({
  listMessages: logged(calls, 'listMessages', client, client.listMessages),
  listMessagesFiltered: loggedOptional(
    calls,
    'listMessagesFiltered',
    client,
    client.listMessagesFiltered
  ),
  getMessage: logged(calls, 'getMessage', client, client.getMessage),
  getAttachment: loggedOptional(calls, 'getAttachment', client, client.getAttachment),
  getAttachmentBytes: loggedOptional(
    calls,
    'getAttachmentBytes',
    client,
    client.getAttachmentBytes
  ),
  setRead: loggedOptional(calls, 'setRead', client, client.setRead),
  setFlag: loggedOptional(calls, 'setFlag', client, client.setFlag),
  trash: loggedOptional(calls, 'trash', client, client.trash),
  untrash: loggedOptional(calls, 'untrash', client, client.untrash),
  move: loggedOptional(calls, 'move', client, client.move),
  modifyLabels: loggedOptional(calls, 'modifyLabels', client, client.modifyLabels),
  batchSetRead: loggedOptional(calls, 'batchSetRead', client, client.batchSetRead),
  batchSetFlag: loggedOptional(calls, 'batchSetFlag', client, client.batchSetFlag),
  batchMove: loggedOptional(calls, 'batchMove', client, client.batchMove),
  batchTrash: loggedOptional(calls, 'batchTrash', client, client.batchTrash),
  batchUntrash: loggedOptional(calls, 'batchUntrash', client, client.batchUntrash),
  batchModifyLabels: loggedOptional(calls, 'batchModifyLabels', client, client.batchModifyLabels),
  deletePermanently: loggedOptional(calls, 'deletePermanently', client, client.deletePermanently),
  createDraft: logged(calls, 'createDraft', client, client.createDraft),
  sendMessage: logged(calls, 'sendMessage', client, client.sendMessage)
})

/** Where a case-owned message currently is; `messageId` is unknown after an id-less move. */
type OwnLocation = { readonly folder: EmailFolderName; readonly messageId: string | undefined }

type PendingLocations = Ref.Ref<ReadonlyArray<OwnLocation>>

/** Permanently delete every pending case-owned message; each must report `succeeded`. */
const removeOwnMessages =
  (integration: ConnectorIntegration) => (locations: ReadonlyArray<OwnLocation>) =>
    Effect.forEach(
      locations,
      location =>
        Effect.gen(function* () {
          const messageId = location.messageId

          if (messageId === undefined) {
            return yield* new ConformanceMismatch({
              message: `a case-created message in ${location.folder} has no known id`
            })
          }

          const output = yield* emailDeletePermanentlyAction
            .executeTyped({
              integration,
              input: { messageIds: [messageId], folder: location.folder }
            })
            .pipe(Effect.flatMap(result => successValue(emailDeletePermanentlyAction.id, result)))

          yield* expectEqual(
            output.results.map(item => item.status),
            ['succeeded'],
            'expected the case-created message to be permanently deleted'
          )
        }),
      { discard: true }
    )

/**
 * Create a case-owned draft, run `use`, then ALWAYS delete whatever is still pending. The create
 * and the registration of its location run uninterruptibly; a failed create fails with
 * `EmailConformanceActionFailed` (`createOutcome: 'unknown'`), and a create without a `draftId`
 * fails with `EmailConformanceRestoreFailed` (nothing can be removed automatically).
 */
const withOwnDraft = <A, E, R>(
  caseId: string,
  integration: ConnectorIntegration,
  draft: { readonly folder?: EmailFolderName; readonly subject: string },
  use: (
    created: { readonly folder: EmailFolderName; readonly draftId: string },
    pending: PendingLocations
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const pending: PendingLocations = yield* Ref.make<ReadonlyArray<OwnLocation>>([])

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const created = yield* emailCreateDraftAction
          .executeTyped({
            integration,
            input: EmailCreateDraftInput.make({
              message: composed([], draft.subject, 'Synthetic conformance draft; never sent.'),
              folder: draft.folder
            })
          })
          .pipe(
            Effect.flatMap(result => successValue(emailCreateDraftAction.id, result)),
            Effect.mapError(error =>
              error instanceof EmailConformanceActionFailed
                ? new EmailConformanceActionFailed({
                    actionId: error.actionId,
                    code: error.code,
                    createOutcome: 'unknown'
                  })
                : new EmailConformanceActionFailed({
                    actionId: emailCreateDraftAction.id,
                    code: error.cause,
                    createOutcome: 'unknown'
                  })
            )
          )

        const draftId = created.draftId

        if (draftId === undefined) {
          return yield* new EmailConformanceRestoreFailed({
            caseId,
            reason: 'the create returned no draftId, so nothing was removed',
            caseOutcome: 'claim failed'
          })
        }

        yield* Ref.set(pending, [{ folder: created.folder, messageId: draftId }])

        return yield* withRestore(
          caseId,
          unmask(use({ folder: created.folder, draftId }, pending)),
          Ref.get(pending).pipe(Effect.flatMap(removeOwnMessages(integration)))
        )
      })
    )
  })

/** Track a move of a case-owned message: the new location replaces the pending one. */
const trackMove = (
  pending: PendingLocations,
  moved: { readonly folder: EmailFolderName; readonly messageId?: string | undefined }
) => Ref.set(pending, [{ folder: moved.folder, messageId: moved.messageId }])

// Case ids and the subjects their fixtures record.

export const emailListAndGetHeadersCaseId = 'email.imap.list-and-get-headers'

export const emailFilteredListNoFallbackCaseId = 'email.imap.filtered-list-no-fallback'

export const emailDraftsDiscoveryCaseId = 'email.imap.draft-drafts-discovery'

export const emailSetReadAndFlagCaseId = 'email.imap.set-read-and-flag'

export const emailTrashUntrashCaseId = 'email.imap.trash-untrash-to-inbox'

export const emailMoveDestinationIdsCaseId = 'email.imap.move-destination-ids'

export const emailPop3RejectionsCaseId = 'email.pop3.rejects-folders-drafts-mutations'

export const emailSentCopyStatusesCaseId = 'email.smtp.sent-copy-statuses'

export const emailLegacySentCopyCaseId = 'email.smtp.legacy-host-sent-copy'

export const emailAcceptanceNotDeliveryCaseId = 'email.smtp.acceptance-not-delivery'

/** Subjects of the drafts and messages the cases create (recorded in the fixtures). */
export const emailConformanceSubjects = {
  draftDiscovery: `${emailConformanceMarker} draft discovery: safe to delete`,
  trashUntrash: `${emailConformanceMarker} trash probe: safe to delete`,
  move: `${emailConformanceMarker} move probe: safe to delete`,
  sentSaved: `${emailConformanceMarker} send: saved copy`,
  sentSkipped: `${emailConformanceMarker} send: copy skipped`,
  sentFailed: `${emailConformanceMarker} send: copy fails`,
  legacyRequested: `${emailConformanceMarker} send: legacy host, copy requested`,
  legacyDisabled: `${emailConformanceMarker} send: legacy host, copy disabled`,
  undeliverable: `${emailConformanceMarker} send: accepted, undeliverable`
} as const

/**
 * Host-port convention the cases rely on: `EmailClient.getMessage` for an id that addresses no
 * message in the folder answers `ActionResult.failure` with exactly this code. Any other failure
 * (authentication, throttling, server errors) proves nothing about absence.
 */
export const emailMessageNotFoundCode = 'message_not_found'

/** Folder the failed-Sent-copy send names; it must not exist in the practice mailbox. */
export const emailConformanceMissingFolder = `${emailConformanceMarker}-missing-sent-folder`

const fixtureId = (caseId: string, step: string) => `${caseId}.${step}.synthetic`

// Reads.

export const emailListAndGetHeadersCase: EmailConformanceCase = defineConformanceCase({
  id: emailListAndGetHeadersCaseId,
  title: 'IMAP list and get: get returns the required headers without marking the message read',
  safety: 'read',
  docs: '`EmailClient.getMessage` hosts MUST return the RFC 5322 header fields as `headers` (IMAP via `BODY.PEEK[HEADER]`); list summaries carry no headers. RFC 5322 requires `Date` and `From` on every message.',
  wire: '`email.list_messages` of INBOX lists the seeded unread message with `isRead: false`; `email.get_message` of its id returns the same id and name/value `headers` that include `Date` and `From` (and, when the message carries a `Message-ID`, the returned `messageId` equals that header); listing INBOX again still reports the message unread, so the fetch used `BODY.PEEK` and set no `\\Seen` flag.',
  fixtures: [
    fixtureId(emailListAndGetHeadersCaseId, 'list'),
    fixtureId(emailListAndGetHeadersCaseId, 'get'),
    fixtureId(emailListAndGetHeadersCaseId, 'list-again')
  ],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const messageId = yield* requireSeed('unreadMessageId')

    const listedUnread = (label: string) =>
      Effect.gen(function* () {
        const listed = yield* listMessages(integration, EmailListMessagesInput.make({}))
        const summary = listed.messages.find(message => message.id === messageId)

        if (summary === undefined) {
          return yield* new ConformanceMismatch({
            message: `precondition: the seeded unreadMessageId is not in the first INBOX page (${label})`
          })
        }

        yield* expectEqual(
          summary.isRead ?? null,
          false,
          `expected the seeded message to be listed unread (${label})`
        )
      })

    yield* listedUnread('before get')

    const message = yield* getMessage(integration, messageId)

    yield* expectEqual(message.id, messageId, 'expected get_message to return the requested id')
    yield* expectConformance(
      headerValues(message, 'date').length > 0 && headerValues(message, 'from').length > 0,
      'expected get_message headers to include the required Date and From fields',
      { actual: message.headers.map(header => header.name) }
    )

    const messageIdHeaders = headerValues(message, 'message-id')

    if (messageIdHeaders.length > 0) {
      yield* expectConformance(
        message.messageId !== undefined && messageIdHeaders.includes(message.messageId),
        'expected messageId to equal the Message-ID header'
      )
    }

    yield* listedUnread('after get')
  })
})

export const emailFilteredListNoFallbackCase: EmailConformanceCase = defineConformanceCase({
  id: emailFilteredListNoFallbackCaseId,
  title: 'A filtered list uses listMessagesFiltered and never falls back to listMessages',
  safety: 'read',
  docs: 'Filtered `email.list_messages` requests (`isRead` / `isFlagged`) go through the optional `EmailClient.listMessagesFiltered` and never fall back to the legacy `listMessages`, which cannot honour the filter.',
  wire: '`email.list_messages` with `isRead: false` calls the host `listMessagesFiltered` exactly once and `listMessages` never, and every returned summary is unread (`isRead: false`), the seeded unread message included. Against the same host wrapped as a legacy host (a port-level shim that removes `listMessagesFiltered`), the same request fails with `validation_failed` and still never calls `listMessages`.',
  fixtures: [fixtureId(emailFilteredListNoFallbackCaseId, 'list-unread')],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const messageId = yield* requireSeed('unreadMessageId')
    const client = yield* EmailClient
    const calls: CallLog = yield* Ref.make<ReadonlyArray<string>>([])
    const logging = loggingClient(client, calls)
    const unread = EmailListMessagesInput.make({ isRead: false })

    const listed = yield* listMessages(integration, unread).pipe(
      Effect.provideService(EmailClient, logging)
    )

    yield* expectEqual(
      yield* Ref.get(calls),
      ['listMessagesFiltered'],
      'expected the filtered list to call listMessagesFiltered once and listMessages never'
    )
    yield* expectConformance(
      listed.messages.length > 0 && listed.messages.every(message => message.isRead === false),
      'expected every summary of an isRead: false list to be unread',
      { actual: listed.messages.map(message => message.isRead ?? null) }
    )
    yield* expectConformance(
      listed.messages.some(message => message.id === messageId),
      'expected the seeded unread message among the filtered results'
    )

    yield* Ref.set(calls, [])

    yield* expectValidationRejection(
      'a filtered list against a legacy host without listMessagesFiltered',
      listMessages(integration, unread).pipe(
        Effect.provideService(EmailClient, { ...logging, listMessagesFiltered: undefined })
      )
    )
    yield* expectEqual(
      yield* Ref.get(calls),
      [],
      'expected no port call (and no listMessages fallback) for a legacy host'
    )
  })
})

// Drafts, message state, trash, and move.

export const emailDraftsDiscoveryCase: EmailConformanceCase = defineConformanceCase({
  id: emailDraftsDiscoveryCaseId,
  title: 'A draft without a folder lands in the discovered \\Drafts mailbox',
  safety: 'write-reversible',
  docs: 'IMAP draft adapters generate MIME, `APPEND` it with the `\\Draft` flag, and, when no folder is provided, discover the mailbox advertised with the `\\Drafts` SPECIAL-USE attribute (RFC 6154), with a host-defined fallback only when none is advertised.',
  wire: '`email.create_draft` without a folder answers `saved: true`, a `draftId`, and `folder` equal to the seeded `\\Drafts` mailbox (the practice mailbox names it something other than `Drafts`, so a hard-coded fallback fails the case); `email.get_message` of that id in that folder returns the draft with the requested subject. The `\\Draft` flag itself is not visible through the port (labels are keywords only), so a live run checks it by hand. The case permanently deletes its own draft again.',
  fixtures: [
    fixtureId(emailDraftsDiscoveryCaseId, 'create'),
    fixtureId(emailDraftsDiscoveryCaseId, 'get'),
    fixtureId(emailDraftsDiscoveryCaseId, 'delete')
  ],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const draftsFolder = yield* requireFolderSeed('draftsFolder')

    yield* withOwnDraft(
      emailDraftsDiscoveryCaseId,
      integration,
      { subject: emailConformanceSubjects.draftDiscovery },
      created =>
        Effect.gen(function* () {
          yield* expectEqual(
            created.folder,
            draftsFolder,
            'expected the draft in the discovered \\Drafts mailbox'
          )

          const draft = yield* getMessage(integration, created.draftId, created.folder)

          yield* expectEqual(draft.id, created.draftId, 'expected the draftId to address the draft')
          yield* expectEqual(
            draft.subject ?? null,
            emailConformanceSubjects.draftDiscovery,
            'expected the saved draft to carry the requested subject'
          )
        })
    )
  })
})

const flagState = (message: EmailMessage) => ({
  isRead: message.isRead ?? null,
  isFlagged: message.isFlagged ?? null
})

export const emailSetReadAndFlagCase: EmailConformanceCase = defineConformanceCase({
  id: emailSetReadAndFlagCaseId,
  title: 'set_read and set_flag change exactly one flag each and restore cleanly',
  safety: 'write-reversible',
  docs: '`email.set_read` and `email.set_flag` require IMAP and the optional host `setRead` / `setFlag`; hosts use UID `STORE` `+FLAGS.SILENT` / `-FLAGS.SILENT` for `\\Seen` / `\\Flagged` and preserve every other flag. Folder defaults to INBOX.',
  wire: 'On the seeded unread, unflagged INBOX message, `email.set_read` true answers `{ messageId, isRead: true }` and `email.get_message` then reports read and still unflagged; `email.set_flag` true answers `{ messageId, isFlagged: true }` and `get_message` then reports read and flagged. The restore always clears both again (`set_read` false, `set_flag` false) and `get_message` confirms the seeded state.',
  fixtures: [
    fixtureId(emailSetReadAndFlagCaseId, 'get-before'),
    fixtureId(emailSetReadAndFlagCaseId, 'set-read'),
    fixtureId(emailSetReadAndFlagCaseId, 'get-read'),
    fixtureId(emailSetReadAndFlagCaseId, 'set-flag'),
    fixtureId(emailSetReadAndFlagCaseId, 'get-flagged'),
    fixtureId(emailSetReadAndFlagCaseId, 'restore-read'),
    fixtureId(emailSetReadAndFlagCaseId, 'restore-flag'),
    fixtureId(emailSetReadAndFlagCaseId, 'get-restored')
  ],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const messageId = yield* requireSeed('unreadMessageId')

    const setRead = (isRead: boolean) =>
      emailSetReadAction
        .executeTyped({ integration, input: EmailSetReadInput.make({ messageId, isRead }) })
        .pipe(Effect.flatMap(result => successValue(emailSetReadAction.id, result)))

    const setFlag = (isFlagged: boolean) =>
      emailSetFlagAction
        .executeTyped({ integration, input: EmailSetFlagInput.make({ messageId, isFlagged }) })
        .pipe(Effect.flatMap(result => successValue(emailSetFlagAction.id, result)))

    yield* expectEqual(
      flagState(yield* getMessage(integration, messageId)),
      { isRead: false, isFlagged: false },
      'precondition: the seeded unreadMessageId must be unread and unflagged'
    )

    const restore = Effect.gen(function* () {
      yield* setRead(false)
      yield* setFlag(false)
      yield* expectEqual(
        flagState(yield* getMessage(integration, messageId)),
        { isRead: false, isFlagged: false },
        'expected the restore to leave the seeded message unread and unflagged'
      )
    })

    yield* withRestore(
      emailSetReadAndFlagCaseId,
      Effect.gen(function* () {
        const read = yield* setRead(true)

        yield* expectEqual(
          { messageId: read.messageId, isRead: read.isRead },
          { messageId, isRead: true },
          'expected set_read to answer the message id and isRead true'
        )
        yield* expectEqual(
          flagState(yield* getMessage(integration, messageId)),
          { isRead: true, isFlagged: false },
          'expected set_read to change only the read state'
        )

        const flagged = yield* setFlag(true)

        yield* expectEqual(
          { messageId: flagged.messageId, isFlagged: flagged.isFlagged },
          { messageId, isFlagged: true },
          'expected set_flag to answer the message id and isFlagged true'
        )
        yield* expectEqual(
          flagState(yield* getMessage(integration, messageId)),
          { isRead: true, isFlagged: true },
          'expected set_flag to change only the flagged state'
        )
      }),
      restore
    )
  })
})

export const emailTrashUntrashCase: EmailConformanceCase = defineConformanceCase({
  id: emailTrashUntrashCaseId,
  title: 'Trash moves to the discovered \\Trash mailbox; untrash restores to INBOX',
  safety: 'write-reversible',
  docs: '`email.trash` moves (never deletes) a message to the discovered `\\Trash` mailbox unless `trashFolder` is given; `email.untrash` moves it to `destinationFolder`, which defaults to INBOX, not the original folder. Moved ids use the destination UIDVALIDITY/UID when known.',
  wire: 'The case saves its own draft in the seeded Drafts mailbox. `email.trash` of it answers `moved: true`, `folder` equal to the seeded `\\Trash` mailbox, and a new `messageId` (the destination UID, never the stale source id); `email.untrash` of that id answers `folder: "INBOX"` (not the Drafts mailbox it came from) and another new `messageId`, which `email.get_message` resolves in INBOX to the same subject. The case permanently deletes its message from wherever it ended up.',
  fixtures: [
    fixtureId(emailTrashUntrashCaseId, 'create'),
    fixtureId(emailTrashUntrashCaseId, 'trash'),
    fixtureId(emailTrashUntrashCaseId, 'untrash'),
    fixtureId(emailTrashUntrashCaseId, 'get'),
    fixtureId(emailTrashUntrashCaseId, 'delete')
  ],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const draftsFolder = yield* requireFolderSeed('draftsFolder')
    const trashFolder = yield* requireFolderSeed('trashFolder')

    yield* withOwnDraft(
      emailTrashUntrashCaseId,
      integration,
      { folder: draftsFolder, subject: emailConformanceSubjects.trashUntrash },
      (created, pending) =>
        Effect.gen(function* () {
          const trashed = yield* Effect.uninterruptible(
            emailTrashAction
              .executeTyped({
                integration,
                input: EmailTrashInput.make({ messageId: created.draftId, folder: created.folder })
              })
              .pipe(
                Effect.flatMap(result => successValue(emailTrashAction.id, result)),
                Effect.tap(moved => trackMove(pending, moved))
              )
          )

          yield* expectEqual(
            trashed.folder,
            trashFolder,
            'expected trash to move the message to the discovered \\Trash mailbox'
          )

          const trashedId = trashed.messageId

          if (trashedId === undefined || trashedId === created.draftId) {
            return yield* new ConformanceMismatch({
              message: 'expected trash to return the destination id, distinct from the source id'
            })
          }

          const restored = yield* Effect.uninterruptible(
            emailUntrashAction
              .executeTyped({
                integration,
                input: EmailUntrashInput.make({ messageId: trashedId, folder: trashed.folder })
              })
              .pipe(
                Effect.flatMap(result => successValue(emailUntrashAction.id, result)),
                Effect.tap(moved => trackMove(pending, moved))
              )
          )

          yield* expectEqual(
            restored.folder,
            inbox,
            'expected untrash to restore to INBOX, not the original folder'
          )

          const restoredId = restored.messageId

          if (restoredId === undefined || restoredId === trashedId) {
            return yield* new ConformanceMismatch({
              message: 'expected untrash to return the INBOX id, distinct from the trash id'
            })
          }

          const message = yield* getMessage(integration, restoredId)

          yield* expectEqual(
            message.subject ?? null,
            emailConformanceSubjects.trashUntrash,
            'expected the restored id to address the case-created message in INBOX'
          )
        })
    )
  })
})

export const emailMoveDestinationIdsCase: EmailConformanceCase = defineConformanceCase({
  id: emailMoveDestinationIdsCaseId,
  title: 'A move returns the destination id; the stale source id no longer resolves',
  safety: 'write-reversible',
  docs: '`email.move` relocates a message to a required `destinationFolder` (UID `MOVE`, or `COPY` plus a UID-scoped expunge) and returns the destination UIDVALIDITY/UID mapping when known; hosts never reuse a stale source UID or fabricate destination ids.',
  wire: 'The case saves its own draft in the seeded Drafts mailbox. `email.move` to the seeded destination answers `moved: true`, that `folder`, and a `messageId` different from the source id; `email.get_message` resolves the new id in the destination to the same subject, while `email.get_message` of the old id in the source mailbox answers the not-found failure (`ActionResult.failure` with code `message_not_found`, the host-port convention for an id that addresses no message; any other failure fails the case). The case permanently deletes its message from the destination.',
  fixtures: [
    fixtureId(emailMoveDestinationIdsCaseId, 'create'),
    fixtureId(emailMoveDestinationIdsCaseId, 'move'),
    fixtureId(emailMoveDestinationIdsCaseId, 'get-destination'),
    fixtureId(emailMoveDestinationIdsCaseId, 'get-stale-source'),
    fixtureId(emailMoveDestinationIdsCaseId, 'delete')
  ],
  run: Effect.gen(function* () {
    const integration = yield* imapIntegration
    const draftsFolder = yield* requireFolderSeed('draftsFolder')
    const destination = yield* requireFolderSeed('moveDestinationFolder')

    yield* withOwnDraft(
      emailMoveDestinationIdsCaseId,
      integration,
      { folder: draftsFolder, subject: emailConformanceSubjects.move },
      (created, pending) =>
        Effect.gen(function* () {
          const moved = yield* Effect.uninterruptible(
            emailMoveAction
              .executeTyped({
                integration,
                input: EmailMoveInput.make({
                  messageId: created.draftId,
                  folder: created.folder,
                  destinationFolder: destination
                })
              })
              .pipe(
                Effect.flatMap(result => successValue(emailMoveAction.id, result)),
                Effect.tap(output => trackMove(pending, output))
              )
          )

          yield* expectEqual(
            moved.folder,
            destination,
            'expected the move to answer the destination'
          )

          const movedId = moved.messageId

          if (movedId === undefined || movedId === created.draftId) {
            return yield* new ConformanceMismatch({
              message: 'expected the move to return the destination id, distinct from the source id'
            })
          }

          const message = yield* getMessage(integration, movedId, destination)

          yield* expectEqual(
            message.subject ?? null,
            emailConformanceSubjects.move,
            'expected the destination id to address the moved message'
          )

          const stale = yield* getMessageResult(integration, created.draftId, created.folder)

          yield* expectEqual(
            Predicate.isTagged(stale, 'Failure') ? stale.error.code : 'success',
            emailMessageNotFoundCode,
            'expected the stale source id to answer message_not_found after the move'
          )
        })
    )
  })
})

export const emailPop3RejectionsCase: EmailConformanceCase = defineConformanceCase({
  id: emailPop3RejectionsCaseId,
  title: 'POP3 rejects folders, filters, drafts, and every mailbox mutation before any port call',
  safety: 'read',
  docs: 'POP3 has one maildrop and no flags: the connector rejects folders, read/flag filters, drafts, and every mailbox mutation action for a POP3 incoming configuration before resolving credentials, and reads the maildrop through the same `EmailClient`.',
  wire: 'With `incomingProtocol: pop3`, `email.list_messages` with a folder or an `isRead` filter, `email.get_message` with a folder, `email.create_draft`, the single-message mutations (`email.set_read`, `email.set_flag`, `email.trash`, `email.untrash`, `email.move`, `email.modify_labels`), the batch mutations (`email.batch_set_read`, `email.batch_set_flag`, `email.batch_move`, `email.batch_trash`, `email.batch_untrash`, `email.batch_modify_labels`), and `email.delete_permanently` each fail with `validation_failed` while the host sees no port call and no credential is resolved. As a control, a plain `email.list_messages` reaches the host exactly once (`listMessages`) and answers summaries.',
  fixtures: [fixtureId(emailPop3RejectionsCaseId, 'list')],
  run: Effect.gen(function* () {
    const integration = yield* pop3Integration
    const client = yield* EmailClient
    const resolver = yield* CredentialResolver
    const calls: CallLog = yield* Ref.make<ReadonlyArray<string>>([])
    const resolutions = yield* Ref.make(0)

    const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(EmailClient, loggingClient(client, calls)),
        Effect.provideService(
          CredentialResolver,
          CredentialResolver.of({
            resolve: request =>
              Ref.update(resolutions, count => count + 1).pipe(
                Effect.andThen(resolver.resolve(request))
              )
          })
        )
      )

    const messageId = 'yolk-conformance-pop3-message'

    const rejections: ReadonlyArray<
      readonly [string, Effect.Effect<unknown, unknown, EmailConformanceRequirements>]
    > = [
      [
        'a list with a folder',
        emailListMessagesAction.executeTyped({
          integration,
          input: EmailListMessagesInput.make({ folder: inbox })
        })
      ],
      [
        'a list with an isRead filter',
        emailListMessagesAction.executeTyped({
          integration,
          input: EmailListMessagesInput.make({ isRead: false })
        })
      ],
      [
        'a get with a folder',
        emailGetMessageAction.executeTyped({
          integration,
          input: EmailGetMessageInput.make({ messageId, folder: inbox })
        })
      ],
      [
        'a draft',
        emailCreateDraftAction.executeTyped({
          integration,
          input: EmailCreateDraftInput.make({
            message: composed([], `${emailConformanceMarker} pop3 draft`, 'Never saved.')
          })
        })
      ],
      [
        'set_read',
        emailSetReadAction.executeTyped({
          integration,
          input: EmailSetReadInput.make({ messageId, isRead: true })
        })
      ],
      [
        'set_flag',
        emailSetFlagAction.executeTyped({
          integration,
          input: EmailSetFlagInput.make({ messageId, isFlagged: true })
        })
      ],
      [
        'trash',
        emailTrashAction.executeTyped({ integration, input: EmailTrashInput.make({ messageId }) })
      ],
      [
        'untrash',
        emailUntrashAction.executeTyped({
          integration,
          input: EmailUntrashInput.make({ messageId })
        })
      ],
      [
        'move',
        emailMoveAction.executeTyped({
          integration,
          input: EmailMoveInput.make({
            messageId,
            destinationFolder: EmailFolderName.make(`${emailConformanceMarker}-pop3`)
          })
        })
      ],
      [
        'modify_labels',
        emailModifyLabelsAction.executeTyped({
          integration,
          input: EmailModifyLabelsInput.make({ messageId, addLabels: [emailConformanceMarker] })
        })
      ],
      [
        'batch_set_read',
        emailBatchSetReadAction.executeTyped({
          integration,
          input: { messageIds: [messageId], isRead: true }
        })
      ],
      [
        'batch_set_flag',
        emailBatchSetFlagAction.executeTyped({
          integration,
          input: { messageIds: [messageId], isFlagged: true }
        })
      ],
      [
        'batch_move',
        emailBatchMoveAction.executeTyped({
          integration,
          input: {
            messageIds: [messageId],
            destinationFolder: EmailFolderName.make(`${emailConformanceMarker}-pop3`)
          }
        })
      ],
      [
        'batch_trash',
        emailBatchTrashAction.executeTyped({ integration, input: { messageIds: [messageId] } })
      ],
      [
        'batch_untrash',
        emailBatchUntrashAction.executeTyped({ integration, input: { messageIds: [messageId] } })
      ],
      [
        'batch_modify_labels',
        emailBatchModifyLabelsAction.executeTyped({
          integration,
          input: { messageIds: [messageId], removeLabels: [emailConformanceMarker] }
        })
      ],
      [
        'delete_permanently',
        emailDeletePermanentlyAction.executeTyped({
          integration,
          input: { messageIds: [messageId] }
        })
      ]
    ]

    for (const [label, rejected] of rejections) {
      yield* expectValidationRejection(`POP3 ${label}`, observed(rejected))
    }

    yield* expectEqual(yield* Ref.get(calls), [], 'expected no port call for any POP3 rejection')
    yield* expectEqual(
      yield* Ref.get(resolutions),
      0,
      'expected POP3 rejections before any credential resolution'
    )

    const listed = yield* observed(listMessages(integration, EmailListMessagesInput.make({})))

    yield* expectEqual(
      yield* Ref.get(calls),
      ['listMessages'],
      'expected a plain POP3 list to reach the host listMessages exactly once'
    )
    yield* expectConformance(
      listed.messages.length > 0,
      'expected the POP3 maildrop list to answer summaries'
    )
  })
})

// SMTP submission and Sent copies.

const sendMessage = (integration: ConnectorIntegration, input: EmailSendMessageInput) =>
  emailSendMessageAction
    .executeTyped({ integration, input })
    .pipe(Effect.flatMap(result => successValue(emailSendMessageAction.id, result)))

/** Output fields that exist on `email.send_message`; nothing among them claims delivery. */
const sendOutputFields: ReadonlyArray<string> = ['accepted', 'submissionId', 'sentCopy', 'warning']

const definedFields = (output: EmailSendMessageOutput): ReadonlyArray<string> =>
  Object.entries(output).flatMap(([key, value]) => (value === undefined ? [] : [key]))

/** What the host saw of each `sendMessage` request (never the credential). */
type SeenSend = { readonly sentCopy: boolean; readonly sentCopyProtocol: string | null }

const recordingSends = (client: EmailClientApi, seen: Ref.Ref<ReadonlyArray<SeenSend>>) => ({
  ...client,
  sendMessage: (request: EmailSendMessageRequest) =>
    Ref.update(seen, current => [
      ...current,
      {
        sentCopy: request.sentCopy !== undefined,
        sentCopyProtocol: request.sentCopy?.connection.protocol ?? null
      }
    ]).pipe(Effect.andThen(Effect.suspend(() => client.sendMessage.call(client, request))))
})

export const emailSentCopyStatusesCase: EmailConformanceCase = defineConformanceCase({
  id: emailSentCopyStatusesCaseId,
  title: 'Sent-copy statuses: saved, skipped, and failed after acceptance',
  safety: 'write-irreversible',
  docs: '`email.send_message` passes IMAP `sentCopy` (connection plus incoming credential) with the SMTP request only when saving is requested (`saveToSentItems` defaults to saving) and reports `sentCopy.status` `saved | failed | skipped | unsupported`; a Sent-save failure after acceptance never means the message was not sent.',
  wire: 'Three submissions to the practice mailbox itself. Default saving: the host request carries an IMAP `sentCopy` and the output is `accepted: true` with `sentCopy: { status: "saved", folder }` naming the seeded `\\Sent` mailbox. `saveToSentItems: false`: the request carries no `sentCopy` and the status is `skipped`. `sentFolder` naming a mailbox that does not exist: still `accepted: true`, with status `failed`. Sends real mail: manual only.',
  fixtures: [
    fixtureId(emailSentCopyStatusesCaseId, 'send-saved'),
    fixtureId(emailSentCopyStatusesCaseId, 'send-skipped'),
    fixtureId(emailSentCopyStatusesCaseId, 'send-failed')
  ],
  run: Effect.gen(function* () {
    const integration = yield* sendIntegration
    const recipient = yield* requireSeed('recipient')
    const sentFolder = yield* requireFolderSeed('sentFolder')
    const client = yield* EmailClient
    const seen = yield* Ref.make<ReadonlyArray<SeenSend>>([])

    const send = (input: EmailSendMessageInput) =>
      sendMessage(integration, input).pipe(
        Effect.provideService(EmailClient, recordingSends(client, seen))
      )

    const message = (subject: string) =>
      composed([recipient], subject, 'Synthetic conformance message to the practice mailbox.')

    const saved = yield* send(
      EmailSendMessageInput.make({ message: message(emailConformanceSubjects.sentSaved) })
    )

    yield* expectEqual(
      {
        accepted: saved.accepted,
        status: saved.sentCopy?.status ?? null,
        folder: saved.sentCopy?.folder ?? null
      },
      { accepted: true, status: 'saved', folder: sentFolder },
      'expected default saving to report a saved copy in the \\Sent mailbox'
    )

    const skipped = yield* send(
      EmailSendMessageInput.make({
        message: message(emailConformanceSubjects.sentSkipped),
        saveToSentItems: false
      })
    )

    yield* expectEqual(
      { accepted: skipped.accepted, status: skipped.sentCopy?.status ?? null },
      { accepted: true, status: 'skipped' },
      'expected saveToSentItems false to report a skipped copy'
    )

    const failed = yield* send(
      EmailSendMessageInput.make({
        message: message(emailConformanceSubjects.sentFailed),
        sentFolder: EmailFolderName.make(emailConformanceMissingFolder)
      })
    )

    yield* expectEqual(
      { accepted: failed.accepted, status: failed.sentCopy?.status ?? null },
      { accepted: true, status: 'failed' },
      'expected a failed Sent copy to keep the accepted submission (never resend)'
    )
    yield* expectEqual(
      yield* Ref.get(seen),
      [
        { sentCopy: true, sentCopyProtocol: 'imap' },
        { sentCopy: false, sentCopyProtocol: null },
        { sentCopy: true, sentCopyProtocol: 'imap' }
      ],
      'expected an IMAP sentCopy request only when saving was requested'
    )
  })
})

/** A legacy host: it never sees `sentCopy` and never reports one. */
const legacySendClient = (client: EmailClientApi): EmailClientApi => ({
  ...client,
  sendMessage: request =>
    Effect.suspend(() =>
      client.sendMessage.call(
        client,
        EmailSendMessageRequest.make({
          connection: request.connection,
          credential: request.credential,
          message: request.message
        })
      )
    ).pipe(
      Effect.map(result =>
        Predicate.isTagged(result, 'Success')
          ? {
              ...result,
              value: EmailSendMessageOutput.make(
                result.value.submissionId === undefined
                  ? { accepted: true }
                  : { accepted: true, submissionId: result.value.submissionId }
              )
            }
          : result
      )
    )
})

export const emailLegacySentCopyCase: EmailConformanceCase = defineConformanceCase({
  id: emailLegacySentCopyCaseId,
  title: 'A legacy host without sentCopy gets unsupported or skipped, never saved',
  safety: 'write-irreversible',
  docs: 'Legacy hosts that omit `sentCopy` from their `sendMessage` output get an honest status synthesized by the action: `unsupported` when saving was requested, `skipped` when it was disabled, never `saved`.',
  wire: 'Against the host wrapped as a legacy host (a port-level shim that drops `sentCopy` from the request and from the answer), `email.send_message` with default saving answers `accepted: true` and `sentCopy.status: "unsupported"`, and with `saveToSentItems: false` answers `skipped`; neither is ever `saved`. Two submissions to the practice mailbox itself: manual only.',
  fixtures: [
    fixtureId(emailLegacySentCopyCaseId, 'send-requested'),
    fixtureId(emailLegacySentCopyCaseId, 'send-disabled')
  ],
  run: Effect.gen(function* () {
    const integration = yield* sendIntegration
    const recipient = yield* requireSeed('recipient')
    const client = yield* EmailClient

    const send = (subject: string, saveToSentItems?: boolean) =>
      sendMessage(
        integration,
        EmailSendMessageInput.make({
          message: composed([recipient], subject, 'Synthetic legacy-host conformance message.'),
          saveToSentItems
        })
      ).pipe(Effect.provideService(EmailClient, legacySendClient(client)))

    const requested = yield* send(emailConformanceSubjects.legacyRequested)

    yield* expectEqual(
      { accepted: requested.accepted, status: requested.sentCopy?.status ?? null },
      { accepted: true, status: 'unsupported' },
      'expected a legacy host with saving requested to get an unsupported copy status'
    )

    const disabled = yield* send(emailConformanceSubjects.legacyDisabled, false)

    yield* expectEqual(
      { accepted: disabled.accepted, status: disabled.sentCopy?.status ?? null },
      { accepted: true, status: 'skipped' },
      'expected a legacy host with saving disabled to get a skipped copy status'
    )
  })
})

export const emailAcceptanceNotDeliveryCase: EmailConformanceCase = defineConformanceCase({
  id: emailAcceptanceNotDeliveryCaseId,
  title: 'SMTP acceptance is submission, not delivery',
  safety: 'write-irreversible',
  docs: 'SMTP acceptance means submission only, not delivery: `email.send_message` answers `{ accepted: true }` once the submission server accepts the message; delivery failures arrive later as separate bounce messages (DSNs).',
  wire: '`email.send_message` to the seeded undeliverable address (with `saveToSentItems: false`) still answers `accepted: true`, and the output carries only `accepted`, `submissionId`, `sentCopy`, and `warning`: no field claims delivery. The bounce, if any, arrives later in the practice mailbox. Sends real mail: manual only.',
  fixtures: [fixtureId(emailAcceptanceNotDeliveryCaseId, 'send')],
  run: Effect.gen(function* () {
    const integration = yield* sendIntegration
    const undeliverable = yield* requireSeed('undeliverableRecipient')

    const output = yield* sendMessage(
      integration,
      EmailSendMessageInput.make({
        message: composed(
          [undeliverable],
          emailConformanceSubjects.undeliverable,
          'Synthetic conformance message to an undeliverable address.'
        ),
        saveToSentItems: false
      })
    )

    yield* expectEqual(
      output.accepted,
      true,
      'expected SMTP to accept a submission to an undeliverable address'
    )
    yield* expectConformance(
      definedFields(output).every(field => sendOutputFields.includes(field)),
      'expected the send output to claim submission only, never delivery',
      { actual: definedFields(output) }
    )
  })
})

/** Every email conformance case, in fixture order. */
export const emailConformanceCases: ReadonlyArray<EmailConformanceCase> = [
  emailListAndGetHeadersCase,
  emailFilteredListNoFallbackCase,
  emailDraftsDiscoveryCase,
  emailSetReadAndFlagCase,
  emailTrashUntrashCase,
  emailMoveDestinationIdsCase,
  emailPop3RejectionsCase,
  emailSentCopyStatusesCase,
  emailLegacySentCopyCase,
  emailAcceptanceNotDeliveryCase
]
