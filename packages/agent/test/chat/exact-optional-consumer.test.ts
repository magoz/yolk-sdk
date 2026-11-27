import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))

const tsgo = fileURLToPath(
  new URL('../../../../node_modules/@effect/tsgo/dist/effect-tsgo.cjs', import.meta.url)
)

const fixture = 'test/chat/exact-optional/'

const consumer = fileURLToPath(new URL('exact-optional/consumer.ts', import.meta.url))

/**
 * Hosts may compile with `exactOptionalPropertyTypes` (an Effect UI app must); the package does
 * not. The fixture compiles with it, and its own lines must have no diagnostics. The package's
 * sources compile with it too and report errors of their own, which a host with `skipLibCheck`
 * never sees through the built declarations, so only the fixture's lines count. `--listFiles`
 * shows the fixture was compiled, so a compiler that didn't run can't pass.
 */
const compileFixture = Effect.callback<ReadonlyArray<string>>(resume => {
  execFile(
    process.execPath,
    [tsgo, 'tsrs', '-p', `${fixture}tsconfig.json`, '--noEmit', '--pretty', 'false', '--listFiles'],
    { cwd: packageDir, maxBuffer: 16 * 1024 * 1024 },
    (_error, stdout) => {
      resume(Effect.succeed(stdout.split('\n')))
    }
  )
})

describe('exactOptionalPropertyTypes consumers', () => {
  it.effect(
    'markChatRunStart takes the projection and the chat reducer state',
    () =>
      Effect.gen(function* () {
        const lines = yield* compileFixture
        expect(lines).toContain(consumer)
        expect(lines.filter(line => line.startsWith(fixture))).toEqual([])
      }),
    60_000
  )
})
