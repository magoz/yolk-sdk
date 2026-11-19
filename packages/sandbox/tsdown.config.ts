import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.test.tsx', '!src/**/*.d.ts'],
  unbundle: true,
  format: ['esm'],
  dts: {
    sourcemap: true
  },
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^@yolk-sdk\//, /^@effect\//, /^effect$/, /^@vercel\/sandbox$/, /^cloudflare:/]
  }
})
