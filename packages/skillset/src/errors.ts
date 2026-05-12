import * as Schema from 'effect/Schema'

export const SkillsetErrorCause = Schema.Literals([
  'duplicate_entry',
  'frontmatter_field_missing',
  'frontmatter_invalid',
  'frontmatter_missing',
  'invalid_name',
  'name_mismatch'
])
export type SkillsetErrorCause = typeof SkillsetErrorCause.Type

export class SkillsetError extends Schema.TaggedErrorClass<SkillsetError>()('SkillsetError', {
  cause: SkillsetErrorCause,
  message: Schema.String
}) {}
