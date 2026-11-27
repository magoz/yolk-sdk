import { createRequire } from 'node:module'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'
import { docxMediaType, extractWith, makeDocx } from './fixtures.ts'

// Hosts whose bundler resolves packages' browser files (Cloudflare Workers under Vite) get
// mammoth's browser unzip, which reads only `arrayBuffer`; its standalone browser build is that.
vi.mock('mammoth', () => ({
  default: createRequire(import.meta.url)('mammoth/mammoth.browser.js')
}))

describe('DOCX with mammoth browser build', () => {
  it.effect('extracts docx text', () =>
    Effect.gen(function* () {
      const extracted = yield* extractWith({
        filename: 'brief.docx',
        mediaType: docxMediaType,
        bytes: makeDocx('Hello DOCX')
      })

      expect(extracted.content).toBe('Hello DOCX')
    })
  )
})
