import { Context, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { optionalStringConfig, requiredStringConfig } from '../config.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ActionResult } from '../result.ts'
import type { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const r2StorageConnectorId = 'r2-storage'
export const r2AccessKeyIdSlotId = 'r2-storage.access_key_id'
export const r2SecretAccessKeySlotId = 'r2-storage.secret_access_key'

export const R2AccessKeyIdSlot = CredentialSlot.make({ id: r2AccessKeyIdSlotId, kind: 'api_key' })
export const R2SecretAccessKeySlot = CredentialSlot.make({
  id: r2SecretAccessKeySlotId,
  kind: 'api_key'
})

export class R2PresignInput extends Schema.Class<R2PresignInput>('R2PresignInput')({
  endpoint: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  bucket: Schema.String,
  key: Schema.String,
  contentType: Schema.String
}) {}

export class R2PresignOutput extends Schema.Class<R2PresignOutput>('R2PresignOutput')({
  uploadUrl: Schema.String
}) {}

export type R2PresignerApi = {
  readonly presignPutObject: (input: R2PresignInput) => Effect.Effect<R2PresignOutput, ConnectorError>
}

export class R2Presigner extends Context.Service<R2Presigner, R2PresignerApi>()(
  '@yolk-sdk/connectors/R2Presigner'
) {}

const resolveApiToken = (integration: ConnectorIntegration, slot: CredentialSlot) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, slot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
    }
  })

const joinPublicUrl = (publicUrl: string, key: string) => {
  const base = publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl
  return `${base}/${key}`
}

const safeObjectKey = (filename: string) => {
  const trimmed = filename.trim().replace(/^\/+/, '')
  return trimmed === '' ? `uploads/${Date.now()}` : trimmed
}

export class R2UploadUrlInput extends Schema.Class<R2UploadUrlInput>('R2UploadUrlInput')({
  filename: Schema.String,
  contentType: Schema.String
}) {}

export class R2UploadUrlOutput extends Schema.Class<R2UploadUrlOutput>('R2UploadUrlOutput')({
  uploadUrl: Schema.String,
  publicUrl: Schema.optional(Schema.String),
  key: Schema.String
}) {}

export const r2StorageUploadUrlAction = defineAction({
  id: 'r2_storage.upload_url',
  description: 'Create a presigned R2 PUT upload URL.',
  inputSchema: R2UploadUrlInput,
  outputSchema: R2UploadUrlOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const endpoint = yield* requiredStringConfig(integration, 'endpoint')
      const bucket = yield* requiredStringConfig(integration, 'bucket')
      const publicUrl = optionalStringConfig(integration, 'publicUrl')
      const accessKeyId = yield* resolveApiToken(integration, R2AccessKeyIdSlot)
      const secretAccessKey = yield* resolveApiToken(integration, R2SecretAccessKeySlot)
      const presigner = yield* R2Presigner
      const key = safeObjectKey(input.filename)
      const presigned = yield* presigner.presignPutObject(
        R2PresignInput.make({
          endpoint,
          accessKeyId,
          secretAccessKey,
          bucket,
          key,
          contentType: input.contentType
        })
      )

      return ActionResult.success(
        R2UploadUrlOutput.make({
          uploadUrl: presigned.uploadUrl,
          publicUrl: publicUrl === undefined ? undefined : joinPublicUrl(publicUrl, key),
          key
        })
      )
    })
})

export const r2StorageActions = [r2StorageUploadUrlAction]

export const R2StorageConnector = defineConnector({
  id: r2StorageConnectorId,
  description: 'Cloudflare R2 storage connector actions.',
  actions: r2StorageActions
})
