import { renderCommand, type CommandInfo } from '@yolk-sdk/agent/skillset'

type CommandSummaryFields = {
  name: CommandInfo['name']
  description?: CommandInfo['description']
  arguments?: CommandInfo['arguments']
  access?: CommandInfo['access']
  fileRefs?: CommandInfo['fileRefs']
}

export const commandSummary = (command: CommandInfo) => {
  const fields: CommandSummaryFields = {
    name: command.name
  }

  if (command.description !== undefined) {
    fields.description = command.description
  }

  const summary = Object.assign(fields, { hints: command.hints })

  if (command.arguments !== undefined) {
    summary.arguments = command.arguments
  }

  if (command.access !== undefined) {
    summary.access = command.access
  }

  if (command.fileRefs !== undefined) {
    summary.fileRefs = command.fileRefs
  }

  return summary
}

export const renderCommandResponse = (command: CommandInfo, argumentsText: string) => ({
  content: renderCommand(command, argumentsText)
})
