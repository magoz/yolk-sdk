import { Effect, Layer, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { expectTypeOf } from 'vitest'
import {
  ActionResult,
  ConnectorBinaryHttpClient,
  CredentialResolver,
  OAuthCredential,
  defineAction,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorBinaryHttpResponse } from '@yolk-sdk/connectors'
import {
  FortnoxCustomerNumber,
  FortnoxDocumentNumber,
  FortnoxGivenNumber,
  FortnoxListSupplierInvoiceFilesInput,
  FortnoxSupplierInvoice,
  FortnoxSupplierInvoiceFile,
  FortnoxSupplierNumber,
  downloadFortnoxInvoicePreview,
  type fortnoxListSupplierInvoiceFilesAction
} from '@yolk-sdk/connectors/fortnox'
import { EmailDraftId, EmailFolderName } from '@yolk-sdk/connectors/email'
import { OpaqueId } from '../src/transfer-internal.ts'

const fortnoxIntegration = makeIntegration({
  connectorId: 'fortnox',
  credentialBindings: [
    makeCredentialBinding({ slotId: 'fortnox.oauth', credentialRef: 'host-fortnox-ref' })
  ]
})

const binaryResponse = (
  body: Uint8Array,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): ConnectorBinaryHttpResponse => ({ bytes: body, status, headers, bodyComplete: true })

const binaryHost = (responses: ReadonlyArray<ConnectorBinaryHttpResponse>) => {
  const requests: Array<{ readonly url: string }> = []

  return {
    requests,
    layer: Layer.mergeAll(
      Layer.succeed(
        CredentialResolver,
        CredentialResolver.of({
          resolve: () =>
            Effect.succeed(
              OAuthCredential.make({
                provider: 'fortnox',
                accessToken: 'test-access-token',
                expiresAt: 4_000_000_000_000
              })
            )
        })
      ),
      Layer.succeed(
        ConnectorBinaryHttpClient,
        ConnectorBinaryHttpClient.of({
          request: request => {
            requests.push({ url: request.url })
            const next = responses.at(requests.length - 1)

            return next === undefined
              ? Effect.die(new Error('Unexpected Fortnox binary request'))
              : Effect.succeed(next)
          }
        })
      )
    )
  }
}

describe('branded identities', () => {
  it('keeps Fortnox number brands nominally incompatible', () => {
    const given = FortnoxGivenNumber.make('42')
    const document = FortnoxDocumentNumber.make('12')
    const customer = FortnoxCustomerNumber.make('001')
    const supplier = FortnoxSupplierNumber.make('003')

    // Brands keep their string wire representation.
    const wire: string = given
    expect(wire).toBe('42')
    expect(document).toBe('12')

    const backToGiven: FortnoxGivenNumber = given
    expect(backToGiven).toBe('42')

    // @ts-expect-error - GivenNumber is not a DocumentNumber
    const mismatchDocument: FortnoxDocumentNumber = given
    // @ts-expect-error - DocumentNumber is not a GivenNumber
    const mismatchGiven: FortnoxGivenNumber = document
    // @ts-expect-error - CustomerNumber is not a SupplierNumber
    const mismatchSupplier: FortnoxSupplierNumber = customer
    // @ts-expect-error - SupplierNumber is not a CustomerNumber
    const mismatchCustomer: FortnoxCustomerNumber = supplier
    // @ts-expect-error - unbranded strings require decoding through the canonical schema
    const fromString: FortnoxGivenNumber = '42'

    expect([
      mismatchDocument,
      mismatchGiven,
      mismatchSupplier,
      mismatchCustomer,
      fromString
    ]).toHaveLength(5)
  })

  it('keeps email folder and draft brands nominally incompatible', () => {
    const folder = EmailFolderName.make('INBOX')
    const draft = EmailDraftId.make('imap:uid-validity-123:uid-456')

    const wire: string = folder
    expect(wire).toBe('INBOX')

    const backToFolder: EmailFolderName = folder
    expect(backToFolder).toBe('INBOX')

    // @ts-expect-error - EmailFolderName is not an EmailDraftId
    const mismatchDraft: EmailDraftId = folder
    // @ts-expect-error - EmailDraftId is not an EmailFolderName
    const mismatchFolder: EmailFolderName = draft
    // @ts-expect-error - unbranded strings require decoding through the canonical schema
    const fromString: EmailFolderName = 'INBOX'

    expect([mismatchDraft, mismatchFolder, fromString]).toHaveLength(3)
  })

  it('keeps Fortnox GivenNumber distinct from the supplier InvoiceNumber wire field', () => {
    const file = FortnoxSupplierInvoiceFile.make({
      fileId: OpaqueId.make('file-id'),
      name: 'invoice.pdf',
      givenNumber: FortnoxGivenNumber.make('42')
    })

    const given: FortnoxGivenNumber = file.givenNumber
    expect(given).toBe('42')

    // @ts-expect-error - file discovery carries the internal GivenNumber, not DocumentNumber
    const asDocument: FortnoxDocumentNumber = file.givenNumber

    const invoice = FortnoxSupplierInvoice.make({
      GivenNumber: FortnoxGivenNumber.make('42'),
      SupplierNumber: FortnoxSupplierNumber.make('003'),
      InvoiceNumber: 'INV-2026'
    })

    // The supplier InvoiceNumber stays a plain optional string. Branding protects
    // GivenNumber inputs; branded strings can still flow into plain string fields.
    expect(invoice.InvoiceNumber).toBe('INV-2026')
    expect(invoice.GivenNumber).toBe('42')

    // @ts-expect-error - GivenNumber is not a DocumentNumber
    const invoiceAsDocument: FortnoxDocumentNumber = invoice.GivenNumber

    expect([asDocument, invoiceAsDocument]).toHaveLength(2)
  })

  it.effect('roundtrips Fortnox brands through their encoded string form', () =>
    Effect.gen(function* () {
      const given = yield* Schema.decodeUnknownEffect(FortnoxGivenNumber)('42')
      expect(yield* Schema.encodeEffect(FortnoxGivenNumber)(given)).toBe('42')

      const document = yield* Schema.decodeUnknownEffect(FortnoxDocumentNumber)('a/b?#%')
      expect(yield* Schema.encodeEffect(FortnoxDocumentNumber)(document)).toBe('a/b?#%')

      for (const invalid of ['INV-123', '../2', '', ' 42 ', '4\n']) {
        const result = yield* Schema.decodeUnknownEffect(FortnoxGivenNumber)(invalid).pipe(
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)
      }
    })
  )

  it.effect('roundtrips email brands through their encoded string form', () =>
    Effect.gen(function* () {
      const folder = yield* Schema.decodeUnknownEffect(EmailFolderName)('INBOX')
      expect(yield* Schema.encodeEffect(EmailFolderName)(folder)).toBe('INBOX')

      const draft = yield* Schema.decodeUnknownEffect(EmailDraftId)('imap:uid-validity-123:uid-456')
      expect(yield* Schema.encodeEffect(EmailDraftId)(draft)).toBe('imap:uid-validity-123:uid-456')

      for (const invalid of ['', '   ']) {
        const folderResult = yield* Schema.decodeUnknownEffect(EmailFolderName)(invalid).pipe(
          Effect.result
        )

        const draftResult = yield* Schema.decodeUnknownEffect(EmailDraftId)(invalid).pipe(
          Effect.result
        )

        expect(Result.isFailure(folderResult)).toBe(true)
        expect(Result.isFailure(draftResult)).toBe(true)
      }
    })
  )

  it.effect('decodes file discovery through the canonical GivenNumber', () =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(FortnoxListSupplierInvoiceFilesInput)({
        givenNumber: '42',
        page: 2,
        limit: 5
      })

      expect(input.givenNumber).toBe('42')
      expect(yield* Schema.encodeEffect(FortnoxListSupplierInvoiceFilesInput)(input)).toEqual({
        givenNumber: '42',
        page: 2,
        limit: 5
      })

      for (const invalid of ['INV-2026', '../2', '', '4\n']) {
        const metadata = yield* Schema.decodeUnknownEffect(FortnoxSupplierInvoiceFile)({
          fileId: 'file-id',
          name: 'invoice.pdf',
          givenNumber: invalid
        }).pipe(Effect.result)

        expect(Result.isFailure(metadata)).toBe(true)

        const result = yield* Schema.decodeUnknownEffect(FortnoxListSupplierInvoiceFilesInput)({
          givenNumber: invalid
        }).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)
      }
    })
  )

  it.effect('uses the canonical document identity for previews without archive restrictions', () =>
    Effect.gen(function* () {
      // Archive IDs reject slashes; invoice document numbers must not inherit that restriction.
      expect(() => OpaqueId.make('a/b')).toThrow()
      const documentNumber = FortnoxDocumentNumber.make('a/b?#%')

      const host = binaryHost([
        binaryResponse(new Uint8Array([0, 1, 2]), 200, { 'content-type': 'application/pdf' })
      ])

      const result = yield* downloadFortnoxInvoicePreview(
        fortnoxIntegration,
        { documentNumber },
        { maxBytes: 16, maxMetadataBytes: 2000, maxErrorBodyBytes: 32 }
      ).pipe(Effect.provide(host.layer))

      expectTypeOf(result.source.id).toEqualTypeOf<FortnoxDocumentNumber>()
      expect(result.source).toEqual({ id: 'a/b?#%', generatedPreview: true })
      expect(host.requests[0]?.url).toBe('https://api.fortnox.se/3/invoices/a%2Fb%3F%23%25/preview')
    })
  )

  it.effect('rejects invalid preview identities at the runtime boundary', () =>
    Effect.gen(function* () {
      const raw: unknown = JSON.parse('{"documentNumber":".."}')
      const host = binaryHost([])

      const result = yield* downloadFortnoxInvoicePreview(
        fortnoxIntegration,
        // @ts-expect-error - untrusted unknown input must fail runtime validation, not types
        raw,
        { maxBytes: 16, maxMetadataBytes: 2000, maxErrorBodyBytes: 32 }
      ).pipe(Effect.provide(host.layer), Effect.result)

      expect(Result.isFailure(result)).toBe(true)
      expect(host.requests).toHaveLength(0)

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'invalid_input' })
      }
    })
  )
})

describe('typed connector actions', () => {
  const TestInput = Schema.Struct({ text: Schema.String })
  const TestOutput = Schema.Struct({ value: Schema.String })

  const echo = defineAction({
    id: 'test.echo',
    description: 'Echo test action.',
    inputSchema: TestInput,
    outputSchema: TestOutput,
    execute: ({ input }) => Effect.succeed(ActionResult.success({ value: input.text }))
  })

  const integration = makeIntegration({ connectorId: 'test' })

  it('preserves canonical action brands at the typed boundary (checked by pnpm tsc)', () => {
    type Input = Parameters<typeof fortnoxListSupplierInvoiceFilesAction.executeTyped>[0]['input']

    expectTypeOf<Input['givenNumber']>().toEqualTypeOf<FortnoxGivenNumber>()
    expectTypeOf<string>().not.toExtend<Input['givenNumber']>()
    expectTypeOf<FortnoxDocumentNumber>().not.toExtend<Input['givenNumber']>()
    expectTypeOf<
      Parameters<typeof fortnoxListSupplierInvoiceFilesAction.execute>[0]['input']
    >().toEqualTypeOf<unknown>()
  })

  it.effect('preserves typed input and output through executeTyped', () =>
    Effect.gen(function* () {
      const result = yield* echo.executeTyped({ integration, input: { text: 'hello' } })

      if (!Predicate.isTagged(result, 'Success')) throw new Error('Expected typed action success')

      const value: string = result.value.value
      expect(value).toBe('hello')

      expectTypeOf<Parameters<typeof echo.executeTyped>[0]['input']>().toEqualTypeOf<{
        readonly text: string
      }>()
      expectTypeOf(result.value.value).toEqualTypeOf<string>()
    })
  )

  it.effect('validates decoded input without replaying wire transformations', () => {
    const count = defineAction({
      id: 'test.count',
      inputSchema: Schema.Struct({ count: Schema.NumberFromString }),
      outputSchema: Schema.Number,
      execute: ({ input }) => Effect.succeed(ActionResult.success(input.count))
    })

    return Effect.gen(function* () {
      const typed = yield* count.executeTyped({ integration, input: { count: 42 } })
      const dynamic = yield* count.execute({ integration, input: { count: '42' } })
      expect(typed).toEqual(ActionResult.success(42))
      expect(dynamic).toEqual(typed)

      const invalid = yield* count
        .executeTyped({
          integration,
          // @ts-expect-error - simulate JS input: encoded strings are not decoded numbers
          input: { count: '42' }
        })
        .pipe(Effect.result)

      expect(Result.isFailure(invalid)).toBe(true)
    })
  })

  it.effect('validates untrusted runtime input through the typed entrypoint', () =>
    Effect.gen(function* () {
      const raw: unknown = JSON.parse('{"text":123}')

      const result = yield* echo
        .executeTyped({
          integration,
          // @ts-expect-error - untrusted unknown input must fail runtime validation, not types
          input: raw
        })
        .pipe(Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ cause: 'validation_failed' })
      }
    })
  )

  it.effect('keeps dynamic dispatch compatible for agent and wire callers', () =>
    Effect.gen(function* () {
      const typed = yield* echo.executeTyped({ integration, input: { text: 'hi' } })
      const dynamic = yield* echo.execute({ integration, input: { text: 'hi' } })
      expect(dynamic).toEqual(typed)

      const invalid = yield* echo.execute({ integration, input: { text: 123 } }).pipe(Effect.result)
      expect(Result.isFailure(invalid)).toBe(true)

      if (Result.isFailure(invalid)) {
        expect(invalid.failure).toMatchObject({ cause: 'validation_failed' })
      }
    })
  )
})
