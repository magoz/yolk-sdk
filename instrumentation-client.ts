import * as Sentry from '@sentry/nextjs'
import posthog from 'posthog-js'

const NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY
if (!NEXT_PUBLIC_POSTHOG_KEY) throw new Error('NEXT_PUBLIC_POSTHOG_KEY env variable not found')

posthog.init(NEXT_PUBLIC_POSTHOG_KEY, {
  // Reverse proxy
  api_host: '/ph',
  ui_host: 'https://eu.posthog.com',

  person_profiles: 'always',
  defaults: '2025-11-30'
})

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

// This export will instrument router navigations
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
