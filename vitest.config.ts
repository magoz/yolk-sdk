import './lib/dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const workspaceRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: [join(workspaceRoot, 'tsconfig.json'), join(workspaceRoot, 'examples/next/tsconfig.json')] }),
    react()
  ],
  test: {
    environment: 'jsdom',
    exclude: ['**/e2e/**', '**/node_modules/**', '**/.repos/**', '**/*.integration.test.ts']
  }
})
