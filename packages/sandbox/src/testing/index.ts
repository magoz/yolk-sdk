import { Effect, Layer, Option, Ref } from 'effect'
import type { SandboxCommandInput, SandboxCommandResult, SandboxState } from '../model.ts'
import { normalizeWorkspacePath } from '../lifecycle.ts'
import { Sandbox, type SandboxReadFileInput, type SandboxWriteFileInput } from '../service.ts'
import { SandboxStateStore } from '../state-store.ts'
import { SandboxInputError, type SandboxError } from '../errors.ts'

export type FakeSandboxRun = (
  input: SandboxCommandInput
) => Effect.Effect<SandboxCommandResult, SandboxError>

export type FakeSandboxOptions = {
  readonly run: FakeSandboxRun
  readonly initialState?: SandboxState
  /** Initial workspace files by workspace-relative path; enables `writeFile`/`readFile`. */
  readonly files?: ReadonlyMap<string, Uint8Array>
}

/** In-memory `writeFile`/`readFile` over workspace-relative paths, as the Vercel layer has them. */
export const makeFakeSandboxFiles = (initial: ReadonlyMap<string, Uint8Array> = new Map()) => {
  const files = new Map(initial)

  return {
    files,
    writeFile: (input: SandboxWriteFileInput) =>
      normalizeWorkspacePath(input.path).pipe(
        Effect.tap(path => Effect.sync(() => files.set(path, Uint8Array.from(input.bytes))))
      ),
    readFile: (input: SandboxReadFileInput) =>
      normalizeWorkspacePath(input.path).pipe(
        Effect.flatMap(path => {
          const bytes = files.get(path)

          if (bytes === undefined) {
            return Effect.fail(
              new SandboxInputError({ cause: 'file_not_found', message: `${path} does not exist` })
            )
          }

          return bytes.byteLength > input.maxBytes
            ? Effect.fail(
                new SandboxInputError({
                  cause: 'file_too_large',
                  message: `${path} is larger than ${input.maxBytes} bytes`
                })
              )
            : Effect.succeed(bytes)
        })
      )
  }
}

export const makeFakeSandboxLayer = (options: FakeSandboxOptions) =>
  Layer.effect(
    Sandbox,
    Ref.make(Option.fromNullishOr(options.initialState)).pipe(
      Effect.map(stateRef => {
        const base = {
          run: (input: SandboxCommandInput) =>
            options
              .run(input)
              .pipe(Effect.tap(result => Ref.set(stateRef, Option.some(result.state)))),
          currentState: Ref.get(stateRef),
          delete: Ref.set(stateRef, Option.none())
        }

        if (options.files === undefined) return Sandbox.of(base)

        const files = makeFakeSandboxFiles(options.files)

        return Sandbox.of({ ...base, writeFile: files.writeFile, readFile: files.readFile })
      })
    )
  )

export type InMemorySandboxStateStoreEntry = {
  readonly sandboxSessionId: string
  readonly state: SandboxState
}

export const makeInMemorySandboxStateStoreLayer = (
  initial: ReadonlyArray<InMemorySandboxStateStoreEntry> = []
) =>
  Layer.effect(
    SandboxStateStore,
    Effect.gen(function* () {
      const states = yield* Ref.make(
        new Map(initial.map(entry => [entry.sandboxSessionId, entry.state]))
      )

      return SandboxStateStore.of({
        load: sandboxSessionId =>
          Ref.get(states).pipe(
            Effect.map(current => Option.fromNullishOr(current.get(sandboxSessionId)))
          ),
        save: input =>
          Ref.update(
            states,
            current => new Map([...current, [input.sandboxSessionId, input.state]])
          ),
        clear: sandboxSessionId =>
          Ref.update(states, current => {
            const next = new Map(current)
            next.delete(sandboxSessionId)

            return next
          })
      })
    })
  )
