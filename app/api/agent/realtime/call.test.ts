import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync('app/api/agent/realtime/call/route.ts', 'utf8')

describe('realtime call route wiring', () => {
  it('uses the shared voice prompt', () => {
    expect(source).toContain("import { defaultVoiceAgentSystemPrompt } from '@/lib/agents/agent-prompts'")
    expect(source).toContain('const realtimeInstructions = defaultVoiceAgentSystemPrompt')
  })

  it('adds storage tools to the voice toolset', () => {
    expect(source).toContain("import { makeAppStorageRagToolModule } from '@/lib/agents/tools/storage-tool-handlers'")
    expect(source).toContain('modules: [...nodeVoiceToolModules, makeAppStorageRagToolModule()]')
  })
})
