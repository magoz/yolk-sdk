import './examples/next/lib/dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const workspaceRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: [
        join(workspaceRoot, 'tsconfig.json'),
        join(workspaceRoot, 'examples/next/tsconfig.json')
      ]
    }),
    react()
  ],
  test: {
    environment: 'jsdom',
    exclude: [
      '**/e2e/**',
      '**/node_modules/**',
      '**/.repos/**',
      '**/*.integration.test.ts',
      // Package suites run in their own node-environment vitest configs (see
      // `pnpm --filter './packages/*' test:run`). Running them again under the
      // root jsdom environment double-covers them and breaks `workflow` v5,
      // whose hardened serialization captures Node URL intrinsics at import
      // and rejects jsdom's URL shape.
      'packages/**'
    ]
  }
})
