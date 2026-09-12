import { Data } from 'effect'
import * as Schema from 'effect/Schema'

import { maxWorkflowChildren } from './policy'

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly message: string
}> {}

export class WorkflowChildRecord extends Schema.Class<WorkflowChildRecord>('WorkflowChildRecord')({
  callId: Schema.String,
  request: Schema.Unknown,
  subagentType: Schema.String,
  description: Schema.String,
  startedAtMs: Schema.Number,
  workflowRunId: Schema.NullOr(Schema.String),
  launchUncertain: Schema.optionalKey(Schema.Boolean),
  result: Schema.NullOr(Schema.Unknown)
}) {}

export class WorkflowRegistry extends Schema.Class<WorkflowRegistry>('WorkflowRegistry')({
  stopped: Schema.Boolean,
  children: Schema.Array(WorkflowChildRecord)
}) {}

export const emptyWorkflowRegistry = () => WorkflowRegistry.make({ stopped: false, children: [] })

export type RegistryCommand =
  | { readonly type: 'reserve'; readonly child: WorkflowChildRecord }
  | { readonly type: 'admit'; readonly callId: string; readonly workflowRunId: string }
  | { readonly type: 'launch-uncertain'; readonly callId: string }
  | {
      readonly type: 'complete'
      readonly callId: string
      readonly workflowRunId: string
      readonly result: unknown
    }
  | { readonly type: 'stop' }

/** Pure transition shared by the locked DB adapter and behavioral fake. */
export const transitionWorkflowRegistry = (
  state: WorkflowRegistry,
  command: RegistryCommand
): WorkflowRegistry => {
  if (command.type === 'stop') return WorkflowRegistry.make({ ...state, stopped: true })

  if (state.stopped) return state

  if (command.type === 'reserve') {
    if (state.children.some(child => child.callId === command.child.callId)) return state

    if (state.children.length >= maxWorkflowChildren) return state

    return WorkflowRegistry.make({ ...state, children: [...state.children, command.child] })
  }

  return WorkflowRegistry.make({
    ...state,
    children: state.children.map(child => {
      if (child.callId !== command.callId) return child

      if (command.type === 'launch-uncertain') {
        return child.workflowRunId === null
          ? WorkflowChildRecord.make({ ...child, launchUncertain: true })
          : child
      }

      if (command.type === 'admit') {
        return child.workflowRunId === null
          ? WorkflowChildRecord.make({
              ...child,
              workflowRunId: command.workflowRunId,
              launchUncertain: false
            })
          : child
      }

      return child.workflowRunId === command.workflowRunId && child.result === null
        ? WorkflowChildRecord.make({ ...child, result: command.result })
        : child
    })
  })
}
