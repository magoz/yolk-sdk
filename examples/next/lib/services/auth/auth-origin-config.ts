import { Config, Effect, Option } from 'effect'
import { getPortlessOrigin } from '../../../portless-origin'
import { AuthConfigError } from './errors'

export const getAuthOriginConfig = () =>
  Effect.gen(function* () {
    const nodeEnv = yield* Config.string('NODE_ENV').pipe(Config.withDefault('production'))

    if (nodeEnv === 'development') {
      const portlessUrl = yield* Config.option(Config.string('PORTLESS_URL'))

      if (Option.isSome(portlessUrl)) {
        const baseURL = yield* Effect.try({
          try: () => getPortlessOrigin(portlessUrl.value),
          catch: () => new AuthConfigError({ message: 'Invalid PORTLESS_URL' })
        })

        return { baseURL, trustedOrigins: [baseURL] }
      }
    }

    // Preserve deployed and direct-Next/E2E behavior without trusting request headers.
    const projectUrl = yield* Config.string('NEXT_PUBLIC_PROJECT_URL')

    const vercelUrl = yield* Config.option(Config.string('VERCEL_URL')).pipe(
      Effect.map(Option.filter(value => value.length > 0))
    )

    const vercelBranchUrl = yield* Config.option(Config.string('VERCEL_BRANCH_URL')).pipe(
      Effect.map(Option.filter(value => value.length > 0))
    )

    const deploymentOrigin = Option.map(vercelUrl, value => `https://${value}`)

    return {
      baseURL: Option.getOrElse(deploymentOrigin, () => projectUrl),
      trustedOrigins: [
        projectUrl,
        ...Option.toArray(Option.map(vercelBranchUrl, value => `https://${value}`)),
        ...Option.toArray(deploymentOrigin)
      ]
    }
  }).pipe(Effect.mapError(() => new AuthConfigError({ message: 'Invalid auth origin config' })))
