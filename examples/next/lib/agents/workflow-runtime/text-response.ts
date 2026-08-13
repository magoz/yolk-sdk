import { Clock, Config, Effect, Layer, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import {
  ToolError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type ToolExecutor
} from '@yolk-sdk/agent/loop'
import {
  makeNonRecursiveSubagentToolModule,
  makeSubagentToolResult,
  makeToolExecutorLayer,
  subagentResultFromEvents,
  subagentToolRunId,
  type SubagentDefinition,
  type SubagentRunError,
  type SubagentRunResult,
  type SubagentToolResultInput,
  type ToolModule
} from '@yolk-sdk/agent/tools'
import { formatAvailableSkills, type MergedSkillset } from '@yolk-sdk/agent/skillset'
import {
  UserMessage,
  type AgentEvent,
  type AgentModelCapabilities,
  type AgentReasoningEffort,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import { makeAgentRuntimeLayerWithTools } from '@/lib/agents/runtime-layer'
import { runRuntime, runtimeErrorToAgentError } from '@yolk-sdk/agent/runtime'
import { defaultAgentSystemPrompt } from '@/lib/agents/agent-prompts'
import {
  agentTextCapabilities,
  agentTextModel,
  agentTextModelMaxOutputTokens,
  agentTextModelProvider,
  agentTextReasoningEffort,
  isAgentTextModel,
  type AgentTextModel
} from '@/lib/agents/text-agent-config'
import { getValidAnthropicClaudeToken } from '@/lib/core/agent/anthropic-claude-auth'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { anthropicClaudeProviderId } from '@yolk-sdk/agent/providers/anthropic/claude'
import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/agent/providers/anthropic/claude-provider'
import { openAiCodexProviderId } from '@yolk-sdk/agent/providers/openai/codex'
import { makeOpenAiCodexProviderLayer } from '@yolk-sdk/agent/providers/openai/codex-provider'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { loadRuntimeSkillset } from '@/lib/agents/skillset/project-source'
import { loadProjectMcpServers } from '@/lib/agents/mcp/file-source'
import { makeTextToolModules, resolveAgentToolSet } from '@/lib/agents/tools/registry'
import {
  makeSkillManagerToolModule,
  type SkillManagerAction
} from '@/lib/agents/tools/skill-manager-tool'
import { makeAppStorageKnowledgeSearchToolModule } from '@/lib/agents/tools/storage-tool-handlers'
import { makeAppKnowledgeToolModule } from '@/lib/agents/tools/knowledge-tool-handlers'
import { makeAppTelegramToolModule } from '@/lib/agents/tools/telegram-tool'
import { getTelegramConnectorConfig } from '@/lib/core/agent/telegram-connector'
import type { AgentToolContext } from '@/lib/agents/tools/tool-context'
import {
  createAgentSkillWithCommand,
  listAgentSkills,
  updateAgentSkillWithCommand
} from '@/lib/core/agent/agent-skill'
import { getPinnedKnowledgeContext } from '@/lib/core/knowledge/get-pinned-knowledge-context'
import { Db } from '@/lib/services/db/live-layer'
import { KnowledgeLayer } from '@/lib/services/knowledge/live-layer'

type AgentTextRuntimeConfig = {
  readonly model: string
  readonly reasoningEffort: AgentReasoningEffort
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly capabilities: AgentModelCapabilities
}

type AgentTextRuntimeLayer = Layer.Layer<
  ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
>

type AgentTextRuntime = {
  readonly input: AgentRouteRequest
  readonly config: AgentTextRuntimeConfig
  readonly layer: AgentTextRuntimeLayer
}

const agentTextSubagents: ReadonlyArray<SubagentDefinition> = [
  {
    name: 'general',
    description:
      'General-purpose agent for researching complex questions and executing multi-step tasks.'
  },
  {
    name: 'explore',
    description:
      'Fast agent specialized for focused exploration. Ask for quick, medium, or very thorough exploration.'
  }
]

const subagentPrompt = (input: {
  readonly subagentType: string
  readonly baseSystemPrompt: string
}) =>
  [
    input.baseSystemPrompt,
    `You are a ${input.subagentType} subagent launched by the main Yolk agent.`,
    'Work autonomously on the delegated task. Return only your final concise findings.',
    'You cannot launch further subagents in v1. Use your normal tools when useful.'
  ].join('\n\n')

const toolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({ tool: 'subagent', message, cause })

const toolRegistryErrorToToolError = (error: { readonly message: string }) =>
  toolError(error.message, 'execution')

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const subagentRunErrorFromUnknown = (error: unknown): SubagentRunError => {
  if (error instanceof ToolError) {
    return runtimeErrorToAgentError(error)
  }

  return {
    code: 'unknown',
    message: unknownToMessage(error),
    retryable: false
  }
}

type SubagentResultToolResultInput = Omit<
  SubagentToolResultInput,
  'output' | 'usage' | 'turns' | 'status' | 'requests' | 'error' | 'isError'
>

type SubagentFailureToolResultInput = SubagentResultToolResultInput & {
  readonly error: unknown
}

type SubagentCompletedToolResultInput = SubagentResultToolResultInput & {
  readonly result: SubagentRunResult
}

export const makeSubagentFailureToolResult = (input: SubagentFailureToolResultInput) => {
  const error = subagentRunErrorFromUnknown(input.error)

  return makeSubagentToolResult({
    ...input,
    output: `Subagent failed: ${error.message}`,
    error
  })
}

export const makeCompletedSubagentToolResult = (input: SubagentCompletedToolResultInput) =>
  makeSubagentToolResult({
    ...input,
    output: input.result.text,
    status: input.result.status,
    usage: input.result.usage,
    turns: input.result.turns,
    requests: input.result.requests,
    error: input.result.error
  })

export const collectSubagentEvents = (
  stream: Stream.Stream<AgentEvent, Parameters<typeof runtimeErrorToAgentError>[0], never>
) => {
  const events: Array<AgentEvent> = []

  return stream.pipe(
    Stream.runForEach(event =>
      Effect.sync(() => {
        events.push(event)
      })
    ),
    Effect.catch(error =>
      Effect.sync(() => {
        events.push(runtimeErrorToAgentError(error))
      })
    ),
    Effect.map((): ReadonlyArray<AgentEvent> => events)
  )
}

const getAgentTextConfig = () =>
  Effect.gen(function* () {
    const systemPrompt = yield* Config.option(Config.string('AGENT_SYSTEM_PROMPT'))

    return {
      model: agentTextModel,
      reasoningEffort: agentTextReasoningEffort,
      systemPrompt: systemPrompt._tag === 'Some' ? systemPrompt.value : defaultAgentSystemPrompt
    }
  })

const appendAvailableSkills = (systemPrompt: string, skillset: MergedSkillset) => {
  const availableSkills = formatAvailableSkills(skillset.skills)

  return availableSkills.length === 0 ? systemPrompt : `${systemPrompt}\n\n${availableSkills}`
}

const appendPinnedKnowledge = (systemPrompt: string, pinnedKnowledge: string) =>
  pinnedKnowledge.trim().length === 0 ? systemPrompt : `${systemPrompt}\n\n${pinnedKnowledge}`

const providerLayerForModel = (model: AgentTextModel, userId: string) =>
  Effect.gen(function* () {
    switch (agentTextModelProvider(model)) {
      case 'anthropic-claude': {
        const token = yield* getValidAnthropicClaudeToken(userId)
        return makeAnthropicClaudeProviderLayer({
          token: new OAuthAccessToken({
            provider: anthropicClaudeProviderId,
            accessToken: token.access,
            expiresAt: token.expires
          }),
          maxTokens: agentTextModelMaxOutputTokens(model)
        }).pipe(Layer.provide(FetchHttpClient.layer))
      }
      case 'openai-codex': {
        const token = yield* getValidOpenAiCodexToken(userId)
        return makeOpenAiCodexProviderLayer({
          token: new OAuthAccessToken({
            provider: openAiCodexProviderId,
            accessToken: token.access,
            expiresAt: token.expires,
            accountId: token.accountId
          })
        }).pipe(Layer.provide(FetchHttpClient.layer))
      }
    }
  })

const SkillManagerLayer = Db.layer

const skillSummary = (skill: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
}) => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  enabled: skill.enabled
})

const findSkillForUpdate = (input: {
  readonly userId: string
  readonly id?: string
  readonly name?: string
}) =>
  Effect.gen(function* () {
    if (input.id === undefined && input.name === undefined) {
      return yield* Effect.fail(
        new ToolError({
          tool: 'manage_skills',
          message: 'update requires id or name',
          cause: 'validation'
        })
      )
    }

    const skills = yield* listAgentSkills({ userId: input.userId })
    const skill = skills.find(item => item.id === input.id || item.name === input.name)

    if (skill === undefined) {
      return yield* Effect.fail(
        new ToolError({
          tool: 'manage_skills',
          message: `Skill not found: ${input.id ?? input.name ?? 'unknown'}`,
          cause: 'not_found'
        })
      )
    }

    return skill
  })

const manageSkillsForAgent = (action: SkillManagerAction) =>
  Effect.gen(function* () {
    switch (action._tag) {
      case 'List': {
        yield* Effect.annotateCurrentSpan({
          'tool.manage_skills.action': 'list',
          'user.id': action.userId
        })
        const skills = yield* listAgentSkills({ userId: action.userId })
        const data = { skills: skills.map(skillSummary) }

        return {
          message:
            skills.length === 0
              ? 'No saved skills.'
              : `Saved skills:\n${skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`,
          data
        }
      }
      case 'Create': {
        yield* Effect.annotateCurrentSpan({
          'tool.manage_skills.action': 'create',
          'user.id': action.userId,
          'agent_skill.name': action.name,
          'agent_skill.create_command': action.createCommand,
          'agent_command.name': action.commandName ?? action.name
        })
        const skill = yield* createAgentSkillWithCommand({
          userId: action.userId,
          name: action.name,
          description: action.description,
          content: action.content,
          commandInput: action.createCommand
            ? {
                _tag: 'CreateCommand',
                command: {
                  name: action.commandName ?? action.name,
                  description: action.description,
                  template: `Use the ${action.name} skill.\n\n$ARGUMENTS`
                }
              }
            : { _tag: 'SkipCommand' }
        })

        return {
          message: `Created skill: ${skill.name}`,
          data: {
            skill: skillSummary(skill),
            commandName: action.createCommand ? (action.commandName ?? skill.name) : undefined
          }
        }
      }
      case 'Update': {
        const existing = yield* findSkillForUpdate({
          userId: action.userId,
          id: action.id,
          name: action.name
        })
        const skillName = action.name ?? existing.name
        yield* Effect.annotateCurrentSpan({
          'tool.manage_skills.action': 'update',
          'user.id': action.userId,
          'agent_skill.id': existing.id,
          'agent_skill.name': skillName,
          'agent_skill.create_command': action.createCommand,
          'agent_command.name': action.commandName ?? skillName
        })
        const skill = yield* updateAgentSkillWithCommand({
          id: existing.id,
          userId: action.userId,
          name: skillName,
          description: action.description,
          content: action.content,
          enabled: action.enabled ?? true,
          commandInput: action.createCommand
            ? {
                _tag: 'CreateCommand',
                command: {
                  name: action.commandName ?? skillName,
                  description: action.description,
                  template: `Use the ${skillName} skill.\n\n$ARGUMENTS`
                }
              }
            : { _tag: 'SkipCommand' }
        })

        return {
          message: `Updated skill: ${skill.name}`,
          data: {
            skill: skillSummary(skill),
            commandName: action.createCommand ? (action.commandName ?? skill.name) : undefined
          }
        }
      }
    }
  }).pipe(
    Effect.withSpan('tool.manageSkills'),
    Effect.provide(SkillManagerLayer),
    Effect.mapError(error =>
      error instanceof ToolError
        ? error
        : new ToolError({
            tool: 'manage_skills',
            message: unknownToMessage(error),
            cause: 'execution'
          })
    )
  )

export const makeAgentTextRuntime = (
  input: AgentRouteRequest,
  userId: string,
  route: '/agent/next' | '/agent/workflow'
) =>
  Effect.gen(function* () {
    const baseConfig = yield* getAgentTextConfig()
    const skillset = yield* loadRuntimeSkillset({ userId })
    const mcpServers = yield* loadProjectMcpServers()
    const baseToolModules = yield* makeTextToolModules(mcpServers)
    const pinnedKnowledge = yield* getPinnedKnowledgeContext({ userId }).pipe(
      Effect.provide(KnowledgeLayer),
      Effect.catch(error =>
        Effect.logWarning('Pinned knowledge unavailable', { error }).pipe(Effect.as(''))
      )
    )
    const storageToolModule = makeAppStorageKnowledgeSearchToolModule()
    const knowledgeToolModule = makeAppKnowledgeToolModule()
    const telegramConnectorConfig = yield* getTelegramConnectorConfig(userId)
    const telegramToolModules =
      telegramConnectorConfig === undefined
        ? []
        : [makeAppTelegramToolModule(telegramConnectorConfig)]
    const skillManagerToolModule = makeSkillManagerToolModule(manageSkillsForAgent)
    const subagentToolModules: ReadonlyArray<ToolModule<AgentToolContext>> = [
      ...baseToolModules,
      knowledgeToolModule,
      storageToolModule,
      ...telegramToolModules
    ]
    const selectedModel = input.model ?? baseConfig.model
    const model = isAgentTextModel(selectedModel) ? selectedModel : agentTextModel
    const providerLayer = yield* providerLayerForModel(model, userId)
    const baseSystemPrompt = appendPinnedKnowledge(
      appendAvailableSkills(baseConfig.systemPrompt, skillset),
      pinnedKnowledge
    )
    const subagentToolModule = makeNonRecursiveSubagentToolModule<AgentToolContext>({
      subagents: agentTextSubagents,
      execute: ({ call, context, params }) =>
        Effect.gen(function* () {
          const startedAtMs = yield* Clock.currentTimeMillis
          const subagentRunId = subagentToolRunId(call.id)

          return yield* Effect.gen(function* () {
            const subagentToolSet = yield* resolveAgentToolSet({
              modules: subagentToolModules,
              context: {
                ...context,
                sessionId: `${context.sessionId ?? input.sessionId}:subagent:${call.id}`,
                subagent: true
              }
            }).pipe(Effect.mapError(toolRegistryErrorToToolError))
            const reasoningEffort = input.reasoningEffort ?? baseConfig.reasoningEffort
            const events = yield* collectSubagentEvents(
              runRuntime(
                {
                  _tag: 'Transcript',
                  sessionId: `${input.sessionId}:subagent:${call.id}`,
                  messages: [UserMessage.make({ content: params.prompt })]
                },
                {
                  systemPrompt: subagentPrompt({
                    subagentType: params.subagent_type,
                    baseSystemPrompt
                  }),
                  tools: subagentToolSet.tools,
                  reasoningEffort,
                  capabilities: agentTextCapabilities,
                  model
                }
              ).pipe(
                Stream.provide(
                  makeAgentRuntimeLayerWithTools(
                    providerLayer,
                    makeToolExecutorLayer(subagentToolSet)
                  )
                )
              )
            )
            const summary = subagentResultFromEvents(events)
            const endedAtMs = yield* Clock.currentTimeMillis

            return makeCompletedSubagentToolResult({
              callId: call.id,
              subagentType: params.subagent_type,
              description: params.description,
              subagentRunId,
              startedAtMs,
              endedAtMs,
              model,
              reasoningEffort,
              result: summary
            })
          }).pipe(
            Effect.catch(error =>
              Clock.currentTimeMillis.pipe(
                Effect.map(endedAtMs =>
                  makeSubagentFailureToolResult({
                    callId: call.id,
                    subagentType: params.subagent_type,
                    description: params.description,
                    subagentRunId,
                    startedAtMs,
                    endedAtMs,
                    model,
                    reasoningEffort: input.reasoningEffort ?? baseConfig.reasoningEffort,
                    error
                  })
                )
              )
            )
          )
        })
    })
    const toolModules: ReadonlyArray<ToolModule<AgentToolContext>> = [
      ...subagentToolModules,
      skillManagerToolModule,
      subagentToolModule
    ]
    const toolSet = yield* resolveAgentToolSet({
      modules: toolModules,
      context: {
        surface: 'text',
        route,
        userId,
        sessionId: input.sessionId,
        skillset
      }
    })
    const normalizedInput = new AgentRouteRequest({ ...input, model })
    const config: AgentTextRuntimeConfig = {
      ...baseConfig,
      model,
      systemPrompt: baseSystemPrompt,
      tools: toolSet.tools,
      capabilities: agentTextCapabilities
    }

    const runtime: AgentTextRuntime = {
      input: normalizedInput,
      config,
      layer: makeAgentRuntimeLayerWithTools(providerLayer, makeToolExecutorLayer(toolSet))
    }

    return runtime
  })

export const makeAgentTextResponse = (
  input: AgentRouteRequest,
  userId: string,
  route: '/agent/next' | '/agent/workflow'
) =>
  Effect.gen(function* () {
    const runtime = yield* makeAgentTextRuntime(input, userId, route)

    return yield* makeAgentPostResponse(runtime.input, runtime.config).pipe(
      Effect.provide(runtime.layer)
    )
  })
