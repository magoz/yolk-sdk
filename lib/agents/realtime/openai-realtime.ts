import type { ToolDef } from '@yolk/protocol'

export type OpenAiRealtimeVoice = 'marin' | 'cedar'
export type OpenAiRealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type OpenAiRealtimeFunctionTool = {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export type OpenAiRealtimeSessionConfig = {
  readonly type: 'realtime'
  readonly model: string
  readonly output_modalities: ReadonlyArray<'audio'>
  readonly audio: {
    readonly input: {
      readonly turn_detection: {
        readonly type: 'semantic_vad'
      }
    }
    readonly output: {
      readonly voice: OpenAiRealtimeVoice
    }
  }
  readonly instructions: string
  readonly tools: ReadonlyArray<OpenAiRealtimeFunctionTool>
  readonly tool_choice: 'auto'
  readonly reasoning: {
    readonly effort: OpenAiRealtimeReasoningEffort
  }
}

export type OpenAiRealtimeSessionConfigInput = {
  readonly instructions: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model?: string
  readonly voice?: OpenAiRealtimeVoice
  readonly reasoningEffort?: OpenAiRealtimeReasoningEffort
}

export const openAiRealtimeModel = 'gpt-realtime-2'
export const defaultOpenAiRealtimeVoice: OpenAiRealtimeVoice = 'marin'
export const defaultOpenAiRealtimeReasoningEffort: OpenAiRealtimeReasoningEffort = 'low'

export const toOpenAiRealtimeTool = (tool: ToolDef): OpenAiRealtimeFunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
})

export const makeOpenAiRealtimeSessionConfig = ({
  instructions,
  tools,
  model = openAiRealtimeModel,
  voice = defaultOpenAiRealtimeVoice,
  reasoningEffort = defaultOpenAiRealtimeReasoningEffort
}: OpenAiRealtimeSessionConfigInput): OpenAiRealtimeSessionConfig => ({
  type: 'realtime',
  model,
  output_modalities: ['audio'],
  audio: {
    input: {
      turn_detection: {
        type: 'semantic_vad'
      }
    },
    output: {
      voice
    }
  },
  instructions,
  tools: tools.map(toOpenAiRealtimeTool),
  tool_choice: 'auto',
  reasoning: {
    effort: reasoningEffort
  }
})
