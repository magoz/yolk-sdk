import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { absoluteSandboxCwd } from '../src/lifecycle.ts'
import {
  defaultSandboxWorkspaceRoot,
  normalizeWorkspaceCwd,
  NormalizedWorkspaceCwd
} from '../src/index.ts'

const normalizedCases = [
  { raw: undefined, normalized: '.' },
  { raw: 'packages/../examples/next', normalized: 'examples/next' },
  { raw: '  a/b  ', normalized: 'a/b' },
  { raw: 'a//b', normalized: 'a/b' },
  { raw: './a/./b', normalized: 'a/b' },
  // Removing dot segments can expose whitespace that is part of a directory name.
  { raw: './ leading', normalized: ' leading' },
  { raw: 'trailing /./', normalized: 'trailing ' },
  { raw: './ /', normalized: ' ' }
] as const

const rejectedCases = ['/tmp', '../outside', 'a/../..', 'a\0b', '/']

describe('sandbox normalized cwd brand', () => {
  it('keeps NormalizedWorkspaceCwd nominally incompatible with plain strings', () => {
    const cwd = NormalizedWorkspaceCwd.make('examples/next')

    const wire: string = cwd
    expect(wire).toBe('examples/next')

    const backToCwd: NormalizedWorkspaceCwd = cwd
    expect(backToCwd).toBe('examples/next')

    // @ts-expect-error - unbranded strings require normalization through the canonical schema
    const fromString: NormalizedWorkspaceCwd = 'examples/next'

    // @ts-expect-error - absoluteSandboxCwd requires a normalized cwd, not a raw string
    const absolute = absoluteSandboxCwd(defaultSandboxWorkspaceRoot, 'examples/next')

    expect([fromString, absolute]).toHaveLength(2)
  })

  it('rejects unnormalized values at the public maker', () => {
    expect(NormalizedWorkspaceCwd.make('.').valueOf()).toBe('.')
    expect(NormalizedWorkspaceCwd.make('a/b').valueOf()).toBe('a/b')

    for (const raw of ['/abs', 'a//b', 'a/./b', './a', 'a/', '../x', '', 'a\0b']) {
      expect(() => NormalizedWorkspaceCwd.make(raw)).toThrow()
    }
  })

  it.effect('normalizes raw cwd inputs into the brand', () =>
    Effect.gen(function* () {
      for (const { raw, normalized } of normalizedCases) {
        const cwd = yield* normalizeWorkspaceCwd(raw)
        expect(cwd).toBe(normalized)

        const checked: NormalizedWorkspaceCwd = cwd
        expect(checked).toBe(normalized)
        expect(yield* Schema.encodeEffect(NormalizedWorkspaceCwd)(checked)).toBe(normalized)
        expect(absoluteSandboxCwd(defaultSandboxWorkspaceRoot, checked)).toBe(
          normalized === '.'
            ? defaultSandboxWorkspaceRoot
            : `${defaultSandboxWorkspaceRoot}/${normalized}`
        )
      }

      for (const raw of rejectedCases) {
        const result = yield* normalizeWorkspaceCwd(raw).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }
    })
  )

  it.effect('roundtrips normalized values through their encoded string form', () =>
    Effect.gen(function* () {
      const cwd = yield* Schema.decodeUnknownEffect(NormalizedWorkspaceCwd)('a/b')
      expect(yield* Schema.encodeEffect(NormalizedWorkspaceCwd)(cwd)).toBe('a/b')

      const root = yield* Schema.decodeUnknownEffect(NormalizedWorkspaceCwd)('.')
      expect(yield* Schema.encodeEffect(NormalizedWorkspaceCwd)(root)).toBe('.')

      // Untrusted wire input is decoded, never made: unnormalized forms fail validation.
      for (const raw of ['/abs', 'a//b', 'a/./b', './a', 'a/', '../x', '', null, 42]) {
        const result = yield* Schema.decodeUnknownEffect(NormalizedWorkspaceCwd)(raw).pipe(
          Effect.result
        )

        expect(Result.isFailure(result)).toBe(true)
      }
    })
  )

  it.effect('resolves absolute paths only from normalized values', () =>
    Effect.gen(function* () {
      const root = yield* normalizeWorkspaceCwd(undefined)
      expect(absoluteSandboxCwd(defaultSandboxWorkspaceRoot, root)).toBe(
        defaultSandboxWorkspaceRoot
      )

      const nested = yield* normalizeWorkspaceCwd('packages/../examples/next')
      expect(absoluteSandboxCwd(defaultSandboxWorkspaceRoot, nested)).toBe(
        `${defaultSandboxWorkspaceRoot}/examples/next`
      )
    })
  )
})
