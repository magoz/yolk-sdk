import { describe, expect, it } from 'vitest'
import { DateTime } from 'effect'
import { buildKnowledgeContext } from '../src/context.ts'
import type { KnowledgeRecord } from '../src/records.ts'

const now = DateTime.nowUnsafe()

const record: KnowledgeRecord = {
  id: 'knowledge_1',
  role: 'operating_protocol',
  title: 'Big vision',
  status: 'ready',
  contextPolicy: 'pinned',
  summary: 'Build an agent-native knowledge substrate.',
  metadata: {},
  createdAt: now,
  updatedAt: now
}

describe('knowledge context', () => {
  it('formats pinned records for agent context', () => {
    const context = buildKnowledgeContext({ items: [{ record }], maxCharacters: 1000 })

    expect(context).toContain('# Pinned knowledge')
    expect(context).toContain('## Big vision')
    expect(context).toContain('Build an agent-native knowledge substrate.')
  })

  it('respects max character budget', () => {
    const context = buildKnowledgeContext({ items: [{ record }], maxCharacters: 80 })

    expect(context.length).toBeLessThanOrEqual(80)
    expect(context).toContain('[truncated: pinned knowledge exceeded context budget]')
  })
})
