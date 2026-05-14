import { Config, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { makeToolExecutorLayer, type ResolvedToolSet } from '@yolk/tool-registry'
import { formatAvailableSkills, type MergedSkillset } from '@yolk/skillset'
import {
  type AgentModelCapabilities,
  type AgentReasoningEffort,
  type ToolDef
} from '@yolk/protocol'
import { makeAgentRuntimeLayerWithTools } from '@/lib/agents/runtime-layer'
import {
  agentTextCapabilities,
  agentTextModel,
  agentTextModelProvider,
  agentTextReasoningEffort,
  defaultAgentSystemPrompt,
  isAgentTextModel,
  type AgentTextModel
} from '@/lib/agents/text-agent-config'
import { getValidAnthropicClaudeToken } from '@/lib/core/agent/anthropic-claude-auth'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { makeAnthropicClaudeProviderLayer } from '@/lib/agents/providers/anthropic-claude-provider'
import { makeOpenAiCodexProviderLayer } from '@/lib/agents/providers/openai-codex-provider'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { loadProjectSkillset } from '@/lib/agents/skillset/project-source'
import { loadProjectMcpServers } from '@/lib/agents/mcp/file-source'
import { makeTextToolModules, resolveAgentToolSet } from '@/lib/agents/tools/registry'

type AgentTextRuntimeConfig = {
  readonly model: string
  readonly reasoningEffort: AgentReasoningEffort
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly capabilities: AgentModelCapabilities
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

const providerLayerForModel = (model: AgentTextModel, userId: string) =>
  Effect.gen(function* () {
    switch (agentTextModelProvider(model)) {
      case 'anthropic-claude': {
        const token = yield* getValidAnthropicClaudeToken(userId)
        return makeAnthropicClaudeProviderLayer({ token }).pipe(Layer.provide(FetchHttpClient.layer))
      }
      case 'openai-codex': {
        const token = yield* getValidOpenAiCodexToken(userId)
        return makeOpenAiCodexProviderLayer({ token }).pipe(Layer.provide(FetchHttpClient.layer))
      }
    }
  })

const makeAgentResponseWithProvider = (
  input: AgentRouteRequest,
  config: AgentTextRuntimeConfig,
  toolSet: ResolvedToolSet,
  userId: string
) =>
  Effect.gen(function* () {
    const selectedModel = input.model ?? config.model
    const model = isAgentTextModel(selectedModel) ? selectedModel : agentTextModel
    const providerLayer = yield* providerLayerForModel(model, userId)
    const normalizedInput = new AgentRouteRequest({ ...input, model })

    return yield* makeAgentPostResponse(normalizedInput, { ...config, model }).pipe(
      Effect.provide(makeAgentRuntimeLayerWithTools(providerLayer, makeToolExecutorLayer(toolSet)))
    )
  })

export const makeAgentTextResponse = (
  input: AgentRouteRequest,
  userId: string,
  route: '/agent/next' | '/agent/workflow'
) =>
  Effect.gen(function* () {
    const baseConfig = yield* getAgentTextConfig()
    const skillset = yield* loadProjectSkillset()
    const mcpServers = yield* loadProjectMcpServers()
    const toolModules = yield* makeTextToolModules(mcpServers)
    const toolSet = yield* resolveAgentToolSet({
      modules: toolModules,
      context: {
        surface: 'text',
        route,
        userId,
        skillset
      }
    })

    return yield* makeAgentResponseWithProvider(
      input,
      {
        ...baseConfig,
        systemPrompt: appendAvailableSkills(baseConfig.systemPrompt, skillset),
        tools: toolSet.tools,
        capabilities: agentTextCapabilities
      },
      toolSet,
      userId
    )
  })
