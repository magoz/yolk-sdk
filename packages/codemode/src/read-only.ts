import { Effect } from 'effect'
import { CodeModeNestedCallRefused, type CodeModeBeforeNestedCallInput } from './script.ts'

/**
 * Why `readOnlyNestedCallGate` refused a call (`CodeModeNestedCallRefused.code`, and the script's
 * `error.code`):
 * - `unavailable`: the resolution would refuse the tool anyway (no effective access: unknown or
 *   not callable from scripts).
 * - `approval_required`: the tool is approval-gated.
 * - `invokes_model`: the tool calls a model when it runs (`ToolRegistration.invokesModel`).
 * - `not_read`: the call's effective access is `write` or `destructive`.
 */
export type ReadOnlyNestedCallRefusalCode =
  | 'unavailable'
  | 'approval_required'
  | 'invokes_model'
  | 'not_read'

export type ReadOnlyNestedCallGateOptions = {
  /**
   * Host override for the access check only: admit a call whose effective access is not `read`
   * because the host knows it only reads (for example a remote tool its server marks read-only).
   * Never admits a tool the resolution refuses, an approval-gated one, or one that invokes a
   * model.
   */
  readonly admit?: (input: CodeModeBeforeNestedCallInput) => boolean
}

const refuse = (code: ReadOnlyNestedCallRefusalCode, message: string) =>
  Effect.fail(new CodeModeNestedCallRefused({ code, message }))

/**
 * A `beforeNestedCall` hook (for `runCodeModeScript` or `makeCodeModeTool`) that admits only
 * nested calls that read without a model: the call's effective access (`toolCallAccess`, so a
 * read-only call of a `write` tool counts) must be `read`, and the tool must be neither
 * approval-gated nor marked `invokesModel`. Fails closed: a tool without effective access is
 * refused. Every refusal is a `CodeModeNestedCallRefused` with a `ReadOnlyNestedCallRefusalCode`,
 * kept on the call's `CodeModeScriptCall.refusal` even when the script catches the rejection, so a
 * host can count a refused call as a failed run.
 */
export const readOnlyNestedCallGate =
  (options: ReadOnlyNestedCallGateOptions = {}) =>
  (input: CodeModeBeforeNestedCallInput): Effect.Effect<void, CodeModeNestedCallRefused> => {
    const { access, call, tool } = input

    if (access === undefined) {
      return refuse('unavailable', `${call.name} is not available to this script.`)
    }

    if (tool.def.approval !== undefined) {
      return refuse(
        'approval_required',
        `${call.name} needs approval: this script may only call tools that read.`
      )
    }

    if (tool.invokesModel === true) {
      return refuse(
        'invokes_model',
        `${call.name} calls a model: this script may only call tools that read without one.`
      )
    }

    if (access === 'read' || options.admit?.(input) === true) return Effect.void

    return refuse(
      'not_read',
      `${call.name} is not a read: this script may only call tools that read.`
    )
  }
