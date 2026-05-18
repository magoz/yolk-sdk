const joinPromptSections = (sections: ReadonlyArray<string>) =>
  sections.filter(section => section.trim().length > 0).join('\n')

export const baseAgentSystemPrompt = [
  'You are Yolk assistant. Be concise and practical.',
  'You have access to tools and they run in parallel.',
  'If unsure what the user refers to, use the storage tools to proactively infer what the user is referring to.'
].join('\n')

export const textAgentSystemPromptAddendum = ''
export const voiceAgentSystemPromptAddendum = 'Respond naturally for spoken conversation.'

export const defaultAgentSystemPrompt = joinPromptSections([
  baseAgentSystemPrompt,
  textAgentSystemPromptAddendum
])

export const defaultVoiceAgentSystemPrompt = joinPromptSections([
  baseAgentSystemPrompt,
  voiceAgentSystemPromptAddendum
])
