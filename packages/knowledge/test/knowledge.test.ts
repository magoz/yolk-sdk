import { describe, expect, it } from 'vitest'
import { DateTime } from 'effect'
import { buildKnowledgeContext } from '../src/context.ts'
import type { KnowledgeDocument } from '../src/documents.ts'

const now = DateTime.nowUnsafe()

const document: KnowledgeDocument = {
  id: 'knowledge_1',
  slug: 'big.vision',
  title: 'Big vision',
  purpose: 'Guide product work.',
  origin: 'manual note',
  content: 'Build an agent-native knowledge substrate.',
  status: 'ready',
  availability: 'pinned',
  summary: 'Build an agent-native knowledge substrate.',
  metadata: {},
  createdAt: now,
  updatedAt: now
}

describe('knowledge context', () => {
  it('formats pinned documents for agent context', () => {
    const context = buildKnowledgeContext({ documents: [document], maxCharacters: 1000 })

    expect(context).toContain('# Pinned knowledge')
    expect(context).toContain('## Big vision')
    expect(context).toContain('slug: big.vision')
    expect(context).toContain('Build an agent-native knowledge substrate.')
  })

  it('respects max character budget', () => {
    const context = buildKnowledgeContext({ documents: [document], maxCharacters: 80 })

    expect(context.length).toBeLessThanOrEqual(80)
    expect(context).toContain('[truncated: pinned knowledge exceeded context budget]')
  })
})
