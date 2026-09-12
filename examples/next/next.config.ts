import type { NextConfig } from 'next'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWorkflow } from 'workflow/next'
import { getAllowedDevOrigins } from './next-dev-origins'

const exampleDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(exampleDir, '../..')

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot,
  // Next's synchronous config boundary; trust only the injected development hostname.
  allowedDevOrigins: getAllowedDevOrigins(
    process.env.NODE_ENV === 'development' ? process.env.PORTLESS_URL : undefined
  ),

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

export default withWorkflow(nextConfig)
