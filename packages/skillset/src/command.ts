import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { parseMarkdownDocument } from './markdown.ts'
import { validateSkillsetName } from './name.ts'

export const CommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  template: Schema.String,
  hints: Schema.Array(Schema.String),
  location: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String)
})
export type CommandInfo = typeof CommandInfo.Type

export type ParseCommandInput = {
  readonly markdown: string
  readonly name: string
  readonly location?: string
  readonly source?: string
}

const numberedPlaceholderPattern = /\$(\d+)/g

export const commandHints = (template: string) => {
  const numbered = Array.from(template.matchAll(numberedPlaceholderPattern), match => `$${match[1]}`)
  const unique = [...new Set(numbered)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))

  return template.includes('$ARGUMENTS') ? [...unique, '$ARGUMENTS'] : unique
}

export const parseCommandMarkdown = (input: ParseCommandInput) =>
  Effect.gen(function* () {
    const name = yield* validateSkillsetName(input.name)
    const document = yield* parseMarkdownDocument(input.markdown)
    const description = document.data.description

    return {
      name,
      description: description === undefined || description.length === 0 ? undefined : description,
      template: document.content,
      hints: commandHints(document.content),
      location: input.location,
      source: input.source
    }
  })

export const parseCommandArguments = (input: string) => {
  const result: string[] = []
  let current = ''
  let quote: 'single' | 'double' | undefined

  for (const char of input.trim()) {
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      continue
    }

    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      continue
    }

    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        result.push(current)
        current = ''
      }
      continue
    }

    current = `${current}${char}`
  }

  if (current.length > 0) {
    result.push(current)
  }

  return result
}

export const renderCommand = (command: CommandInfo, argumentsText: string) => {
  const args = parseCommandArguments(argumentsText)
  const placeholders = Array.from(command.template.matchAll(numberedPlaceholderPattern), match =>
    Number(match[1])
  )
  const lastPlaceholder = placeholders.reduce((max, value) => Math.max(max, value), 0)
  const withNumbered = command.template.replace(numberedPlaceholderPattern, (_, index: string) => {
    const position = Number(index)
    const argIndex = position - 1

    if (argIndex >= args.length) {
      return ''
    }

    return position === lastPlaceholder ? args.slice(argIndex).join(' ') : (args[argIndex] ?? '')
  })
  const usesArguments = command.template.includes('$ARGUMENTS')
  const rendered = withNumbered.replaceAll('$ARGUMENTS', argumentsText)

  return placeholders.length === 0 && !usesArguments && argumentsText.trim().length > 0
    ? `${rendered}\n\n${argumentsText}`.trim()
    : rendered.trim()
}
