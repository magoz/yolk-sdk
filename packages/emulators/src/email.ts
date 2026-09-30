/**
 * Email emulator: a fixture-driven, in-memory fake backend for the generic `EmailClient` port.
 *
 * Yolk never speaks IMAP, POP3, or SMTP; hosts implement `EmailClient`. This emulator stands in for
 * such a host at the port level: `call(method, request)` takes one port call as plain JSON (the
 * credential-free request) and answers `{ response }`, `{ failure }`, or a fail-closed
 * `{ notEmulated }`. There is no socket, TLS, MIME, or mail library here, no `node:` builtin, and
 * no SDK import: it is a plain structural object, and
 * `emailClientLayerFromBackend` in `@yolk-sdk/connectors/email/conformance` turns it into the
 * `EmailClient` layer.
 *
 * Response behaviour comes ONLY from the email conformance fixtures (copied as data in
 * `email-fixtures.ts`). The emulator keeps an in-memory mailbox (folders, messages, flags) seeded
 * with the mailbox the fixtures describe; the state only selects which fixture answers (the first
 * matching fixture consistent with the mailbox) and is updated with what that fixture says
 * happened (flags set, a message moved to the destination id the fixture names, a draft appended,
 * a Sent copy saved). It never invents an id, a flag, or a response.
 *
 * Request-shape latitude (the only one): credential fields are never compared or recorded, and
 * `connection.host` is not compared (the practice host comes from seeds). Every other connection
 * field (`protocol`, `port`, `security`) is compared. Everything else must equal a fixture request exactly. Anything that does not
 * match (an unknown method, no matching fixture, or no fixture consistent with the mailbox state)
 * fails closed with a ledgered `notEmulated` answer, the port analogue of HTTP 400.
 *
 * @experimental
 */
import { Data, Equal, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  emailEmulatorFixtures,
  type EmailEmulatorFailure,
  type EmailEmulatorFixture
} from './email-fixtures.ts'
import {
  bindRouteHandlers,
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emailEmulatorFixtures, type EmailEmulatorFailure, type EmailEmulatorFixture }

/** The port every email fixture and manifest route names. */
export const emailEmulatorPort = 'EmailClient'

/** Manifest routes of port emulators use this pseudo method; `path` is `<Port>.<method>`. */
export const emailEmulatorRouteMethod = 'PORT'

const portRoute = (
  method: string,
  write: boolean,
  caseIds: ReadonlyArray<string>
): EmulatorRouteEvidence => ({
  method: emailEmulatorRouteMethod,
  path: `${emailEmulatorPort}.${method}`,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  observedAt: undefined
})

const listAndGet = 'email.imap.list-and-get-headers'

const filteredList = 'email.imap.filtered-list-no-fallback'

const draftsDiscovery = 'email.imap.draft-drafts-discovery'

const setReadAndFlag = 'email.imap.set-read-and-flag'

const trashUntrash = 'email.imap.trash-untrash-to-inbox'

const moveIds = 'email.imap.move-destination-ids'

const pop3Rejections = 'email.pop3.rejects-folders-drafts-mutations'

const sentCopyStatuses = 'email.smtp.sent-copy-statuses'

const legacySentCopy = 'email.smtp.legacy-host-sent-copy'

const acceptanceNotDelivery = 'email.smtp.acceptance-not-delivery'

/**
 * Route evidence manifest: every emulated `EmailClient` method (`PORT EmailClient.<method>`) and the
 * email conformance cases whose (synthetic, unverified) fixtures it follows. Write methods are
 * unverified connector writes: they need a pending entry in the repo's evidence check until an
 * owner-approved live run against a practice mailbox verifies them.
 */
export const emailEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  portRoute('listMessages', false, [listAndGet, pop3Rejections]),
  portRoute('listMessagesFiltered', false, [filteredList]),
  portRoute('getMessage', false, [
    listAndGet,
    draftsDiscovery,
    setReadAndFlag,
    trashUntrash,
    moveIds
  ]),
  portRoute('createDraft', true, [draftsDiscovery, trashUntrash, moveIds]),
  portRoute('sendMessage', true, [sentCopyStatuses, legacySentCopy, acceptanceNotDelivery]),
  portRoute('setRead', true, [setReadAndFlag]),
  portRoute('setFlag', true, [setReadAndFlag]),
  portRoute('trash', true, [trashUntrash]),
  portRoute('untrash', true, [trashUntrash]),
  portRoute('move', true, [moveIds]),
  portRoute('deletePermanently', true, [draftsDiscovery, trashUntrash, moveIds])
]

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

/** SPECIAL-USE attributes (RFC 6154) a seeded folder may advertise. */
export const EmailEmulatorSpecialUse = Schema.Literals([
  '\\All',
  '\\Archive',
  '\\Drafts',
  '\\Flagged',
  '\\Junk',
  '\\Sent',
  '\\Trash'
])

export type EmailEmulatorSpecialUse = typeof EmailEmulatorSpecialUse.Type

/**
 * One message in the emulated mailbox. `id` is the opaque IMAP id (absent for a Sent copy whose
 * id no fixture named), `uidl` the POP3 id of an INBOX message; unknown flags stay absent until a
 * fixture reports them.
 */
export const EmailEmulatorMessage = Schema.Struct({
  id: Schema.optionalKey(NonEmpty),
  uidl: Schema.optionalKey(NonEmpty),
  subject: Schema.optionalKey(Schema.String),
  isRead: Schema.optionalKey(Schema.Boolean),
  isFlagged: Schema.optionalKey(Schema.Boolean)
})

export type EmailEmulatorMessage = typeof EmailEmulatorMessage.Type

export const EmailEmulatorFolder = Schema.Struct({
  name: NonEmpty,
  specialUse: Schema.optionalKey(EmailEmulatorSpecialUse),
  messages: Schema.Array(EmailEmulatorMessage)
})

export type EmailEmulatorFolder = typeof EmailEmulatorFolder.Type

/** The emulated mailbox: plain JSON, used both as the seed and as the `state()` snapshot. */
export const EmailEmulatorSeed = Schema.Struct({
  folders: Schema.Array(EmailEmulatorFolder)
})

export type EmailEmulatorSeed = typeof EmailEmulatorSeed.Type

/** The synthetic practice mailbox the email fixtures describe (the default seed). */
export const emailEmulatorDefaultSeed: EmailEmulatorSeed = {
  folders: [
    {
      name: 'INBOX',
      messages: [
        {
          id: '1700000001:41',
          uidl: 'uidl-synthetic-0041',
          subject: 'Synthetic welcome',
          isRead: false,
          isFlagged: false
        },
        {
          id: '1700000001:42',
          uidl: 'uidl-synthetic-0042',
          subject: 'Synthetic weekly summary',
          isRead: true,
          isFlagged: false
        }
      ]
    },
    { name: 'Saved Drafts', specialUse: '\\Drafts', messages: [] },
    { name: 'Sent Items', specialUse: '\\Sent', messages: [] },
    { name: 'Deleted Items', specialUse: '\\Trash', messages: [] },
    { name: 'Archive', messages: [] }
  ]
}

const Failure = Schema.Struct({
  kind: Schema.Literals(['expected', 'error']),
  code: NonEmpty,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int)
})

/**
 * A fault: answer the next `count` calls (every one when omitted) of `method` whose credential-free
 * request contains `match` (a deep subset: objects by key, arrays element by element, other values
 * exactly) with `failure` instead of a fixture. Faults change no mailbox state.
 */
export const EmailEmulatorFault = Schema.Struct({
  kind: Schema.Literal('failure'),
  method: NonEmpty,
  match: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  count: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  failure: Failure
})

export type EmailEmulatorFault = typeof EmailEmulatorFault.Type

export type EmailEmulatorFaultState = {
  readonly id: number
  readonly fault: EmailEmulatorFault
  /** Remaining matching calls; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

/** Thrown by `makeEmailEmulator` (invalid seed) and `faults.add` (invalid fault). */
export class EmailEmulatorInputInvalid extends Data.TaggedError('EmailEmulatorInputInvalid')<{
  readonly input: 'seed' | 'fault'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid email emulator ${this.input}: ${this.reason}`
  }
}

/** Why a call failed closed. */
export type EmailEmulatorNotEmulatedReason =
  | 'unknown-method'
  | 'invalid-request'
  | 'no-matching-fixture'
  | 'state-conflict'

const notEmulatedText: Record<EmailEmulatorNotEmulatedReason, string> = {
  'unknown-method': 'unknown-method: the method has no emulated route',
  'invalid-request': 'invalid-request: the request is not a JSON object',
  'no-matching-fixture': 'no-matching-fixture: no fixture matches this request',
  'state-conflict': 'state-conflict: no matching fixture is consistent with the emulated mailbox'
}

/** One emulator answer; structurally the reply of a plain-JSON `EmailBackend`. */
export type EmailEmulatorReply =
  | { readonly response: Schema.Json }
  | { readonly failure: EmailEmulatorFailure }
  | { readonly notEmulated: { readonly reason: string } }

export type EmailEmulatorLedgerEntry = {
  readonly seq: number
  readonly method: string
  /** The request as received, without credential fields. */
  readonly request: Schema.Json
  readonly outcome: 'answered' | 'fault' | 'not-emulated'
  /** `unknown-method` for a method outside the manifest. */
  readonly evidence: EmulatorEvidence | 'unknown-method'
  readonly fixtureId?: string
  readonly faultId?: number
  readonly reason?: EmailEmulatorNotEmulatedReason
}

export type EmailEmulatorRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger calls to this method since the last ledger clear or reset. */
  readonly calls: number
}

export type EmailEmulatorCoverage = {
  readonly routes: ReadonlyArray<EmailEmulatorRouteCoverage>
  /** Ledger calls that failed closed. */
  readonly notEmulatedCalls: number
  /** Fixtures that have not answered a call since the emulator was made or last reset. */
  readonly unusedFixtureIds: ReadonlyArray<string>
}

export type EmailEmulatorOptions = {
  /** The initial mailbox. Defaults to `emailEmulatorDefaultSeed`. */
  readonly seed?: EmailEmulatorSeed
}

export type EmailEmulator = {
  /** Answer one `EmailClient` call; never throws. This makes the emulator an `EmailBackend`. */
  readonly call: (method: string, request: Schema.Json) => EmailEmulatorReply
  /** The current mailbox (a copy). */
  readonly state: () => EmailEmulatorSeed
  /** The seed the emulator started from (a copy). */
  readonly seed: () => EmailEmulatorSeed
  readonly ledger: {
    readonly entries: () => ReadonlyArray<EmailEmulatorLedgerEntry>
    readonly clear: () => void
  }
  /** Clear the ledger and faults, forget fixture use, and restore the seeded mailbox. */
  readonly reset: () => void
  readonly faults: {
    readonly add: (fault: EmailEmulatorFault) => EmailEmulatorFaultState
    readonly list: () => ReadonlyArray<EmailEmulatorFaultState>
    readonly clear: () => void
  }
  readonly coverage: () => EmailEmulatorCoverage
}

// JSON helpers.

type JsonObject = Schema.JsonObject

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

const objectField = (value: Schema.Json | undefined, key: string): JsonObject | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return isJsonObject(field) ? field : undefined
}

const stringField = (value: Schema.Json | undefined, key: string): string | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return Predicate.isString(field) ? field : undefined
}

const booleanField = (value: Schema.Json | undefined, key: string): boolean | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return Predicate.isBoolean(field) ? field : undefined
}

const arrayField = (
  value: Schema.Json | undefined,
  key: string
): ReadonlyArray<Schema.Json> | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return Array.isArray(field) ? field : undefined
}

// The same credential field names the conformance secret scan flags, plus `credential(s)`.
const credentialKeyPattern =
  /^(?:credentials?|(?:access|refresh|id|auth|api|session|private|bearer|oauth)[_-]?token|token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|password|passwd|api[_-]?key|authorization)$/i

/** A copy without credential fields; `ignoreConnectionHost` applies the request-shape latitude. */
const scrub = (value: Schema.Json, ignoreConnectionHost: boolean): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(item => scrub(item, ignoreConnectionHost))
  }

  if (!isJsonObject(value)) {
    return value
  }

  const copy: Record<string, Schema.Json> = {}

  for (const [key, item] of Object.entries(value)) {
    if (credentialKeyPattern.test(key)) {
      continue
    }

    if (ignoreConnectionHost && key === 'connection' && isJsonObject(item)) {
      const { host: _host, ...connection } = item

      copy[key] = scrub(connection, ignoreConnectionHost)
      continue
    }

    copy[key] = scrub(item, ignoreConnectionHost)
  }

  return copy
}

/** Deep subset: objects by key, arrays element by element (same length), other values exactly. */
const containsSubset = (value: Schema.Json | undefined, pattern: Schema.Json): boolean => {
  if (value === undefined) {
    return false
  }

  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) &&
      value.length === pattern.length &&
      pattern.every((item, index) => containsSubset(value[index], item))
    )
  }

  if (isJsonObject(pattern)) {
    return (
      isJsonObject(value) &&
      Object.entries(pattern).every(([key, item]) => containsSubset(value[key], item))
    )
  }

  return Equal.equals(value, pattern)
}

// Mailbox state.

type MessageState = {
  id?: string
  uidl?: string
  subject?: string
  isRead?: boolean
  isFlagged?: boolean
}

type FolderState = {
  readonly name: string
  readonly specialUse?: EmailEmulatorSpecialUse
  messages: Array<MessageState>
}

type MailboxState = { readonly folders: Array<FolderState> }

const copyMessage = (message: EmailEmulatorMessage | MessageState): MessageState => {
  const copy: MessageState = {}

  if (message.id !== undefined) copy.id = message.id

  if (message.uidl !== undefined) copy.uidl = message.uidl

  if (message.subject !== undefined) copy.subject = message.subject

  if (message.isRead !== undefined) copy.isRead = message.isRead

  if (message.isFlagged !== undefined) copy.isFlagged = message.isFlagged

  return copy
}

const mailboxFrom = (seed: EmailEmulatorSeed): MailboxState => ({
  folders: seed.folders.map(folder =>
    folder.specialUse === undefined
      ? { name: folder.name, messages: folder.messages.map(copyMessage) }
      : {
          name: folder.name,
          specialUse: folder.specialUse,
          messages: folder.messages.map(copyMessage)
        }
  )
})

const snapshotOf = (state: MailboxState): EmailEmulatorSeed => ({
  folders: state.folders.map(folder =>
    folder.specialUse === undefined
      ? { name: folder.name, messages: folder.messages.map(copyMessage) }
      : {
          name: folder.name,
          specialUse: folder.specialUse,
          messages: folder.messages.map(copyMessage)
        }
  )
})

const folderNamed = (state: MailboxState, name: string | undefined): FolderState | undefined =>
  name === undefined ? undefined : state.folders.find(folder => folder.name === name)

const specialUseFolder = (
  state: MailboxState,
  use: EmailEmulatorSpecialUse
): FolderState | undefined => state.folders.find(folder => folder.specialUse === use)

const isPop3 = (request: JsonObject): boolean =>
  stringField(objectField(request, 'connection'), 'protocol') === 'pop3'

const messageIn = (
  folder: FolderState | undefined,
  id: string | undefined,
  pop3 = false
): MessageState | undefined =>
  folder === undefined || id === undefined
    ? undefined
    : folder.messages.find(message => (pop3 ? message.uidl : message.id) === id)

const flagKeys = ['isRead', 'isFlagged'] as const

/** Reported flags and subject agree with what the mailbox knows (unknown state agrees). */
const agrees = (message: MessageState, reported: Schema.Json | undefined): boolean => {
  const subject = stringField(reported, 'subject')

  return (
    flagKeys.every(key => {
      const value = booleanField(reported, key)

      return value === undefined || message[key] === undefined || message[key] === value
    }) &&
    (subject === undefined || message.subject === undefined || message.subject === subject)
  )
}

/** Remember flags and subject the mailbox did not know yet. */
const learn = (message: MessageState, reported: Schema.Json | undefined): void => {
  for (const key of flagKeys) {
    const value = booleanField(reported, key)

    if (message[key] === undefined && value !== undefined) {
      message[key] = value
    }
  }

  const subject = stringField(reported, 'subject')

  if (message.subject === undefined && subject !== undefined) {
    message.subject = subject
  }
}

/** A state model for one method: whether a fixture is consistent, and what it changes. */
type MethodModel = {
  readonly consistent: (
    state: MailboxState,
    request: JsonObject,
    fixture: EmailEmulatorFixture
  ) => boolean
  readonly apply: (state: MailboxState, request: JsonObject, fixture: EmailEmulatorFixture) => void
}

const requestFolder = (state: MailboxState, request: JsonObject) =>
  folderNamed(state, stringField(request, 'folder') ?? 'INBOX')

/** Every known message that certainly passes the request's read/flagged filters. */
const certainlyListed = (message: MessageState, request: JsonObject): boolean =>
  flagKeys.every(key => {
    const filter = booleanField(request, key)

    return filter === undefined || message[key] === filter
  })

const listModel: MethodModel = {
  consistent: (state, request, fixture) => {
    if (fixture.failure !== undefined) {
      return true
    }

    const folder = requestFolder(state, request)
    const listed = arrayField(fixture.response, 'messages')
    const pop3 = isPop3(request)

    if (folder === undefined || listed === undefined) {
      return false
    }

    const everyListedKnown = listed.every(summary => {
      const message = messageIn(folder, stringField(summary, 'id'), pop3)

      return message !== undefined && agrees(message, summary)
    })

    if (!everyListedKnown) {
      return false
    }

    if (stringField(fixture.response, 'nextCursor') !== undefined) {
      return true
    }

    const listedIds = new Set(listed.map(summary => stringField(summary, 'id')))

    return folder.messages.every(message => {
      const id = pop3 ? message.uidl : message.id

      return id === undefined || !certainlyListed(message, request) || listedIds.has(id)
    })
  },
  apply: (state, request, fixture) => {
    const folder = requestFolder(state, request)
    const pop3 = isPop3(request)

    for (const summary of arrayField(fixture.response, 'messages') ?? []) {
      const message = messageIn(folder, stringField(summary, 'id'), pop3)

      if (message !== undefined) {
        learn(message, summary)
      }
    }
  }
}

const getModel: MethodModel = {
  consistent: (state, request, fixture) => {
    const id = stringField(request, 'messageId')
    const message = messageIn(requestFolder(state, request), id, isPop3(request))

    if (fixture.failure !== undefined) {
      // A failed get is consistent only where the mailbox has no such message.
      return message === undefined
    }

    const reported = objectField(fixture.response, 'message')

    return message !== undefined && stringField(reported, 'id') === id && agrees(message, reported)
  },
  apply: (state, request, fixture) => {
    const message = messageIn(
      requestFolder(state, request),
      stringField(request, 'messageId'),
      isPop3(request)
    )

    if (message !== undefined && fixture.failure === undefined) {
      learn(message, objectField(fixture.response, 'message'))
    }
  }
}

const flagModel = (key: 'isRead' | 'isFlagged'): MethodModel => ({
  consistent: (state, request, fixture) => {
    if (fixture.failure !== undefined) {
      return true
    }

    const id = stringField(request, 'messageId')

    return (
      messageIn(requestFolder(state, request), id) !== undefined &&
      stringField(fixture.response, 'messageId') === id &&
      booleanField(fixture.response, key) === booleanField(request, key)
    )
  },
  apply: (state, request, fixture) => {
    const message = messageIn(requestFolder(state, request), stringField(request, 'messageId'))
    const value = booleanField(request, key)

    if (fixture.failure === undefined && message !== undefined && value !== undefined) {
      message[key] = value
    }
  }
})

/** A move-shaped method: where the message comes from and which destination is acceptable. */
const moveModel = (
  source: (state: MailboxState, request: JsonObject) => FolderState | undefined,
  destinationAllowed: (
    state: MailboxState,
    request: JsonObject,
    destination: FolderState
  ) => boolean
): MethodModel => {
  const plan = (state: MailboxState, request: JsonObject, fixture: EmailEmulatorFixture) => {
    const from = source(state, request)
    const message = messageIn(from, stringField(request, 'messageId'))
    const destination = folderNamed(state, stringField(fixture.response, 'folder'))
    const movedId = stringField(fixture.response, 'messageId')

    return { from, message, destination, movedId }
  }

  return {
    consistent: (state, request, fixture) => {
      if (fixture.failure !== undefined) {
        return true
      }

      const { from, message, destination, movedId } = plan(state, request, fixture)

      return (
        booleanField(fixture.response, 'moved') === true &&
        from !== undefined &&
        message !== undefined &&
        destination !== undefined &&
        destination !== from &&
        destinationAllowed(state, request, destination) &&
        messageIn(destination, movedId) === undefined
      )
    },
    apply: (state, request, fixture) => {
      if (fixture.failure !== undefined) {
        return
      }

      const { from, message, destination, movedId } = plan(state, request, fixture)

      if (from === undefined || message === undefined || destination === undefined) {
        return
      }

      from.messages = from.messages.filter(candidate => candidate !== message)

      const moved: MessageState = { ...message }

      delete moved.uidl

      if (movedId === undefined) {
        delete moved.id
      } else {
        moved.id = movedId
      }

      destination.messages.push(moved)
    }
  }
}

const createDraftModel: MethodModel = {
  consistent: (state, request, fixture) => {
    if (fixture.failure !== undefined) {
      return true
    }

    const destination = folderNamed(state, stringField(fixture.response, 'folder'))
    const requested = stringField(request, 'folder')

    return (
      booleanField(fixture.response, 'saved') === true &&
      destination !== undefined &&
      (requested === undefined
        ? destination.specialUse === '\\Drafts'
        : destination.name === requested) &&
      messageIn(destination, stringField(fixture.response, 'draftId')) === undefined
    )
  },
  apply: (state, request, fixture) => {
    const destination = folderNamed(state, stringField(fixture.response, 'folder'))

    if (fixture.failure !== undefined || destination === undefined) {
      return
    }

    const draft: MessageState = {}
    const draftId = stringField(fixture.response, 'draftId')
    const subject = stringField(objectField(request, 'message'), 'subject')

    if (draftId !== undefined) draft.id = draftId

    if (subject !== undefined) draft.subject = subject

    destination.messages.push(draft)
  }
}

const deletePermanentlyModel: MethodModel = {
  consistent: (state, request, fixture) => {
    if (fixture.failure !== undefined) {
      return true
    }

    const folder = requestFolder(state, request)
    const results = arrayField(fixture.response, 'results')

    return (
      folder !== undefined &&
      results !== undefined &&
      results.every(result => {
        const present = messageIn(folder, stringField(result, 'messageId')) !== undefined
        const status = stringField(result, 'status')

        return status === 'succeeded'
          ? present
          : status !== 'failed' || stringField(result, 'code') !== 'not_found' || !present
      })
    )
  },
  apply: (state, request, fixture) => {
    const folder = requestFolder(state, request)

    if (fixture.failure !== undefined || folder === undefined) {
      return
    }

    const deleted = new Set(
      (arrayField(fixture.response, 'results') ?? []).flatMap(result =>
        stringField(result, 'status') === 'succeeded' ? [stringField(result, 'messageId')] : []
      )
    )

    folder.messages = folder.messages.filter(
      message => message.id === undefined || !deleted.has(message.id)
    )
  }
}

/** The mailbox a saved Sent copy lands in, or `undefined` when none is consistent. */
const savedCopyFolder = (
  state: MailboxState,
  request: JsonObject,
  fixture: EmailEmulatorFixture
): FolderState | undefined => {
  const requestedCopy = objectField(request, 'sentCopy')

  if (requestedCopy === undefined) {
    return undefined
  }

  const requestedFolder = stringField(requestedCopy, 'folder')
  const reportedFolder = stringField(objectField(fixture.response, 'sentCopy'), 'folder')

  const folder =
    requestedFolder === undefined
      ? reportedFolder === undefined
        ? specialUseFolder(state, '\\Sent')
        : folderNamed(state, reportedFolder)
      : folderNamed(state, requestedFolder)

  if (folder === undefined || (reportedFolder !== undefined && reportedFolder !== folder.name)) {
    return undefined
  }

  return requestedFolder !== undefined || folder.specialUse === '\\Sent' ? folder : undefined
}

const sentCopyStatus = (fixture: EmailEmulatorFixture) =>
  stringField(objectField(fixture.response, 'sentCopy'), 'status')

const sendMessageModel: MethodModel = {
  consistent: (state, request, fixture) => {
    if (fixture.failure !== undefined) {
      return true
    }

    const status = sentCopyStatus(fixture)
    const requestedCopy = objectField(request, 'sentCopy')
    const requestedFolder = stringField(requestedCopy, 'folder')

    // A failed copy needs a requested copy; when the request names a folder, that folder must be
    // missing from the mailbox (the only failure the fixtures record).
    const failedConsistent =
      requestedCopy !== undefined &&
      (requestedFolder === undefined || folderNamed(state, requestedFolder) === undefined)

    return (
      booleanField(fixture.response, 'accepted') === true &&
      (status === 'saved'
        ? savedCopyFolder(state, request, fixture) !== undefined
        : status !== 'failed' || failedConsistent)
    )
  },
  apply: (state, request, fixture) => {
    if (fixture.failure !== undefined || sentCopyStatus(fixture) !== 'saved') {
      return
    }

    const folder = savedCopyFolder(state, request, fixture)
    const subject = stringField(objectField(request, 'message'), 'subject')

    folder?.messages.push(subject === undefined ? {} : { subject })
  }
}

const routeKey = (method: string) =>
  emulatorRouteKey(emailEmulatorRouteMethod, `${emailEmulatorPort}.${method}`)

const methodModels: ReadonlyMap<string, MethodModel> = new Map([
  [routeKey('listMessages'), listModel],
  [routeKey('listMessagesFiltered'), listModel],
  [routeKey('getMessage'), getModel],
  [routeKey('createDraft'), createDraftModel],
  [routeKey('sendMessage'), sendMessageModel],
  [routeKey('setRead'), flagModel('isRead')],
  [routeKey('setFlag'), flagModel('isFlagged')],
  [
    routeKey('trash'),
    moveModel(
      (state, request) => requestFolder(state, request),
      (_state, request, destination) => {
        const trashFolder = stringField(request, 'trashFolder')

        return trashFolder === undefined
          ? destination.specialUse === '\\Trash'
          : destination.name === trashFolder
      }
    )
  ],
  [
    routeKey('untrash'),
    moveModel(
      (state, request) => {
        const folder = stringField(request, 'folder')

        return folder === undefined
          ? specialUseFolder(state, '\\Trash')
          : folderNamed(state, folder)
      },
      (_state, request, destination) =>
        destination.name === stringField(request, 'destinationFolder')
    )
  ],
  [
    routeKey('move'),
    moveModel(
      (state, request) => requestFolder(state, request),
      (_state, request, destination) =>
        destination.name === stringField(request, 'destinationFolder')
    )
  ],
  [routeKey('deletePermanently'), deletePermanentlyModel]
])

const strict = { onExcessProperty: 'error' } as const

const decodeSeed = Schema.decodeUnknownResult(EmailEmulatorSeed, strict)

const decodeFault = Schema.decodeUnknownResult(EmailEmulatorFault, strict)

const issueText = (error: Schema.SchemaError): string => error.message

/** Folder names and message ids (and POP3 ids) must be unique so fixtures address one message. */
const seedProblem = (seed: EmailEmulatorSeed): string | undefined => {
  const names = seed.folders.map(folder => folder.name)

  if (new Set(names).size !== names.length) {
    return 'folder names must be unique'
  }

  for (const folder of seed.folders) {
    const ids = folder.messages.flatMap(message => (message.id === undefined ? [] : [message.id]))

    const uidls = folder.messages.flatMap(message =>
      message.uidl === undefined ? [] : [message.uidl]
    )

    if (new Set(ids).size !== ids.length || new Set(uidls).size !== uidls.length) {
      return `message ids in ${folder.name} must be unique`
    }
  }

  return undefined
}

/**
 * Create an email emulator. Each call has its own mailbox, ledger, faults, and fixture use.
 *
 * `call(method, request)` answers in this order: an unknown method or a non-object request fails
 * closed; the first active matching fault answers its failure; otherwise the fixtures whose method
 * and request match (after the request-shape latitude) are checked against the mailbox, and the
 * first consistent one (preferring one not used since the last reset) answers and updates the
 * mailbox; no match (`no-matching-fixture`) or no consistent match (`state-conflict`) fails closed.
 * Every call is written to the ledger without credential fields.
 *
 * Throws `EmailEmulatorInputInvalid` for an invalid seed.
 */
export const makeEmailEmulator = (options: EmailEmulatorOptions = {}): EmailEmulator => {
  const seedResult = decodeSeed(options.seed ?? emailEmulatorDefaultSeed)

  if (Result.isFailure(seedResult)) {
    throw new EmailEmulatorInputInvalid({ input: 'seed', reason: issueText(seedResult.failure) })
  }

  const seed = seedResult.success
  const problem = seedProblem(seed)

  if (problem !== undefined) {
    throw new EmailEmulatorInputInvalid({ input: 'seed', reason: problem })
  }

  const bound = new Map(
    bindRouteHandlers(emailEmulatorRoutes, methodModels).map(({ route, handler }) => [
      route.path.slice(emailEmulatorPort.length + 1),
      { route, model: handler }
    ])
  )

  let state = mailboxFrom(seed)
  let entries: Array<EmailEmulatorLedgerEntry> = []

  let faults: Array<{
    id: number
    fault: EmailEmulatorFault
    remaining: number | undefined
    applied: number
  }> = []

  let nextFaultId = 1
  let nextSeq = 1
  const used = new Set<string>()

  const record = (entry: Omit<EmailEmulatorLedgerEntry, 'seq'>) => {
    entries.push({ seq: nextSeq, ...entry })
    nextSeq += 1
  }

  const refuse = (
    method: string,
    request: Schema.Json,
    reason: EmailEmulatorNotEmulatedReason,
    evidence: EmailEmulatorLedgerEntry['evidence']
  ): EmailEmulatorReply => {
    record({ method, request, outcome: 'not-emulated', evidence, reason })

    return { notEmulated: { reason: notEmulatedText[reason] } }
  }

  const call = (method: string, rawRequest: Schema.Json): EmailEmulatorReply => {
    const request = scrub(rawRequest, false)
    const target = bound.get(method)

    if (target === undefined) {
      return refuse(method, request, 'unknown-method', 'unknown-method')
    }

    const evidence = target.route.evidence

    if (!isJsonObject(request)) {
      return refuse(method, request, 'invalid-request', evidence)
    }

    const comparable = scrub(request, true)

    const matching = emailEmulatorFixtures.filter(
      fixture =>
        fixture.port === emailEmulatorPort &&
        fixture.method === method &&
        Equal.equals(scrub(fixture.request, true), comparable)
    )

    if (matching.length === 0) {
      return refuse(method, request, 'no-matching-fixture', evidence)
    }

    const consistent = matching.filter(fixture => target.model.consistent(state, request, fixture))
    const chosen = consistent.find(fixture => !used.has(fixture.id)) ?? consistent[0]

    if (chosen === undefined) {
      return refuse(method, request, 'state-conflict', evidence)
    }

    // Faults apply only to a call a fixture would answer: an unmatched or state-conflicting call
    // stays refused above and leaves every fault untouched. A fault changes no mailbox state.
    const fault = faults.find(
      candidate =>
        candidate.fault.method === method &&
        (candidate.remaining === undefined || candidate.remaining > 0) &&
        (candidate.fault.match === undefined || containsSubset(request, candidate.fault.match))
    )

    if (fault !== undefined) {
      fault.applied += 1

      if (fault.remaining !== undefined) {
        fault.remaining -= 1
      }

      record({ method, request, outcome: 'fault', evidence, faultId: fault.id })

      return { failure: fault.fault.failure }
    }

    target.model.apply(state, request, chosen)
    used.add(chosen.id)
    record({ method, request, outcome: 'answered', evidence, fixtureId: chosen.id })

    return chosen.failure === undefined
      ? { response: chosen.response }
      : { failure: chosen.failure }
  }

  const faultState = (fault: (typeof faults)[number]): EmailEmulatorFaultState => ({
    id: fault.id,
    fault: fault.fault,
    remaining: fault.remaining,
    applied: fault.applied
  })

  return {
    call,
    state: () => snapshotOf(state),
    seed: () => snapshotOf(mailboxFrom(seed)),
    ledger: {
      entries: () => entries.map(entry => ({ ...entry })),
      clear: () => {
        entries = []
      }
    },
    reset: () => {
      state = mailboxFrom(seed)
      entries = []
      faults = []
      used.clear()
    },
    faults: {
      add: input => {
        const decoded = decodeFault(input)

        if (Result.isFailure(decoded)) {
          throw new EmailEmulatorInputInvalid({
            input: 'fault',
            reason: issueText(decoded.failure)
          })
        }

        if (!bound.has(decoded.success.method)) {
          throw new EmailEmulatorInputInvalid({
            input: 'fault',
            reason: `method ${decoded.success.method} has no emulated route`
          })
        }

        const added = {
          id: nextFaultId,
          fault: decoded.success,
          remaining: decoded.success.count,
          applied: 0
        }

        nextFaultId += 1
        faults.push(added)

        return faultState(added)
      },
      list: () => faults.map(faultState),
      clear: () => {
        faults = []
      }
    },
    coverage: () => ({
      routes: emailEmulatorRoutes.map(route => ({
        ...route,
        calls: entries.filter(entry => `${emailEmulatorPort}.${entry.method}` === route.path).length
      })),
      notEmulatedCalls: entries.filter(entry => entry.outcome === 'not-emulated').length,
      unusedFixtureIds: emailEmulatorFixtures.flatMap(fixture =>
        used.has(fixture.id) ? [] : [fixture.id]
      )
    })
  }
}
