import { describe, expect, it } from '@effect/vitest'
import {
  baseAgentSystemPrompt,
  defaultAgentSystemPrompt,
  defaultVoiceAgentSystemPrompt,
  textAgentSystemPromptAddendum,
  voiceAgentSystemPromptAddendum
} from './agent-prompts'

describe('agent prompts', () => {
  it('keeps text prompt sourced from the shared base prompt', () => {
    expect(defaultAgentSystemPrompt).toBe(baseAgentSystemPrompt)
    expect(textAgentSystemPromptAddendum).toBe('')
  })

  it('keeps voice prompt sourced from the shared base prompt with voice-only guidance', () => {
    expect(defaultVoiceAgentSystemPrompt).toBe(
      `${baseAgentSystemPrompt}\n${voiceAgentSystemPromptAddendum}`
    )
    expect(defaultVoiceAgentSystemPrompt).toContain(
      'If unsure what the user refers to, use search_knowledge for durable user knowledge and storage tools for uploaded storage sources.'
    )
    expect(defaultVoiceAgentSystemPrompt).toContain('Respond naturally for spoken conversation.')
  })
})
