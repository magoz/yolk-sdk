import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ['yolk.localhost', '*.yolk.localhost', 'yolk-e2e.localhost'],

  // PostHog reverse proxy to bypass ad-blockers
  async rewrites() {
    return [
      {
        source: '/ph/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*'
      },
      {
        source: '/ph/:path*',
        destination: 'https://eu.i.posthog.com/:path*'
      }
    ]
  }
}

export default withSentryConfig(nextConfig)
