import { defineConfig } from 'tsdown'

const workerEntry = 'src/node/extraction-worker.ts'

export default defineConfig([
  {
    // The library: one module per source file, dependencies left to the host's install.
    entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.test.tsx', `!${workerEntry}`],
    unbundle: true,
    format: ['esm'],
    dts: {
      sourcemap: true
    },
    sourcemap: true,
    clean: true,
    deps: {
      // `xlsx` is an optional peer loaded lazily; never bundle it or the parsers.
      neverBundle: [
        /^@yolk-sdk\//,
        /^@effect\//,
        /^effect$/,
        /^xlsx$/,
        /^unpdf$/,
        /^mammoth$/,
        /^fflate$/
      ]
    }
  },
  {
    // The worker entry: one self-contained file with effect, fflate, mammoth (and its own
    // dependencies), unpdf, and the package's code inlined, so a host only has to ship this file
    // and the optional `xlsx` peer, which stays a dynamic `import('xlsx')` with its version check.
    entry: { 'node/extraction-worker': workerEntry },
    format: ['esm'],
    platform: 'node',
    dts: { sourcemap: false },
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: [/^xlsx$/],
      alwaysBundle: () => true,
      onlyBundle: false
    },
    outputOptions: {
      codeSplitting: false
    }
  }
])
