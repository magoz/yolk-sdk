import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import dotenv from 'dotenv'

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }))

const pooledUrl = 'postgresql://test@pooler.example.test/test'

const directUrl = 'postgresql://test@direct.example.test/test'

const missingDirectUrlCases: ReadonlyArray<Readonly<Record<string, string>>> = [
  {},
  { DATABASE_URL_UNPOOLED: '' }
]

beforeEach(() => {
  vi.resetModules()
  vi.mocked(dotenv.config).mockReset()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', pooledUrl)
  vi.stubEnv('DATABASE_URL_UNPOOLED', 'postgresql://other@development.example.test/dev')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('test environment database selection', () => {
  it('uses the direct connection from the test file for schema resets and tests', async () => {
    vi.mocked(dotenv.config).mockReturnValue({
      parsed: { DATABASE_URL: pooledUrl, DATABASE_URL_UNPOOLED: directUrl }
    })

    await import('./dotenv')

    expect(dotenv.config).toHaveBeenCalledExactlyOnceWith({
      path: expect.stringContaining('/examples/next/.env.test'),
      override: true,
      quiet: true
    })
    expect(process.env.DATABASE_URL).toBe(directUrl)
  })

  it.each(missingDirectUrlCases)(
    'does not select an inherited unpooled URL when the test file has none (%j)',
    async parsed => {
      vi.mocked(dotenv.config).mockReturnValue({ parsed })

      await import('./dotenv')

      expect(process.env.DATABASE_URL).toBe(pooledUrl)
    }
  )

  it('does not select an inherited unpooled URL when the test file is missing', async () => {
    vi.mocked(dotenv.config).mockReturnValue({
      error: Object.assign(new Error('Missing test env file'), { code: 'MISSING_DATA' as const })
    })

    await import('./dotenv')

    expect(process.env.DATABASE_URL).toBe(pooledUrl)
  })

  it.each(['development', 'production'])(
    'preserves normal connection selection in %s',
    async environment => {
      vi.stubEnv('NODE_ENV', environment)
      vi.mocked(dotenv.config).mockReturnValue({ parsed: { DATABASE_URL_UNPOOLED: directUrl } })

      await import('./dotenv')

      expect(dotenv.config).toHaveBeenCalledTimes(2)
      expect(dotenv.config).toHaveBeenNthCalledWith(1, {
        path: expect.stringContaining('/examples/next/.env.local'),
        quiet: true
      })
      expect(dotenv.config).toHaveBeenNthCalledWith(2, {
        path: expect.stringContaining('/examples/next/.env'),
        quiet: true
      })
      expect(process.env.DATABASE_URL).toBe(pooledUrl)
    }
  )
})
