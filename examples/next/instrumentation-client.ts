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
