import { Context } from 'effect'

// Private fiber-local dispatch boundary shared by tools and voice without a dependency cycle.
export const VoiceToolDispatch = Context.Reference<boolean>(
  '@yolk-sdk/agent/internal/VoiceToolDispatch',
  { defaultValue: () => false }
)

export const backgroundVoiceUnsupportedMessage =
  'Activated background-v1 tools are not supported in voice/realtime sessions.'
