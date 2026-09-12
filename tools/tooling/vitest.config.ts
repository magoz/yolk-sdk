import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

// DB-free tooling gate: local Oxlint CLI corpus + boundary CLI fixture tests.
// Node environment, no dotenv/DB config. Root vitest explicitly excludes these
// trees so each suite has a sole runner.
export default defineConfig({
  root: workspaceRoot,
  test: {
    environment: 'node',
    include: ['eslint-local-rules/test/**/*.test.js', 'scripts/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false
  }
})
