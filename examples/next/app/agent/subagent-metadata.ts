import { Predicate } from 'effect'
import type { ToolCall } from '@yolk-sdk/agent/protocol'

const ownDataField = (input: unknown, key: string): unknown => {
  if (!Predicate.isObject(input) || Predicate.isFunction(input)) {
    return undefined
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key)

  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
}

const textField = (input: unknown, key: string) => {
  const value = ownDataField(input, key)

  return Predicate.isString(value) && value.length > 0 ? value : undefined
}

const finiteField = (input: unknown, key: string) => {
  const value = ownDataField(input, key)

  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined
}

// Display metadata is field-wise: malformed siblings must not hide valid labels.
export const subagentMetadata = (call: ToolCall, structured: unknown) => {
  if (call.name !== 'subagent') {
    return undefined
  }

  return {
    description: textField(structured, 'description') ?? textField(call.params, 'description'),
    subagentType: textField(structured, 'subagent_type') ?? textField(call.params, 'subagent_type'),
    subagentRunId: textField(structured, 'subagent_run_id'),
    startedAtMs: finiteField(structured, 'started_at_ms'),
    endedAtMs: finiteField(structured, 'ended_at_ms'),
    durationMs: finiteField(structured, 'duration_ms'),
    status: textField(structured, 'status'),
    model: textField(structured, 'model')
  }
}
