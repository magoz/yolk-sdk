import { Schema } from 'effect'

export const EmailSchema = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)),
  Schema.annotate({
    title: 'Email',
    description: 'A valid email address'
  }),
  Schema.brand('Email')
)

export type Email = Schema.Schema.Type<typeof EmailSchema>

// Validation helper
export const parseEmail = Schema.decodeUnknownEffect(EmailSchema)
