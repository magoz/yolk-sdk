import { Context, Effect, Layer, Config } from 'effect'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import * as schema from '../db/schema'
import { emailOTP } from 'better-auth/plugins'
import { Email } from '../email/live-layer'
import { AuthApiError, AuthConfigError } from './errors'
import { drizzle } from 'drizzle-orm/neon-http'

// Auth database service (internal) - uses Neon HTTP driver for serverless
class AuthDb extends Context.Service<AuthDb, ReturnType<typeof drizzle>>()('@app/AuthDb') {}

const AuthDbLive = Layer.effect(
  AuthDb,
  Effect.gen(function* () {
    const url = yield* Config.string('DATABASE_URL')
    return drizzle({ connection: url, relations: schema.relations })
  })
)

// Auth configuration service (internal)
class AuthConfig extends Context.Service<
  AuthConfig,
  {
    readonly projectUrl: string
    readonly appName: string
    readonly emailSender: string
    readonly vercelUrl: string | undefined
    readonly vercelBranchUrl: string | undefined
  }
>()('@app/AuthConfig') {}

const AuthConfigLive = Layer.effect(
  AuthConfig,
  Effect.gen(function* () {
    const projectUrl = yield* Config.string('NEXT_PUBLIC_PROJECT_URL')
    const appName = yield* Config.string('APP_NAME')
    const emailSender = yield* Config.string('EMAIL_SENDER')
    const vercelUrl = yield* Config.option(Config.string('VERCEL_URL'))
    const vercelBranchUrl = yield* Config.option(Config.string('VERCEL_BRANCH_URL'))

    return {
      projectUrl,
      appName,
      emailSender,
      vercelUrl: vercelUrl._tag === 'Some' ? vercelUrl.value : undefined,
      vercelBranchUrl: vercelBranchUrl._tag === 'Some' ? vercelBranchUrl.value : undefined
    }
  }).pipe(Effect.mapError(() => new AuthConfigError({ message: 'Auth config missing' })))
)

// Service definition
export class Auth extends Context.Service<Auth>()('@app/Auth', {
  make: Effect.gen(function* () {
    const authDb = yield* AuthDb
    const emailService = yield* Email
    const config = yield* AuthConfig

    const auth = betterAuth({
      baseURL: config.vercelUrl ? `https://${config.vercelUrl}` : config.projectUrl,
      trustedOrigins: [
        config.projectUrl,
        ...(config.vercelBranchUrl ? [`https://${config.vercelBranchUrl}`] : []),
        ...(config.vercelUrl ? [`https://${config.vercelUrl}`] : [])
      ],
      database: drizzleAdapter(authDb, {
        provider: 'pg',
        schema
      }),
      user: {
        additionalFields: {
          role: {
            type: 'string',
            required: true,
            defaultValue: 'USER',
            input: false
          }
        }
      },
      session: {
        expiresIn: 60 * 60 * 24 * 90, // 90 days
        cookieCache: {
          enabled: true,
          maxAge: 5 * 60
        }
      },
      plugins: [
        emailOTP({
          async sendVerificationOTP({ email, otp, type }) {
            if (type !== 'sign-in') return

            await emailService
              .sendEmail({
                from: `${config.appName} <${config.emailSender}>`,
                to: email,
                subject: `${config.appName} - Login code`,
                html: `Your login code is: <strong>${otp}</strong>`
              })
              .pipe(
                Effect.tap(result => Effect.log(`OTP email sent: ${result.id}`)),
                Effect.tapError(error =>
                  Effect.logError('Error while sending OTP code', { error })
                ),
                Effect.runPromise
              )
          }
        }),
        nextCookies()
      ]
    })

    const call = <A>(f: (client: typeof auth, signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: signal => f(auth, signal),
        catch: error => new AuthApiError({ error })
      })

    const signUp = (email: string, password: string, name: string) =>
      call(auth => auth.api.signUpEmail({ body: { email, password, name } })).pipe(
        Effect.withSpan('Auth.signUp')
      )

    const signIn = (email: string, password: string) =>
      call(auth => auth.api.signInEmail({ body: { email, password } })).pipe(
        Effect.withSpan('Auth.signIn')
      )

    const signOut = (headers: Headers = new Headers()) =>
      call(auth => auth.api.signOut({ headers })).pipe(Effect.withSpan('Auth.signOut'))

    const getSession = (headers: Headers = new Headers()) =>
      call(auth => auth.api.getSession({ headers })).pipe(Effect.withSpan('Auth.getSession'))

    const updateUser = (data: { name?: string; email?: string }) =>
      call(auth => auth.api.updateUser({ body: data })).pipe(Effect.withSpan('Auth.updateUser'))

    const changePassword = (currentPassword: string, newPassword: string) =>
      call(auth =>
        auth.api.changePassword({
          body: { currentPassword, newPassword }
        })
      ).pipe(Effect.withSpan('Auth.changePassword'))

    const getSessionFromCookies = () =>
      Effect.gen(function* () {
        const { cookies } = yield* Effect.tryPromise(() => import('next/headers'))
        const cookieStore = yield* Effect.tryPromise(() => cookies())

        const headers = new Headers()
        cookieStore.getAll().forEach((cookie: { name: string; value: string }) => {
          headers.append('cookie', `${cookie.name}=${cookie.value}`)
        })

        return yield* getSession(headers)
      }).pipe(Effect.withSpan('Auth.getSessionFromCookies'))

    return {
      auth,
      signUp,
      signIn,
      signOut,
      getSession,
      getSessionFromCookies,
      updateUser,
      changePassword
    } as const
  })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(AuthConfigLive, AuthDbLive, Email.layer))
  )
}
