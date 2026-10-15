import { Context } from 'effect'
import type { Effect, Option } from 'effect'
import type {
  SandboxError,
  SandboxProviderError,
  SandboxStateError,
  SandboxStateStoreError
} from './errors.ts'
import type { SandboxCommandInput, SandboxCommandResult, SandboxState } from './model.ts'

/** Binary file input for `SandboxApi.writeFile`. `path` is workspace-relative. */
export type SandboxWriteFileInput = {
  readonly path: string
  readonly bytes: Uint8Array
}

/** Binary file read for `SandboxApi.readFile`. `path` is workspace-relative. */
export type SandboxReadFileInput = {
  readonly path: string
  readonly maxBytes: number
}

export type SandboxApi = {
  readonly run: (input: SandboxCommandInput) => Effect.Effect<SandboxCommandResult, SandboxError>
  readonly currentState: Effect.Effect<
    Option.Option<SandboxState>,
    SandboxStateStoreError | SandboxStateError
  >
  readonly delete: Effect.Effect<
    void,
    SandboxProviderError | SandboxStateStoreError | SandboxStateError
  >
  /** Write bytes to a workspace-relative file (parents created), replacing it. Returns the
   * normalized workspace-relative path. Optional: adapters without file transfer omit it.
   */
  readonly writeFile?: (input: SandboxWriteFileInput) => Effect.Effect<string, SandboxError>
  /** Read a workspace-relative file. Fails with `SandboxInputError` `file_not_found`, or
   * `file_too_large` past `maxBytes` (checked while streaming). Optional like `writeFile`.
   */
  readonly readFile?: (input: SandboxReadFileInput) => Effect.Effect<Uint8Array, SandboxError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxApi>()('@yolk-sdk/sandbox/Sandbox') {}
