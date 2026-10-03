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
  // Code mode's pi executor loads its worker file and quickjs.wasm from disk, and the extractors
  // start their self-contained parser worker from the package's `dist` and load SheetJS inside it;
  // keep them unbundled, as npm consumers do.
  serverExternalPackages: [
    '@yolk-sdk/codemode',
    '@earendil-works/pi-codemode',
    'quickjs-wasi',
    '@yolk-sdk/extractors',
    'xlsx'
  ],
  // Turbopack still bundles workspace links, so tracing never sees the extractor worker. Its
  // default location resolves from the package source to `packages/extractors/dist`; ship that one
  // self-contained file and the dependency-free SheetJS it imports (see the README's "Extractor
  // worker").
  outputFileTracingIncludes: {
    '/**': [
      '../../packages/extractors/dist/node/extraction-worker.mjs',
      '../../packages/extractors/node_modules/xlsx/package.json',
      '../../packages/extractors/node_modules/xlsx/xlsx.mjs'
    ]
  },
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
