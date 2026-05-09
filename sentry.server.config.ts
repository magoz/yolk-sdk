import * as Sentry from '@sentry/nextjs'

const NEXT_PUBLIC_SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN
if (!NEXT_PUBLIC_SENTRY_DSN) throw new Error('NEXT_PUBLIC_SENTRY_DSN env variable not found')

Sentry.init({
  dsn: NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Adds request headers and IP for users
  sendDefaultPii: true,

  tracesSampleRate: 1,
  enableLogs: true
})
