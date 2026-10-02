import { Config, Data, Effect, Option, type Layer } from 'effect'
import { ClassifierModel } from '@yolk-sdk/agent/classification'
import { ToolDef } from '@yolk-sdk/agent/protocol'
import { VercelAiGatewayClassifierLayer } from '@yolk-sdk/agent/providers/vercel/ai-gateway-classifier'
import type { ToolModule, ToolRegistration } from '@yolk-sdk/agent/tools'
import { makeClassifierTool, makeCodeModeTool, type CodeModeExecutor } from '@yolk-sdk/codemode'
import { makePiCodeModeExecutor } from '@yolk-sdk/codemode/node'
import type { AgentToolContext } from '@/lib/agents/tools/tool-context'

export class AgentCodeModeConfigError extends Data.TaggedError('AgentCodeModeConfigError')<{
  readonly message: string
}> {}

/** Opt-in flag for code mode on the top-level text surface; absent or empty means off. */
export const agentCodeModeEnabled = Effect.gen(function* () {
  return yield* Config.Boolean('YOLK_CODEMODE').pipe(Config.withDefault(false))
}).pipe(
  Effect.mapError(
    () => new AgentCodeModeConfigError({ message: 'YOLK_CODEMODE must be a boolean flag' })
  )
)

/**
 * Tools scripts must never call (`callableBy: 'model'`), applied only while code mode is on:
 * outbound messages and persistent skill writes stay one deliberate model call each, `skill`
 * only loads instructions into the model context, and Workflow child lookups are intercepted by
 * the parent orchestrator (a nested call would only reach their stub) and poll.
 */
export const agentCodeModeModelOnlyTools: ReadonlySet<string> = new Set([
  'skill',
  'manage_skills',
  'telegram_send_message',
  'subagent_status',
  'subagent_wait'
])

// One executor per process: its concurrency cap is per executor.
const agentCodeModeExecutor = makePiCodeModeExecutor()

const modelOnly = (tool: ToolRegistration<AgentToolContext>): ToolRegistration<AgentToolContext> =>
  agentCodeModeModelOnlyTools.has(tool.def.name) && tool.def.callableBy === undefined
    ? { ...tool, def: ToolDef.make({ ...tool.def, callableBy: 'model' }) }
    : tool

const withModelOnlyExposure = (
  modules: ReadonlyArray<ToolModule<AgentToolContext>>
): ReadonlyArray<ToolModule<AgentToolContext>> =>
  modules.map(module => ({ ...module, tools: module.tools.map(modelOnly) }))

/** The AI Gateway classifier when `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is configured. */
const gatewayClassifier = (layer: Layer.Layer<ClassifierModel, unknown>) =>
  Effect.gen(function* () {
    return yield* ClassifierModel
  }).pipe(Effect.provide(layer), Effect.option)

export type AgentCodeModeOptions = {
  /** Default: the process-wide pi executor. */
  readonly executor?: CodeModeExecutor
  /** Default: the package AI Gateway classifier layer read from the environment. */
  readonly classifierLayer?: Layer.Layer<ClassifierModel, unknown>
}

/**
 * Adds code mode to the top-level text tool modules when `YOLK_CODEMODE` is on; returns the input
 * unchanged otherwise. Scripts run inside the tool call, so in Workflow they run in the tool-batch
 * step. No `deadline` is passed: the app sets no explicit function duration, so scripts use the
 * package default timeout (120 s). A `classify` tool is added only with AI Gateway credentials.
 */
export const withAgentCodeMode = (
  modules: ReadonlyArray<ToolModule<AgentToolContext>>,
  options: AgentCodeModeOptions = {}
) =>
  Effect.gen(function* () {
    const enabled = yield* agentCodeModeEnabled

    if (!enabled) return modules

    const codeModeModule: ToolModule<AgentToolContext> = {
      id: 'codemode',
      tools: [
        makeCodeModeTool<AgentToolContext>({
          executor: options.executor ?? agentCodeModeExecutor
        })
      ]
    }

    const classifier = yield* gatewayClassifier(
      options.classifierLayer ?? VercelAiGatewayClassifierLayer
    )

    const classifierModules: ReadonlyArray<ToolModule<AgentToolContext>> = Option.match(
      classifier,
      {
        onNone: () => [],
        onSome: model => [
          { id: 'classifier', tools: [makeClassifierTool<AgentToolContext>({ classify: model })] }
        ]
      }
    )

    return [...withModelOnlyExposure(modules), codeModeModule, ...classifierModules]
  })
