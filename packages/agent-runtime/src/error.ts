import * as Schema from 'effect/Schema'

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  'SessionNotFoundError',
  {
    sessionId: Schema.String
  }
) {}

export type RuntimeError = SessionNotFoundError
