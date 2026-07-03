import { Context } from 'effect'
import type { Effect, Option } from 'effect'
import type { SandboxStateStoreError } from './errors.ts'
import type { SandboxState } from './model.ts'

export type SandboxStateStoreApi = {
  readonly load: (
    sandboxSessionId: string
  ) => Effect.Effect<Option.Option<SandboxState>, SandboxStateStoreError>
  readonly save: (input: {
    readonly sandboxSessionId: string
    readonly state: SandboxState
  }) => Effect.Effect<void, SandboxStateStoreError>
  readonly clear: (sandboxSessionId: string) => Effect.Effect<void, SandboxStateStoreError>
}

export class SandboxStateStore extends Context.Service<SandboxStateStore, SandboxStateStoreApi>()(
  '@yolk-sdk/sandbox/SandboxStateStore'
) {}
