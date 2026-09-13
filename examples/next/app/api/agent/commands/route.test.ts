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

  it('omits absent summary fields and keeps hints after description', () => {
    const omitted = commandSummary({
      name: 'review',
      template: 'Review',
      hints: command.hints
    })

    expect(Object.keys(omitted)).toEqual(['name', 'hints'])
    expect(JSON.stringify(omitted)).toBe('{"name":"review","hints":["$ARGUMENTS"]}')
    expect(omitted.hints).toBe(command.hints)

    const present = commandSummary({
      name: 'review',
      description: 'Review changes',
      template: 'Review $ARGUMENTS',
      hints: command.hints,
      arguments: command.arguments,
      access: 'read',
      fileRefs: false
    })

    expect(Object.keys(present)).toEqual([
      'name',
      'description',
      'hints',
      'arguments',
      'access',
      'fileRefs'
    ])
    expect(JSON.stringify(present)).toBe(
      '{"name":"review","description":"Review changes","hints":["$ARGUMENTS"],"arguments":[{"name":"path","required":true}],"access":"read","fileRefs":false}'
    )
    expect(present.hints).toBe(command.hints)
    expect(present.arguments).toBe(command.arguments)
  })
})
