import { Data } from 'effect'

export class AuthApiError extends Data.TaggedError('AuthApiError')<{
  error: unknown
}> {}

export class AuthConfigError extends Data.TaggedError('AuthConfigError')<{
  message: string
}> {}

export class AuthSessionError extends Data.TaggedError('AuthSessionError')<{
  message: string
}> {}

// Note: UnauthenticatedError and UnauthorizedError are defined in @/lib/core/errors
// Import from there for shared auth errors
