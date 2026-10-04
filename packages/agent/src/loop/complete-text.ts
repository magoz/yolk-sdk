import { Effect, Option, Predicate, Ref, Stream, type Duration } from 'effect'
import { addAgentUsage, zeroAgentUsage, type AgentUsage } from '@yolk-sdk/agent/protocol'
import { LLMError, type LLMProviderError } from './error.ts'
import type { LLMEvent } from './llm-event.ts'
import { LLMProvider, type LLMRequest } from './services/llm-provider.ts'

export type CompleteTextOptions = {
  /**
   * Maximum characters of assistant text to retain. The boundary delta is
   * sliced so `text.length <= maxCharacters`. Must be a positive safe integer
   * when present.
   */
  readonly maxCharacters?: number
  /** Wall-clock ceiling for the whole provider stream. */
  readonly timeout?: Duration.Input
}

export type CompleteTextResult = {
  readonly text: string
  readonly usage: AgentUsage
  readonly finishReason?: 'stop' | 'tool_use'
  readonly truncated: boolean
}

type CompleteTextState = {
  readonly text: string
  readonly usage: AgentUsage
  readonly finishReason: 'stop' | 'tool_use' | undefined
  readonly truncated: boolean
}

const initialCompleteTextState: CompleteTextState = {
  text: '',
  usage: zeroAgentUsage,
  finishReason: undefined,
  truncated: false
}

const appendBoundedText = (
  state: CompleteTextState,
  text: string,
  maxCharacters: number | undefined
): CompleteTextState => {
  if (maxCharacters === undefined) {
    return { ...state, text: `${state.text}${text}` }
  }

  const remaining = maxCharacters - state.text.length

  if (remaining <= 0) {
    return { ...state, truncated: true }
  }

  if (text.length <= remaining) {
    return { ...state, text: `${state.text}${text}` }
  }

  return { ...state, text: `${state.text}${text.slice(0, remaining)}`, truncated: true }
}

const applyCompleteTextEvent = (
  state: CompleteTextState,
  event: LLMEvent,
  maxCharacters: number | undefined
): CompleteTextState => {
  if (Predicate.isTagged(event, 'TextDelta')) {
    return appendBoundedText(state, event.text, maxCharacters)
  }

  if (Predicate.isTagged(event, 'Usage')) {
    return { ...state, usage: addAgentUsage(state.usage, event.usage) }
  }

  if (Predicate.isTagged(event, 'Done')) {
    return { ...state, finishReason: event.stopReason }
  }

  return state
}

/**
 * Run a bounded single-shot model call against the current `LLMProvider`.
 *
 * Concatenates only assistant text deltas, discarding reasoning and tool-call
 * events, and sums usage deltas. Provider max-token stops already surface as
 * a non-retryable `invalid_response` `LLMError` (never a `Done` event), so
 * they propagate through the error channel instead of `truncated`.
 *
 * Truncation semantics: when `maxCharacters` or `timeout` is hit, consumption
 * stops — finalizing the upstream provider stream so the in-flight request is
 * cancelled — and the text collected so far is returned with
 * `truncated: true`. `truncated` means output was cut, not merely that a
 * ceiling was configured: text that fits exactly is not truncated.
 */
export const completeText = (
  request: LLMRequest,
  options: CompleteTextOptions = {}
): Effect.Effect<CompleteTextResult, LLMProviderError, LLMProvider> =>
  Effect.gen(function* () {
    const maxCharacters = options.maxCharacters

    if (
      maxCharacters !== undefined &&
      (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0)
    ) {
      return yield* Effect.fail(
        new LLMError({
          cause: 'validation_error',
          message: 'completeText maxCharacters must be a positive safe integer',
          retryable: false
        })
      )
    }

    const provider = yield* LLMProvider
    const stateRef = yield* Ref.make(initialCompleteTextState)

    const consume = provider
      .stream(request)
      .pipe(
        Stream.runForEachWhile(event =>
          Ref.updateAndGet(stateRef, state =>
            applyCompleteTextEvent(state, event, maxCharacters)
          ).pipe(Effect.map(state => !state.truncated))
        )
      )

    if (options.timeout === undefined) {
      yield* consume
    } else {
      const completed = yield* Effect.timeoutOption(consume, options.timeout)

      if (Option.isNone(completed)) {
        yield* Ref.update(stateRef, state => ({ ...state, truncated: true }))
      }
    }

    const state = yield* Ref.get(stateRef)

    if (state.finishReason === undefined) {
      return { text: state.text, usage: state.usage, truncated: state.truncated }
    }

    return {
      text: state.text,
      usage: state.usage,
      finishReason: state.finishReason,
      truncated: state.truncated
    }
  })
