import type { NextConfig } from 'next'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWorkflow } from 'workflow/next'

const exampleDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(exampleDir, '../..')

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot,
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

export default withWorkflow(nextConfig)
