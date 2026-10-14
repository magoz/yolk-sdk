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
 * Tool names activated by `tool_search` results in the transcript. A result counts only when it
 * answers a `tool_search` call of the assistant message it follows (providers may reuse call ids
 * across turns, so ids are matched against the latest assistant message only), so other tool
 * results can never activate a tool.
 */
export const activatedToolNames = (messages: ReadonlyArray<AgentMessage>): ReadonlySet<string> => {
  const activated = new Set<string>()
  let pendingSearches = new Set<string>()

  for (const message of messages) {
    if (Predicate.isTagged(message, 'Assistant')) {
      pendingSearches = new Set(
        message.parts.flatMap(part =>
          Predicate.isTagged(part, 'HostToolCall') && part.call.name === toolSearchToolName
            ? [part.call.id]
            : []
        )
      )
    } else if (
      Predicate.isTagged(message, 'ToolResult') &&
      pendingSearches.has(message.toolCallId)
    ) {
      pendingSearches.delete(message.toolCallId)

      const decoded =
        message.isError === true ? Option.none() : decodeActivation(message.structuredContent)

      if (Option.isSome(decoded)) {
        for (const name of decoded.value.toolSearch.activated) activated.add(name)
      }
    }
  }

  return activated
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
