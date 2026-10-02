/**
 * The `@emulators/core` adapter of the stateful wrapper (internal; Node-only): the `createCore`
 * argument of `makeStatefulEmulator` and its variants, shared by every subpath on
 * `src/stateful-emulator.ts`. It loads the core lazily (the core imports Node builtins and reads
 * files at import time), defines a custom emulator whose only route runs the wrapper's dispatch
 * for every forwarded request, and adapts its runtime to `StatefulCore`. The wrapper itself never
 * imports the core, so it stays runtime-portable.
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Predicate } from 'effect'
import type { CoreDispatch, StatefulCore } from './stateful-emulator.ts'

export type StatefulCoreOptions<State> = {
  /** The core emulator's name. */
  readonly name: string
  /** The state the runtime starts from (already built from the seed). */
  readonly initial: State
  /** Decode a state the core is handed (a string is why it is invalid). */
  readonly decodeState: (value: unknown) => State | string
  /** The emulator's input-invalid error for an invalid seed. */
  readonly inputInvalid: (input: 'seed', reason: string) => Error
}

/**
 * The `createCore` of a stateful emulator: a core custom runtime seeded with `initial`, whose
 * state the wrapper reads, snapshots, and restores.
 */
export const statefulCoreRuntime =
  <State extends object>(options: StatefulCoreOptions<State>) =>
  async (dispatch: CoreDispatch<State>): Promise<StatefulCore<State>> => {
    const { decodeState, initial, inputInvalid } = options

    // Loaded lazily: the core imports Node builtins and reads files at import time.
    const core = await import('@emulators/core')

    const definition = core.defineEmulator<State>({
      name: options.name,
      cors: false,
      state: () => initial,
      validateSeed: value => {
        const decoded = decodeState(value)

        if (Predicate.isString(decoded)) {
          throw inputInvalid('seed', decoded)
        }

        return decoded
      },
      // The wrapper matched the route already and forwards every admitted request as a POST.
      setup: ({ app, state }) => {
        app.post('*', context => dispatch(state, context.req.raw))
      }
    })

    const runtime = await core.createCustomRuntime(definition, { seed: initial })

    return {
      fetch: request => runtime.fetch(request),
      baseUrl: runtime.baseUrl,
      snapshot: () => runtime.snapshot().state,
      restore: state => {
        const current: EmulatorSnapshot<State> = runtime.snapshot()

        return runtime.restore({ ...current, state })
      },
      close: () => runtime.close()
    }
  }
