import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { LLMToolCall } from '@yolk-sdk/agent/loop'

/**
 * A tool call a provider returned, as the loop's `LLMToolCall` event, or `invalid()` when the
 * call does not satisfy `ToolCall` (its id and name are non-empty, trimmed strings). Models do
 * return calls with an empty name. `ToolCall.make` would throw inside the provider's stream: a
 * defect that skips the loop's retries, a host's fallback model and its failure handling, so every
 * provider builds its calls through this decode and fails with its own typed error instead.
 */
export const providerToolCallEvent = <E>(
  call: { readonly id: string; readonly name: string; readonly params: unknown },
  invalid: () => E
): Effect.Effect<LLMToolCall, E> =>
  Schema.decodeUnknownEffect(ToolCall)(call).pipe(
    Effect.mapError(invalid),
    Effect.map(decoded => LLMToolCall.make({ call: decoded }))
  )
