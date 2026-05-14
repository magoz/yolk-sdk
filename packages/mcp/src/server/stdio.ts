import { Effect, Option, Stdio, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import type { McpToolServer } from './server.ts'

const writeStdout = (stdio: Stdio.Stdio, value: string) =>
  Stream.make(`${value}\n`).pipe(Stream.run(stdio.stdout()))

const writeResponse = (stdio: Stdio.Stdio, response: Option.Option<string>) =>
  Option.match(response, {
    onNone: () => Effect.void,
    onSome: value => writeStdout(stdio, value)
  })

const ignoreStdioError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch(() => Effect.void))

const handleStdioLine = <R>(server: McpToolServer<R>, stdio: Stdio.Stdio, line: string) =>
  server.handleLine(line).pipe(
    Effect.flatMap(response => writeResponse(stdio, response)),
    ignoreStdioError
  )

export const runStdioMcpServer = <R>(
  server: McpToolServer<R>
): Effect.Effect<never, never, R | Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio

    yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(line => handleStdioLine(server, stdio, line)),
      Effect.catch((_error: PlatformError) => Effect.void)
    )

    return yield* Effect.never
  })
