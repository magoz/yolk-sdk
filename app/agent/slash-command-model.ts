import { Array as Arr, Option } from 'effect'

export type AgentCommandSummary = {
  readonly name: string
  readonly description?: string
  readonly hints: ReadonlyArray<string>
}

export type SlashCommandInput = {
  readonly prefix: string
  readonly argumentsText: string
}

export const slashCommandInput = (input: string) => {
  if (!input.startsWith('/')) {
    return Option.none<SlashCommandInput>()
  }

  const withoutSlash = input.slice(1)
  const commandEnd = withoutSlash.search(/\s/)

  if (commandEnd === -1) {
    return Option.some({ prefix: withoutSlash, argumentsText: '' })
  }

  return Option.some({
    prefix: withoutSlash.slice(0, commandEnd),
    argumentsText: withoutSlash.slice(commandEnd).trimStart()
  })
}

export const matchingSlashCommands = (
  input: string,
  commands: ReadonlyArray<AgentCommandSummary>
) =>
  Option.match(slashCommandInput(input), {
    onNone: () => [],
    onSome: slash => {
      const prefix = slash.prefix.toLowerCase()

      return Arr.filter(commands, command => command.name.toLowerCase().startsWith(prefix))
    }
  })

export const normalizeSlashSelectionIndex = (index: number, commandCount: number) => {
  if (commandCount <= 0) {
    return 0
  }

  return ((index % commandCount) + commandCount) % commandCount
}
