import { describe, expect, it } from '@effect/vitest'
import type { CommandInfo } from '@yolk-sdk/agent/skillset'
import { commandSummary, renderCommandResponse } from './route-model'

const command: CommandInfo = {
  name: 'review',
  description: 'Review changes',
  template: 'Review $ARGUMENTS',
  hints: ['$ARGUMENTS'],
  arguments: [{ name: 'path', required: true }],
  access: 'read',
  fileRefs: true
}

describe('agent command route model', () => {
  it('summarizes commands for UI lists', () => {
    expect(commandSummary(command)).toEqual({
      name: 'review',
      description: 'Review changes',
      hints: ['$ARGUMENTS'],
      arguments: [{ name: 'path', required: true }],
      access: 'read',
      fileRefs: true
    })
  })

  it('renders command responses', () => {
    expect(renderCommandResponse(command, 'app/agent')).toEqual({ content: 'Review app/agent' })
  })
})
