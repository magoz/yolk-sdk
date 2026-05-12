import { renderCommand, type CommandInfo } from '@yolk/skillset'

export const commandSummary = (command: CommandInfo) => ({
  name: command.name,
  ...(command.description === undefined ? {} : { description: command.description }),
  hints: command.hints,
  ...(command.arguments === undefined ? {} : { arguments: command.arguments }),
  ...(command.access === undefined ? {} : { access: command.access }),
  ...(command.fileRefs === undefined ? {} : { fileRefs: command.fileRefs })
})

export const renderCommandResponse = (command: CommandInfo, argumentsText: string) => ({
  content: renderCommand(command, argumentsText)
})
