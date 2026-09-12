import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  root: workspaceRoot,
  test: {
    environment: 'node',
    include: ['tools/oxlint/*.test.ts'],
    exclude: ['**/node_modules/**', 'tools/oxlint/anti-slop/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false
  }
})
