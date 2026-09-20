import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  OAuthCredential,
  makeCredentialBinding,
  makeIntegration,
  type ConnectorHttpRequest
} from '@yolk-sdk/connectors'
import { OutlookUpdateDraftInput, outlookUpdateDraftAction } from '@yolk-sdk/connectors/microsoft'

// Lone UTF-16 surrogates make encodeURIComponent throw URIError outside the
// typed failure channel. Build them at runtime so the source stays ASCII.
const loneHigh = String.fromCharCode(0xd800)

const loneLow = String.fromCharCode(0xdc00)

const smile = String.fromCodePoint(0x1f600)

const integration = makeIntegration({
  connectorId: 'microsoft',
  credentialBindings: [makeCredentialBinding({ slotId: 'microsoft.oauth', credentialRef: 'mail' })]
})

const makeHost = () => {
  const requests: ConnectorHttpRequest[] = []
  const scopes: Array<ReadonlyArray<string> | undefined> = []

  const layer = Layer.mergeAll(
    Layer.succeed(CredentialResolver, {
      resolve: request => {
        scopes.push(request.slot.requiredScopes)

        return Effect.succeed(
          OAuthCredential.make({
            provider: 'microsoft',
            accessToken: 'SECRET',
            expiresAt: 4e12,
            accountId: 'own@example.com'
          })
        )
      }
    }),
    Layer.succeed(ConnectorHttpClient, {
      request: request => {
        requests.push(request)

        return Effect.succeed(
          ConnectorHttpResponse.make({
            status: 200,
            headers: {},
            body: '{"id":"draft","isDraft":true}'
          })
        )
      }
    })
  )

  return { requests, scopes, layer }
}

describe('Outlook path identity Unicode boundary', () => {
  it.effect('revalidates all typed draft fields before credentials or HTTP', () =>
    Effect.gen(function* () {
      for (const edit of [
        { messageId: '' },
        { messageId: '..' },
        { messageId: 'bad\nidentity' },
        { mailbox: '' },
        { mailbox: '..' },
        { mailbox: 'bad\nidentity' },
        { mailbox: loneLow },
        { to: [''] },
        { cc: [''] },
        { bcc: [''] },
        { body: 123 },
        { contentType: 'invalid', body: 'Replacement' }
      ]) {
        const host = makeHost()
        const input = OutlookUpdateDraftInput.make({ messageId: 'draft', subject: 'Edited' })

        Object.assign(input, edit)

        const result = yield* outlookUpdateDraftAction
          .executeTyped({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toEqual([])
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('rejects lone surrogates in draft identities before credentials or HTTP', () =>
    Effect.gen(function* () {
      for (const input of [
        { messageId: `draft-${loneHigh}`, subject: 'Edited' },
        { messageId: `draft-${loneLow}`, subject: 'Edited' },
        { messageId: 'draft', mailbox: `box-${loneHigh}`, subject: 'Edited' },
        { messageId: 'draft', mailbox: `${loneLow}box`, subject: 'Edited' }
      ]) {
        const host = makeHost()

        const result = yield* outlookUpdateDraftAction
          .execute({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toEqual([])
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('also rejects lone surrogates through executeTyped before IO', () =>
    Effect.gen(function* () {
      // Plain objects fail executeTyped as InvalidType regardless of content, so
      // mutate typed fields on valid instances instead of spreading or casting.
      const edits: Array<(input: OutlookUpdateDraftInput) => void> = [
        input => {
          Object.assign(input, { messageId: `draft-${loneHigh}` })
        },
        input => {
          Object.assign(input, { messageId: `draft-${loneLow}` })
        },
        input => {
          Object.assign(input, { mailbox: `box-${loneHigh}` })
        }
      ]

      for (const edit of edits) {
        const host = makeHost()
        const input = OutlookUpdateDraftInput.make({ messageId: 'draft', subject: 'Edited' })
        edit(input)

        const result = yield* outlookUpdateDraftAction
          .executeTyped({ integration, input })
          .pipe(Effect.provide(host.layer), Effect.result)

        expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: 'validation_failed' } })
        expect(host.scopes).toEqual([])
        expect(host.requests).toHaveLength(0)
      }
    })
  )

  it.effect('keeps valid Unicode and slash-containing opaque IDs encodable', () =>
    Effect.gen(function* () {
      const host = makeHost()
      const messageId = `moving-${smile}/part?=caf\u00e9`

      const result = yield* outlookUpdateDraftAction
        .executeTyped({
          integration,
          input: OutlookUpdateDraftInput.make({
            messageId,
            subject: `Edited caf\u00e9 ${smile}`
          })
        })
        .pipe(Effect.provide(host.layer))

      expect(result).toMatchObject({ _tag: 'Success' })
      expect(host.requests).toHaveLength(1)
      expect(host.requests[0]?.url).toBe(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`
      )
    })
  )
})
