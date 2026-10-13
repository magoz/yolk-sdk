// Internal host-only Fortnox byte transfer core shared by archive, preview, and inbox helpers.
// Not re-exported from the `@yolk-sdk/connectors/fortnox` barrel.
import { Effect, Predicate } from 'effect'
import type { CredentialSlot } from '../credential.ts'
import { resolveCredential } from '../credential.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import type { ConnectorIntegration } from '../integration.ts'
import {
  credentialFailure,
  failTransfer,
  readBytes,
  safeToken,
  validateTransfer
} from '../transfer-internal.ts'
import { fortnoxApiBaseUrl } from './shared.ts'

/** Resolve a Fortnox OAuth access token for a byte transfer, failing with transfer codes only. */
export const resolveFortnoxTransferToken = (
  integration: ConnectorIntegration,
  slot: CredentialSlot
) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot).pipe(
      Effect.mapError(credentialFailure)
    )

    if (!Predicate.isTagged(credential, 'OAuthCredential') || credential.provider !== 'fortnox')
      return yield* failTransfer('credential_failed')

    return yield* safeToken(credential.accessToken)
  })

const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d

/**
 * One authenticated GET of `path` (already URL-encoded, relative to `fortnoxApiBaseUrl`) through
 * the binary port. `kind: 'pdf'` accepts any content type and verifies the PDF magic bytes instead,
 * since Fortnox may serve generated PDFs as `application/octet-stream` or with a charset suffix.
 */
export const downloadFortnoxBytes = (
  integration: ConnectorIntegration,
  slot: CredentialSlot,
  path: string,
  budget: ConnectorFileTransferBudget,
  kind: 'pdf' | 'binary'
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'fortnox', budget)
    const token = yield* resolveFortnoxTransferToken(integration, slot)

    const response = yield* readBytes(
      `${fortnoxApiBaseUrl}/${path}`,
      kind === 'pdf'
        ? { authorization: `Bearer ${token}` }
        : { authorization: `Bearer ${token}`, accept: 'application/octet-stream' },
      limits
    )

    if (kind === 'pdf' && !isPdf(response.bytes)) return yield* failTransfer('invalid_metadata')

    return response
  })
