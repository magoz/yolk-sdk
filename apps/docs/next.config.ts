import type { NextConfig } from 'next'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMDX } from 'fumadocs-mdx/next'

const docsDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(docsDir, '../..')
const withMDX = createMDX()

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot
}

export default withMDX(nextConfig)
