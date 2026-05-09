import { Data } from 'effect'

export class EmailConfigError extends Data.TaggedError('EmailConfigError')<{
  message: string
}> {}

export class SendEmailError extends Data.TaggedError('SendEmailError')<{
  message: string
  cause?: unknown
}> {}
