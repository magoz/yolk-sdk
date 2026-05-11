import { Effect, Option } from 'effect'
import readline from 'node:readline'
import type { McpToolServer } from './server'

export const runStdioMcpServer = (server: McpToolServer): Effect.Effect<never> =>
  Effect.callback<never>(resume => {
    const lines = readline.createInterface({ input: process.stdin })

    lines.on('line', line => {
      Effect.runPromise(server.handleLine(line)).then(
        response => {
          if (Option.isSome(response)) {
            process.stdout.write(`${response.value}\n`)
          }
        },
        error => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        }
      )
    })

    lines.on('close', () => resume(Effect.never))

    return Effect.sync(() => lines.close())
  })
