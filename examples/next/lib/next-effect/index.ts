import { Data, Effect, Result } from 'effect'
import { redirect, notFound } from 'next/navigation'

// Tagged errors for navigation intents
class RedirectError extends Data.TaggedError('RedirectError')<{
  path: string
}> {}

class NotFoundError extends Data.TaggedError('NotFoundError') {}

/**
 * Create a redirect effect. Use this instead of Next.js redirect() inside Effect pipelines.
 */
const redirectEffect = (path: string) => Effect.fail(new RedirectError({ path }))

/**
 * Create a notFound effect. Use this instead of Next.js notFound() inside Effect pipelines.
 */
const notFoundEffect = () => Effect.fail(new NotFoundError())

/**
 * Custom Effect.runPromise that handles Next.js redirects and notFound outside the Effect context.
 *
 * Next.js redirect()/notFound() throw special errors that Effect catches, preventing them
 * from working. This helper catches navigation errors and calls the Next.js functions
 * outside the Effect pipeline.
 *
 * Pattern recommended by Michael Arnaldi: https://effect.website/play#148f971a5958
 */
type NavigationError = RedirectError | NotFoundError

const isNavigationError = (error: unknown): error is NavigationError =>
  error instanceof RedirectError || error instanceof NotFoundError

const runPromise = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(
    Effect.catch(
      Effect.map(effect, (a): Result.Result<A, NavigationError> => Result.succeed(a)),
      e =>
        isNavigationError(e)
          ? Effect.succeed<Result.Result<A, NavigationError>>(Result.fail(e))
          : Effect.fail(e)
    )
  )
  if (Result.isFailure(result)) {
    const error = result.failure
    if (error._tag === 'NotFoundError') {
      return notFound()
    }
    return redirect(error.path)
  }
  return result.success
}

export const NextEffect = {
  redirect: redirectEffect,
  notFound: notFoundEffect,
  isNavigationError,
  runPromise
}
