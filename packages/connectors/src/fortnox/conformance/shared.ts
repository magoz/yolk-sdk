/**
 * Shared pieces of the Fortnox conformance cases (internal; `cases.ts` and `read-cases.ts` build
 * on them and `index.ts` re-exports the public ones): the host-supplied seeds and their service,
 * the integration every case invokes, the case error types, and small helpers.
 */
import { Context, Data, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ConformanceMismatch, type ConformanceCase } from '@yolk-sdk/conformance/case'
import type { ConnectorBinaryHttpClient } from '../../binary-http.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import type { ConnectorFileTransferError } from '../../file-transfer.ts'
import type { ConnectorHttpClient } from '../../http.ts'
import { makeIntegration } from '../../integration.ts'
import type { ActionResult } from '../../result.ts'
import { fortnoxConnectorId, fortnoxOAuthSlotId } from '../oauth.ts'
import { FortnoxCustomerNumber, FortnoxDocumentNumber } from '../schemas.ts'

/**
 * Host-supplied seed identities in the practice company. Cases never hard-code account data. A
 * case whose seed is missing fails with a `precondition:` `ConformanceMismatch` before any
 * request.
 */
export const FortnoxConformanceSeeds = Schema.Struct({
  /** Unbooked invoice with at least one row; its rows are changed and then restored. */
  discountInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /** Any invoice whose generated PDF preview can be downloaded. */
  previewInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /** Customer with a non-empty `Comments` value; it is changed and then restored. */
  customerNumber: Schema.optionalKey(FortnoxCustomerNumber),
  /** A customer number that does NOT exist in the practice company. */
  missingCustomerNumber: Schema.optionalKey(FortnoxCustomerNumber),
  /** Invoice to send by email (irreversible; manual runs only). */
  emailInvoiceDocumentNumber: Schema.optionalKey(FortnoxDocumentNumber),
  /**
   * The only address the email case may send to. The case aborts before sending unless the email
   * invoice's `EmailInformation.EmailAddressTo` equals it exactly (and no copy address is set).
   */
  emailRecipient: Schema.optionalKey(
    Schema.Trimmed.check(Schema.isPattern(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u))
  )
})

export type FortnoxConformanceSeeds = typeof FortnoxConformanceSeeds.Type

export type FortnoxConformanceSeedKey = keyof FortnoxConformanceSeeds

/** Host-supplied seed identities for the Fortnox conformance cases. */
export class FortnoxConformanceConfig extends Context.Service<
  FortnoxConformanceConfig,
  FortnoxConformanceSeeds
>()('@yolk-sdk/connectors/fortnox/conformance/FortnoxConformanceConfig') {}

/**
 * Credential reference the cases bind to the `fortnox.oauth` slot. A host `CredentialResolver`
 * (for example `staticCredentialResolverLayer` from `@yolk-sdk/connectors/conformance`) resolves
 * it to a Fortnox `OAuthCredential`.
 */
export const fortnoxConformanceCredentialRef = 'fortnox.conformance'

/** The integration every Fortnox conformance case invokes the connector with. */
export const fortnoxConformanceIntegration = makeIntegration({
  connectorId: fortnoxConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: fortnoxOAuthSlotId,
      credentialRef: fortnoxConformanceCredentialRef
    })
  ]
})

/** A connector action returned an `ActionResult` failure where the case needed success. */
export class FortnoxConformanceActionFailed extends Data.TaggedError(
  'FortnoxConformanceActionFailed'
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

const restoreByHandAdvice =
  'restore the account by hand if it still differs from its original state.'

/** `text` ending in a period (a truncated `...` summary already does). */
const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`)

/**
 * Restoring the practice account after a write case failed. `caseOutcome` says whether the claim
 * itself held before restoring; `claimFailure` is a sanitized summary of why it failed. The account
 * may or may not still differ from its original state (for example, nothing changed when the first
 * write was rejected): check it, and restore it by hand only if it differs.
 */
export class FortnoxConformanceRestoreFailed extends Data.TaggedError(
  'FortnoxConformanceRestoreFailed'
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
    // always survives, and each summary is capped at `failureSummaryLength`, so the whole message
    // fits even for the longest case id.
    return `${this.caseId}: restore failed; ${restoreByHandAdvice} Restore error: ${sentence(this.reason)} ${claim}`
  }
}

export type FortnoxConformanceError =
  | ConformanceMismatch
  | ConnectorError
  | ConnectorFileTransferError
  | FortnoxConformanceActionFailed
  | FortnoxConformanceRestoreFailed

/** What every Fortnox conformance case requires from the host. */
export type FortnoxConformanceRequirements =
  | ConnectorHttpClient
  | ConnectorBinaryHttpClient
  | CredentialResolver
  | FortnoxConformanceConfig

export type FortnoxConformanceCase = ConformanceCase<
  FortnoxConformanceError,
  FortnoxConformanceRequirements
>

/** Trusted budget for the preview and file downloads (generous for a generated PDF). */
export const downloadBudget = {
  maxBytes: 20 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxErrorBodyBytes: 64 * 1024
}

export const requireSeed = <K extends FortnoxConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* FortnoxConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: FortnoxConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

export const successValue = <A>(
  actionId: string,
  result: ActionResult<A>
): Effect.Effect<A, FortnoxConformanceActionFailed> => {
  if (Predicate.isTagged(result, 'Success')) {
    return Effect.succeed(result.value)
  }

  const { code, status } = result.error

  return Effect.fail(
    status === undefined
      ? new FortnoxConformanceActionFailed({ actionId, code })
      : new FortnoxConformanceActionFailed({ actionId, code, status })
  )
}

export const isPdfStart = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'

export const hasPdfTrailer = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).includes('%%EOF')
