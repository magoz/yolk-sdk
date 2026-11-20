/**
 * Shared pieces of the Microsoft Graph conformance cases (internal; `cases.ts` and
 * `teams-sharepoint-cases.ts` build on them, `cases.ts` re-exports the public ones): the
 * host-supplied seeds and their service, the integration every case invokes, the case error types,
 * and small helpers.
 */
import { Context, Data, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ConformanceMismatch, type ConformanceCase } from '@yolk-sdk/conformance/case'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type { ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult } from '../../result.ts'
import { microsoftConnectorId, microsoftOAuthSlotId } from '../oauth.ts'
import { isoUtcInstantPattern } from './calendar.ts'

const SeedString = Schema.Trimmed.check(Schema.isNonEmpty())

const IsoUtcInstant = Schema.String.check(Schema.isPattern(isoUtcInstantPattern))

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seed identities in the practice tenant. Cases never hard-code account data. A case
 * whose required seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const MicrosoftConformanceSeeds = Schema.Struct({
  /**
   * Mailbox (user principal name or id) for the Outlook and calendar cases, sent as
   * `/users/{mailbox}`; absent means the signed-in user (`/me`). When it equals the credential's
   * `accountId`, the connector keeps ordinary (non-Shared) Outlook scopes.
   */
  mailbox: Schema.optionalKey(SeedString),
  /** Calendar for the calendar cases; absent means the default calendar. */
  calendarId: Schema.optionalKey(SeedString),
  /** Start of a range with known events (ISO-8601 UTC, for example `2026-09-21T00:00:00Z`). */
  calendarRangeStart: Schema.optionalKey(IsoUtcInstant),
  /** End (exclusive) of that range. */
  calendarRangeEnd: Schema.optionalKey(IsoUtcInstant),
  /** A known event inside the range, among the first 50 events of the range. */
  calendarEventId: Schema.optionalKey(SeedString),
  /** That event's known start instant (ISO-8601 UTC, at most millisecond precision). */
  calendarEventStart: Schema.optionalKey(IsoUtcInstant),
  /** A message with at least one inline and one regular (non-inline) file attachment. */
  attachmentMessageId: Schema.optionalKey(SeedString),
  /** A mail folder holding more than two messages. */
  pagingFolderId: Schema.optionalKey(SeedString),
  /** Drive for the OneDrive cases (`/drives/{driveId}`); absent means `/me/drive`. Copy needs it. */
  driveId: Schema.optionalKey(SeedString),
  /** A concrete folder id (not `root`) the OneDrive cases create their own folders under. */
  driveParentItemId: Schema.optionalKey(SeedString),
  /** A small file the copy case copies into its own folder. */
  copySourceItemId: Schema.optionalKey(SeedString),
  /** A keyword `sharepoint.search_sites` finds the seeded site with (on its first page of 50). */
  siteSearchQuery: Schema.optionalKey(SeedString),
  /** A SharePoint team site (`{hostname},{site-collection-id},{web-id}`) with a document library. */
  siteId: Schema.optionalKey(SeedString),
  /** A Teams chat of the signed-in user holding more than two messages (never written to). */
  chatId: Schema.optionalKey(SeedString),
  /**
   * A dedicated practice Teams chat of the signed-in user, kept apart from `chatId`: the
   * write-irreversible send case posts a real message there, so the paging chat stays unchanged.
   */
  sendChatId: Schema.optionalKey(SeedString),
  /** A team the signed-in user joined (listed by `teams.list_joined_teams`). */
  teamId: Schema.optionalKey(SeedString),
  /** A channel of that team listed on the first page of `teams.list_channels`. */
  channelId: Schema.optionalKey(SeedString),
  /** A top-level post of that channel with at least one reply. */
  channelMessageId: Schema.optionalKey(SeedString),
  /**
   * The `https://teams.microsoft.com` join link of a transcribed meeting the signed-in user
   * organized or attended (passed exactly as received).
   */
  meetingJoinWebUrl: Schema.optionalKey(SeedString),
  /**
   * Invocation-unique segment of the send case's message text. Replay uses the fixed synthetic id
   * of the fixtures; the live runner generates a fresh random one per invocation.
   */
  runId: Schema.optionalKey(RunId)
})

export type MicrosoftConformanceSeeds = typeof MicrosoftConformanceSeeds.Type

export type MicrosoftConformanceSeedKey = keyof MicrosoftConformanceSeeds

/** Host-supplied seed identities for the Microsoft conformance cases. */
export class MicrosoftConformanceConfig extends Context.Service<
  MicrosoftConformanceConfig,
  MicrosoftConformanceSeeds
>()('@yolk-sdk/connectors/microsoft/conformance/MicrosoftConformanceConfig') {}

/**
 * Credential reference the cases bind to the `microsoft.oauth` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Microsoft `OAuthCredential`.
 */
export const microsoftConformanceCredentialRef = 'microsoft.conformance'

/** The integration every Microsoft conformance case invokes the connector with. */
export const microsoftConformanceIntegration = makeIntegration({
  connectorId: microsoftConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: microsoftOAuthSlotId,
      credentialRef: microsoftConformanceCredentialRef
    })
  ]
})

/** Synthetic marker every case-created item carries in its subject, name, or text. */
export const microsoftConformanceMarker = 'yolk-conformance'

const restoreByHandAdvice =
  'remove the case-created item by hand if it still exists (subjects and names start with yolk-conformance).'

/**
 * A connector action (or raw calendar request) returned a failure where the case needed success.
 *
 * `createOutcome: 'unknown'` marks an ambiguous create of a write case's own item (see
 * `classifyWriteExit`: a transport or decoding failure, no status, HTTP 408, or HTTP 5xx): Graph
 * may have created the item without the case learning its id, so the message adds the
 * manual-recovery advice. `sendOutcome: 'unknown'` marks an ambiguous Teams send the same way: the
 * message may have been posted, so the advice names the run id to look for in the chat (a posted
 * message cannot be removed through the connector). `code` and `status` keep the underlying
 * classification (the `ConnectorError` cause, such as `transport_failed` or `validation_failed`,
 * for a failed action).
 */
export class MicrosoftConformanceActionFailed extends Data.TaggedError(
  'MicrosoftConformanceActionFailed'
)<{
  readonly actionId: string
  readonly code: string
  readonly status?: number
  readonly createOutcome?: 'unknown'
  readonly sendOutcome?: 'unknown'
  /** The run id the sent text names; set together with `sendOutcome`. */
  readonly runId?: string
}> {
  override get message(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`

    const advice =
      this.createOutcome === 'unknown'
        ? `; the item may exist anyway: ${restoreByHandAdvice}`
        : this.sendOutcome === 'unknown'
          ? `; the message may have been posted anyway: look for "${microsoftConformanceMarker} ${this.runId ?? 'run-'}" in the seeded chat (the connector cannot remove it).`
          : ''

    return `${this.actionId} failed: ${this.code}${status}${advice}`
  }
}

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Removing what a write case created failed, or a create succeeded without an id so nothing could
 * be removed automatically. `caseOutcome` says whether the claim itself held before the restore;
 * `claimFailure` is a sanitized summary of why it failed. The item may or may not still exist:
 * check it, and remove it by hand only if it does.
 */
export class MicrosoftConformanceRestoreFailed extends Data.TaggedError(
  'MicrosoftConformanceRestoreFailed'
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

    // Conformance reports cap failure messages at 300 characters: the advice comes first so it
    // always survives, and each summary is capped at `failureSummaryLength`.
    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type MicrosoftConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | MicrosoftConformanceActionFailed
  | MicrosoftConformanceRestoreFailed

/** What every Microsoft conformance case requires from the host. */
export type MicrosoftConformanceRequirements =
  | ConnectorHttpClient
  | CredentialResolver
  | MicrosoftConformanceConfig

export type MicrosoftConformanceCase = ConformanceCase<
  MicrosoftConformanceError,
  MicrosoftConformanceRequirements
>

/** A seed the case cannot run without, or a `precondition:` mismatch before any request. */
export const requireSeed = <K extends MicrosoftConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* MicrosoftConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: MicrosoftConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

export const optionalSeed = <K extends MicrosoftConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* MicrosoftConformanceConfig

    return seeds[key]
  })

/** The success value of an action result, or its failure as `MicrosoftConformanceActionFailed`. */
export const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, MicrosoftConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new MicrosoftConformanceActionFailed({ actionId, code })
      : new MicrosoftConformanceActionFailed({ actionId, code, status })
  )
}
