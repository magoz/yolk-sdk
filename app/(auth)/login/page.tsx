import { Suspense } from 'react'
import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import { NextEffect } from '@/lib/next-effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { LoginForm } from './login-form'

async function Content() {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      // If session exists, user is already authenticated
      yield* getSession()

      // Redirect to home if already logged in
      return yield* NextEffect.redirect('/')
    }).pipe(
      Effect.provide(Layer.mergeAll(AppLayer)),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => Effect.succeed(<LoginForm />)),
      Effect.catch(error =>
        Effect.succeed(
          <main className="p-8">
            <p>Something went wrong.</p>
            <p className="text-red-500">
              Error: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </main>
        )
      )
    )
  )
}

export default async function Page() {
  return (
    <Suspense fallback={null}>
      <Content />
    </Suspense>
  )
}
