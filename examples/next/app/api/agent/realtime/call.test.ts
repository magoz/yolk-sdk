import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync('examples/next/app/api/agent/realtime/call/route.ts', 'utf8')

describe('realtime call route wiring', () => {
  it('uses the shared voice prompt', () => {
    expect(source).toContain("import { defaultVoiceAgentSystemPrompt } from '@/lib/agents/agent-prompts'")
    expect(source).toContain('const realtimeInstructions = defaultVoiceAgentSystemPrompt')
  })

  it('adds knowledge, storage, and Telegram tools to the voice toolset', () => {
    expect(source).toContain("import { makeAppKnowledgeToolModule } from '@/lib/agents/tools/knowledge-tool-handlers'")
    expect(source).toContain("import { makeAppStorageKnowledgeSearchToolModule } from '@/lib/agents/tools/storage-tool-handlers'")
    expect(source).toContain("import { makeAppTelegramToolModule } from '@/lib/agents/tools/telegram-tool'")
    expect(source).toContain('...telegramToolModules')
  })
})
