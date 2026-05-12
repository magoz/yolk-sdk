import { describe, expect, it } from '@effect/vitest'
import { AgentInputUsage, AgentOutputUsage, AgentUsage, ImagePart, TextPart } from '@yolk/protocol'
import { agentTextContextBudget, contextBudgetStatus } from '@/lib/agents/context-budget'
import {
  formatContextPercent,
  formatTokenCount,
  formatUsageDetail,
  formatUsageSummary,
  totalAgentUsageTokens
} from './agent-usage-meter'
import { contentFromInput, type ImageAttachment } from './image-attachment-content'
import { canSaveEditedMessage, editDraftText, editKeyAction } from './message-edit-model'

const imageAttachment: ImageAttachment = {
  id: 'image-1',
  name: 'image.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,abc',
  data: 'abc'
}

const secondImageAttachment: ImageAttachment = {
  id: 'image-2',
  name: 'image-2.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,def',
  data: 'def'
}

const usage = AgentUsage.make({
  input: AgentInputUsage.make({ total: 1_200, cacheRead: 300 }),
  output: AgentOutputUsage.make({ total: 450, reasoning: 50 })
})

describe('agent playground', () => {
  it('builds text-only submit content', () => {
    expect(contentFromInput(' hello ', [])).toBe('hello')
  })

  it('builds multipart image submit content', () => {
    expect(contentFromInput(' describe ', [imageAttachment])).toEqual([
      TextPart.make({ text: 'describe' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })

  it('builds image-only submit content', () => {
    expect(contentFromInput('   ', [imageAttachment])).toEqual([
      ImagePart.make({ data: 'abc', mimeType: 'image/png' })
    ])
  })

  it('builds multi-image submit content', () => {
    expect(contentFromInput(' compare ', [imageAttachment, secondImageAttachment])).toEqual([
      TextPart.make({ text: 'compare' }),
      ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
      ImagePart.make({ data: 'def', mimeType: 'image/png' })
    ])
  })

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_200)).toBe('1.2k')
    expect(formatTokenCount(12_300)).toBe('12k')
    expect(formatTokenCount(1_250_000)).toBe('1.3m')
  })

  it('formats usage totals and details', () => {
    expect(totalAgentUsageTokens(usage)).toBe(1_650)
    expect(formatUsageSummary(usage)).toBe('1.7k tokens')
    expect(formatUsageDetail(usage)).toBe('in 1.2k · out 450 · reasoning 50 · cached 300')
  })

  it('formats context budget progress', () => {
    expect(
      formatContextPercent(agentTextContextBudget.warningInputTokens, agentTextContextBudget)
    ).toBe('80%')
    expect(contextBudgetStatus(1, agentTextContextBudget)).toBe('normal')
    expect(
      contextBudgetStatus(agentTextContextBudget.warningInputTokens, agentTextContextBudget)
    ).toBe('warning')
    expect(
      contextBudgetStatus(agentTextContextBudget.compactionInputTokens, agentTextContextBudget)
    ).toBe('compact')
  })

  it('models message edit shortcuts', () => {
    expect(editKeyAction({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false })).toBe(
      'save'
    )
    expect(editKeyAction({ key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false })).toBe(
      'none'
    )
    expect(editKeyAction({ key: 'Escape', shiftKey: false, metaKey: false, ctrlKey: false })).toBe(
      'cancel'
    )
  })

  it('models message edit save state', () => {
    expect(editDraftText(' updated ')).toBe('updated')
    expect(canSaveEditedMessage({ currentText: 'hello', draftText: ' hello ', disabled: false })).toBe(
      false
    )
    expect(canSaveEditedMessage({ currentText: 'hello', draftText: 'updated', disabled: false })).toBe(
      true
    )
    expect(canSaveEditedMessage({ currentText: 'hello', draftText: '   ', disabled: false })).toBe(
      false
    )
    expect(canSaveEditedMessage({ currentText: 'hello', draftText: 'updated', disabled: true })).toBe(
      false
    )
  })
})
