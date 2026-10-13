import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { AgentMessage } from './message.ts'
import { isDeferredTool, providerToolDefs, type ToolDef } from './tool.ts'

/** The package tool that activates deferred tools (ADR 0007). */
export const toolSearchToolName = 'tool_search'

/** `ToolResult.structuredContent` of a `tool_search` call: the deferred tools it activated. */
export const ToolSearchActivation = Schema.Struct({
  toolSearch: Schema.Struct({ activated: Schema.Array(Schema.String) })
})

export type ToolSearchActivation = typeof ToolSearchActivation.Type

const decodeActivation = Schema.decodeUnknownOption(ToolSearchActivation)

/**
 * Tool names activated by `tool_search` results in the transcript: only results of calls the
 * assistant made to `tool_search`, so other tool results can never activate a tool.
 */
export const activatedToolNames = (messages: ReadonlyArray<AgentMessage>): ReadonlySet<string> => {
  const searchCalls = new Set(
    messages.flatMap(message =>
      Predicate.isTagged(message, 'Assistant')
        ? message.parts.flatMap(part =>
            Predicate.isTagged(part, 'HostToolCall') && part.call.name === toolSearchToolName
              ? [part.call.id]
              : []
          )
        : []
    )
  )

  return new Set(
    messages.flatMap(message =>
      Predicate.isTagged(message, 'ToolResult') &&
      searchCalls.has(message.toolCallId) &&
      message.isError !== true
        ? Option.match(decodeActivation(message.structuredContent), {
            onNone: () => [],
            onSome: activation => activation.toolSearch.activated
          })
        : []
    )
  )
}

/**
 * The definitions one model request declares (ADR 0007): the provider-facing tools (never
 * `codemode`-only ones) minus deferred tools no `tool_search` result in `messages` activated.
 * Activation is derived, never stored, so every step and redelivery of the same transcript
 * declares the same tools.
 */
export const declaredToolDefs = (
  tools: ReadonlyArray<ToolDef>,
  messages: ReadonlyArray<AgentMessage>
): ReadonlyArray<ToolDef> => {
  const provider = providerToolDefs(tools)

  if (!provider.some(isDeferredTool)) return provider

  const activated = activatedToolNames(messages)

  return provider.filter(def => !isDeferredTool(def) || activated.has(def.name))
}
