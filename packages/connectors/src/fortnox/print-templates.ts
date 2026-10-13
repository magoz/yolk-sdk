import { Chunk } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { Identifier, NullableString } from './fields.ts'
import { FortnoxPrintOAuthCredentialSlot } from './oauth.ts'
import { listPath, readFortnox } from './shared.ts'

export const FortnoxPrintTemplateCode = Identifier.pipe(Schema.brand('FortnoxPrintTemplateCode'))

export type FortnoxPrintTemplateCode = typeof FortnoxPrintTemplateCode.Type

// Fortnox Print Templates resource (Utskrift). Both fields are read-only.
export class FortnoxPrintTemplate extends Schema.Class<FortnoxPrintTemplate>(
  'FortnoxPrintTemplate'
)({
  Template: FortnoxPrintTemplateCode,
  Name: NullableString
}) {}

export class FortnoxListPrintTemplatesInput extends Schema.Class<FortnoxListPrintTemplatesInput>(
  'FortnoxListPrintTemplatesInput'
)({
  type: Schema.optional(Schema.Literals(['invoice', 'offer', 'order']))
}) {}

export class FortnoxListPrintTemplatesOutput extends Schema.Class<FortnoxListPrintTemplatesOutput>(
  'FortnoxListPrintTemplatesOutput'
)({
  printTemplates: Schema.Chunk(FortnoxPrintTemplate)
}) {}

// Fortnox docs: the print templates list is unpaginated (no MetaInformation, no page/limit).
const PrintTemplatesResponse = Schema.Struct({
  PrintTemplates: Schema.Array(FortnoxPrintTemplate)
})

export const fortnoxListPrintTemplatesAction = defineAction({
  id: 'fortnox.list_print_templates',
  description:
    'List all Fortnox print templates (Template code and Name) for one document type: invoice, offer, or order. Omitted type returns invoice templates. The list is not paginated.',
  access: 'read',
  inputSchema: FortnoxListPrintTemplatesInput,
  outputSchema: FortnoxListPrintTemplatesOutput,
  execute: ({ integration, input }) =>
    readFortnox(
      integration,
      FortnoxPrintOAuthCredentialSlot,
      listPath('printtemplates', {}, { type: input.type }),
      PrintTemplatesResponse,
      value =>
        FortnoxListPrintTemplatesOutput.make({
          printTemplates: Chunk.fromIterable(value.PrintTemplates)
        })
    )
})

export const fortnoxPrintActions = [fortnoxListPrintTemplatesAction] as const
