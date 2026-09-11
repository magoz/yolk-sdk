import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ConnectorIntegration } from '../integration.ts'
import type { ConnectorFileTransferBudget } from '../file-transfer.ts'
import {
  SafeText,
  decodeInput,
  failTransfer,
  fileBytes,
  readBytes,
  safeHttpsUrl,
  validateTransfer
} from '../transfer-internal.ts'

export type NotionDownloadFile =
  | {
      readonly type: 'file'
      readonly file: { readonly url: string; readonly expiry_time?: string }
    }
  | { readonly type: 'external'; readonly external: { readonly url: string } }
/** Trusted host policy; not model parameters. Apply destination allowlists here and enforce DNS/socket policy in the transport. */
export interface NotionFileDownloadPolicy {
  readonly allowHostedUrl: (url: URL) => boolean
  /** External attachments are denied unless explicitly authorized by host policy. */
  readonly allowExternalUrl?: (url: URL) => boolean
}
const File = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('file'),
    file: Schema.Struct({ url: SafeText, expiry_time: Schema.optional(SafeText) })
  }),
  Schema.Struct({ type: Schema.Literal('external'), external: Schema.Struct({ url: SafeText }) })
])
/** Read provider file objects from pages/properties/blocks. No Notion bearer token ever reaches download origins. Refresh expired URLs by rereading the owning object. file_upload IDs are not download URLs. */
export const downloadNotionFile = (
  integration: ConnectorIntegration,
  input: NotionDownloadFile,
  budget: ConnectorFileTransferBudget,
  policy: NotionFileDownloadPolicy
) =>
  Effect.gen(function* () {
    const limits = yield* validateTransfer(integration, 'notion', budget)
    const file = yield* decodeInput(File, input)
    const url = yield* safeHttpsUrl(file.type === 'file' ? file.file.url : file.external.url)
    if (
      policy === null ||
      typeof policy !== 'object' ||
      typeof policy.allowHostedUrl !== 'function'
    )
      return yield* failTransfer('invalid_input')
    const allowed =
      file.type === 'file' ? policy.allowHostedUrl(url) : policy.allowExternalUrl?.(url) === true
    if (!allowed) return yield* failTransfer('network_policy_rejected')
    const response = yield* readBytes(url.href, {}, limits)
    return fileBytes(response.bytes)
  })
