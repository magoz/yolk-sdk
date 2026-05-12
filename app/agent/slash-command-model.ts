import { Array as Arr, Option } from 'effect'

export type AgentCommandSummary = {
  readonly name: string
  readonly description?: string
  readonly hints: ReadonlyArray<string>
  readonly arguments?: ReadonlyArray<{
    readonly name: string
    readonly required: boolean
    readonly description?: string
  }>
  readonly access?: 'read' | 'write' | 'destructive'
  readonly fileRefs?: boolean
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

export const slashCommandHint = (command: AgentCommandSummary) => {
  if (command.arguments !== undefined && command.arguments.length > 0) {
    return command.arguments
      .map(argument => (argument.required ? `<${argument.name}>` : `[${argument.name}]`))
      .join(' ')
  }

  if (command.hints.length > 0) {
    return command.hints.join(' ')
  }

  if (command.fileRefs === true) {
    return 'Accepts file refs'
  }

  return 'Run command'
}

export const slashCommandMeta = (command: AgentCommandSummary) =>
  [command.access, command.fileRefs === true ? 'files' : undefined]
    .filter(value => value !== undefined)
    .join(' · ')

export const normalizeSlashSelectionIndex = (index: number, commandCount: number) => {
  if (commandCount <= 0) {
    return 0
  }

  return ((index % commandCount) + commandCount) % commandCount
}
