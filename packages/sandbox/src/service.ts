import { Context } from 'effect'
import type { Effect, Option } from 'effect'
import type {
  SandboxError,
  SandboxProviderError,
  SandboxStateError,
  SandboxStateStoreError
} from './errors.ts'
import type { SandboxCommandInput, SandboxCommandResult, SandboxState } from './model.ts'

export type SandboxApi = {
  readonly run: (input: SandboxCommandInput) => Effect.Effect<SandboxCommandResult, SandboxError>
  readonly currentState: Effect.Effect<Option.Option<SandboxState>, SandboxStateStoreError | SandboxStateError>
  readonly delete: Effect.Effect<void, SandboxProviderError | SandboxStateStoreError | SandboxStateError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxApi>()(
  '@yolk-sdk/sandbox/Sandbox'
) {}
