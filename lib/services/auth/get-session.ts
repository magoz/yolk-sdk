import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { Auth } from './live-layer'
import { UnauthenticatedError, UnauthorizedError } from '@/lib/core/errors'

// Basic session guard - requires authentication
export const getSession = () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => cookies()) // Mark as dynamic

    const authService = yield* Auth
    const session = yield* authService.getSessionFromCookies()

    if (!session) {
      return yield* Effect.fail(new UnauthenticatedError({ message: 'Not authenticated' }))
    }

    return session
  }).pipe(Effect.withSpan('Auth.session.get'))

// Admin guard - requires ADMIN role
export const getAdminSession = () =>
  Effect.gen(function* () {
    const authService = yield* Auth
    const session = yield* authService.getSessionFromCookies()

    if (!session) {
      return yield* Effect.fail(new UnauthenticatedError({ message: 'Not authenticated' }))
    }

    if (session.user.role !== 'ADMIN') {
      return yield* Effect.fail(new UnauthorizedError({ message: 'Not authorized' }))
    }

    return session
  }).pipe(Effect.withSpan('Auth.session.getAdmin'))
