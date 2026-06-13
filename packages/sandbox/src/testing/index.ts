import { Effect, Layer, Option, Ref } from 'effect'
import type { SandboxCommandInput, SandboxCommandResult, SandboxState } from '../model.ts'
import { Sandbox } from '../service.ts'
import { SandboxStateStore } from '../state-store.ts'
import type { SandboxError } from '../errors.ts'

export type FakeSandboxRun = (
  input: SandboxCommandInput
) => Effect.Effect<SandboxCommandResult, SandboxError>

export type FakeSandboxOptions = {
  readonly run: FakeSandboxRun
  readonly initialState?: SandboxState
}

export const makeFakeSandboxLayer = (options: FakeSandboxOptions) =>
  Layer.effect(
    Sandbox,
    Ref.make(Option.fromNullishOr(options.initialState)).pipe(
      Effect.map(stateRef =>
        Sandbox.of({
          run: input =>
            options.run(input).pipe(
              Effect.tap(result => Ref.set(stateRef, Option.some(result.state)))
            ),
          currentState: Ref.get(stateRef),
          delete: Ref.set(stateRef, Option.none())
        })
      )
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
          Ref.update(states, current => new Map([...current, [input.sandboxSessionId, input.state]])),
        clear: sandboxSessionId =>
          Ref.update(states, current => {
            const next = new Map(current)
            next.delete(sandboxSessionId)
            return next
          })
      })
    })
  )
