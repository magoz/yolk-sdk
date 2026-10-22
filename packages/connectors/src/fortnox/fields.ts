// Internal Fortnox field building blocks shared by every resource module. Not re-exported from
// the `@yolk-sdk/connectors/fortnox` barrel: public schemas are the resource Classes built here.
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as SchemaParser from 'effect/SchemaParser'
import * as SchemaTransformation from 'effect/SchemaTransformation'

export const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())

// Reject dot segments and malformed UTF-16 before encoding identifiers into URL paths.
// The `u` flag keeps the pattern exportable to JSON Schema; the positive BMP class keeps the
// pre-`u` acceptance exactly (no controls, DEL, surrogates or astral characters).
export const Identifier = NonEmptyString.check(
  Schema.isPattern(/^(?!\.{1,2}$)[\u0020-\u007e\u0080-\ud7ff\ue000-\uffff]+$/u)
)

export const OptionalString = Schema.optional(Schema.String)

export const OptionalNonEmptyString = Schema.optional(NonEmptyString)

export const OptionalBoolean = Schema.optional(Schema.Boolean)

export const OptionalNumber = Schema.optional(Schema.Finite)

export const OptionalInt = Schema.optional(Schema.Int)

// Fortnox uses JSON null for unset response fields. Preserve null; do not require omission.
export const NullableString = Schema.optional(Schema.NullOr(Schema.String))

export const NullableNumber = Schema.optional(Schema.NullOr(Schema.Finite))

export const NullableBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))

export const NullableInt = Schema.optional(Schema.NullOr(Schema.Int))

// Fortnox bookkeeping account numbers are four digits.
export const AccountNumber = Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9999 }))

export const optionalMaxLength = (maxLength: number) =>
  Schema.optional(Schema.String.check(Schema.isMaxLength(maxLength)))

export const PaginationFields = {
  page: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  lastModified: Schema.optional(NonEmptyString)
}

// Parse options are call-scoped in Effect 4, not schema annotations. Closed write inputs reject
// unknown keys instead of stripping them, so a request is never silently sent without a field the
// caller supplied. Take fields, not a Class: `Schema.toType` (used by `executeTyped`) accepts an
// existing Class instance without checking its keys, so the closed member must be a Struct.
export const closedInput = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.declareConstructor<Schema.Struct<Fields>['Type'], Schema.Struct<Fields>['Encoded']>()(
    [Schema.Struct(fields)],
    ([member]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(member, { ...options, onExcessProperty: 'error' })(input),
    {
      toCodecJson: ([member]) => new SchemaAST.Link(member.ast, SchemaTransformation.passthrough())
    }
  )
