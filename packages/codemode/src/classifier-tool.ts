import { Effect, Predicate, Semaphore } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ClassificationResult,
  ClassifierQuestions,
  ClassifierState,
  type ClassificationError,
  type ClassificationRequest,
  type ClassificationUsage,
  type ClassifierModel
} from '@yolk-sdk/agent/classification'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  ToolResult,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  modelVisibleToolError,
  modelVisibleToolErrorStructuredContent,
  type ModelVisibleToolErrorReason,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'

/** Default name of the classifier tool. */
export const classifierToolName = 'classify'

/** Default cap of concurrent classifications per script. */
export const defaultClassifierToolMaxConcurrency = 4

type ClassifierModelService = (typeof ClassifierModel)['Service']

type Classify = ClassifierModelService['classify']

export type MakeClassifierToolOptions = {
  /** `ClassifierModel`'s `classify`, or the service value itself. */
  readonly classify: Classify | ClassifierModelService
  /** Default `classify`. */
  readonly name?: string
  /** Concurrent classifications per script (keyed by the parent tool call id of the nested call
   * id `<parentToolCallId>/<seq>`, or the call id itself); default 4.
   */
  readonly maxConcurrency?: number
  readonly description?: string
}

/** The classifier tool's input: one state and its named questions. Provider options stay
 * host-owned and are never taken from scripts.
 */
export const ClassifierToolParams = Schema.Struct({
  state: ClassifierState,
  questions: ClassifierQuestions
})

const defaultDescription = (maxConcurrency: number) =>
  [
    'Classify one item with a classifier model: answer named typed questions about one `state` (a string, JSON object, or JSON array) with probabilities.',
    'Question types: `boolean` (`probability` of true), `choice` (one of the `criteria` keys, with `probabilities`), and `score` (an ordinal level from the `criteria` list, lowest first).',
    `Call it once per item; at most ${maxConcurrency} classifications of one script run at once and further calls queue.`
  ].join(' ')

/** Token usage of a classification as agent usage. `costUsd` has no agent usage field; it stays
 * in the result's `structuredContent.usage`, so nested-call records carry token usage only.
 */
const agentUsage = (usage: ClassificationUsage): AgentUsage =>
  AgentUsage.make({
    input: AgentInputUsage.make({ total: usage.inputTokens }),
    output: AgentOutputUsage.make({ total: usage.outputTokens })
  })

const errorReason = (error: ClassificationError): ModelVisibleToolErrorReason =>
  Predicate.isTagged(error, 'ClassificationRequestInvalid') ? 'invalid_input' : 'unavailable'

const billedUsage = (error: ClassificationError) =>
  Predicate.isTagged(error, 'ClassificationResponseInvalid') ? error.usage : undefined

/** The parent tool call id of a nested call id `<parentToolCallId>/<seq>`, else the id itself. */
const scriptKey = (call: ToolCall) => {
  const separator = call.id.lastIndexOf('/')

  return separator > 0 ? call.id.slice(0, separator) : call.id
}

type ResultFields = {
  toolCallId: string
  content: string
  isError?: boolean
  structuredContent: unknown
  usage?: AgentUsage
}

const withUsage = (fields: ResultFields, usage: ClassificationUsage | undefined) => {
  if (usage !== undefined) {
    fields.usage = agentUsage(usage)
  }

  return ToolResult.make(fields)
}

const successResult = (call: ToolCall, result: ClassificationResult) =>
  withUsage(
    { toolCallId: call.id, content: JSON.stringify(result.answers), structuredContent: result },
    result.usage
  )

const errorResult = (call: ToolCall, name: string, error: ClassificationError) =>
  withUsage(
    {
      toolCallId: call.id,
      content: error.message,
      isError: true,
      structuredContent: modelVisibleToolErrorStructuredContent(
        modelVisibleToolError({ tool: name, reason: errorReason(error), message: error.message })
      )
    },
    billedUsage(error)
  )

/**
 * A code-mode-only (`callableBy: 'codemode'`, `discovery: 'listed'`) read tool that classifies one
 * item per call with a classifier model. Its content is the compact JSON of the answers, its
 * `structuredContent` the full `ClassificationResult` (which nested calls resolve to), and its
 * token usage is reported on `ToolResult.usage`. Classifier errors become model-visible error
 * results; usage billed before a response error is kept.
 */
export const makeClassifierTool = <Context>(
  options: MakeClassifierToolOptions
): ToolRegistration<Context> => {
  const name = options.name ?? classifierToolName

  const maxConcurrency = Math.max(
    1,
    Math.floor(options.maxConcurrency ?? defaultClassifierToolMaxConcurrency)
  )

  const classify = Predicate.isFunction(options.classify)
    ? options.classify
    : options.classify.classify

  // One semaphore per script (parent tool call), removed when its last classification ends.
  const scripts = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const withScriptPermit = <A, E>(call: ToolCall, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const key = scriptKey(call)

        const entry = scripts.get(key) ?? {
          semaphore: Semaphore.makeUnsafe(maxConcurrency),
          users: 0
        }

        entry.users++
        scripts.set(key, entry)

        return { key, entry }
      }),
      ({ entry }) => entry.semaphore.withPermits(1)(effect),
      ({ key, entry }) =>
        Effect.sync(() => {
          entry.users--

          if (entry.users === 0 && scripts.get(key) === entry) scripts.delete(key)
        })
    )

  return makeTool<Context, typeof ClassifierToolParams>({
    name,
    description: options.description ?? defaultDescription(maxConcurrency),
    parameters: ClassifierToolParams,
    output: ClassificationResult,
    access: 'read',
    callableBy: 'codemode',
    discovery: 'listed',
    execute: ({ call, params }) => {
      const request: ClassificationRequest = { state: params.state, questions: params.questions }

      return withScriptPermit(call, classify(request)).pipe(
        Effect.map(result => successResult(call, result)),
        Effect.catch(error => Effect.succeed(errorResult(call, name, error)))
      )
    }
  })
}
