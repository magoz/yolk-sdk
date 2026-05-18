import type { KnowledgeScope } from './objects.ts'

export type ResolveKnowledgeScope<Context> = (context: Context) => KnowledgeScope

export type KnowledgeAgentContextOptions = {
  readonly maxPinnedContextCharacters: number
}

export const defaultKnowledgeAgentContextOptions: KnowledgeAgentContextOptions = {
  maxPinnedContextCharacters: 6000
}
