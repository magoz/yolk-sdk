import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { SkillsetError } from './errors.ts'
import { parseMarkdownDocument } from './markdown.ts'
import { validateSkillsetName } from './name.ts'

export const CommandArgument = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String)
})
export type CommandArgument = typeof CommandArgument.Type

export const CommandAccess = Schema.Union([
  Schema.Literal('read'),
  Schema.Literal('write'),
  Schema.Literal('destructive')
])
export type CommandAccess = typeof CommandAccess.Type

export const CommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  template: Schema.String,
  hints: Schema.Array(Schema.String),
  arguments: Schema.optional(Schema.Array(CommandArgument)),
  access: Schema.optional(CommandAccess),
  fileRefs: Schema.optional(Schema.Boolean),
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

const parseCommandAccess = (value: string | undefined) => {
  if (value === undefined || value.length === 0) {
    return Effect.succeed(undefined)
  }

  switch (value) {
    case 'read':
    case 'write':
    case 'destructive':
      return Effect.succeed(value)
    default:
      return Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_invalid',
          message: 'Command access must be read, write, or destructive'
        })
      )
  }
}

const parseBooleanField = (field: string, value: string | undefined) => {
  if (value === undefined || value.length === 0) {
    return Effect.succeed(undefined)
  }

  switch (value) {
    case 'true':
      return Effect.succeed(true)
    case 'false':
      return Effect.succeed(false)
    default:
      return Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_invalid',
          message: `${field} must be true or false`
        })
      )
  }
}

const parseArgumentToken = (token: string) => {
  const trimmed = token.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const required = !trimmed.endsWith('?')
  const name = required ? trimmed : trimmed.slice(0, -1)

  return name.length === 0 ? undefined : { name, required }
}

const parseCommandArgumentsField = (value: string | undefined): ReadonlyArray<CommandArgument> => {
  if (value === undefined || value.length === 0) {
    return []
  }

  return value.split(',').flatMap(token => {
    const argument = parseArgumentToken(token)

    return argument === undefined ? [] : [argument]
  })
}

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
    const access = yield* parseCommandAccess(document.data.access)
    const fileRefs = yield* parseBooleanField('fileRefs', document.data.fileRefs)
    const commandArguments = parseCommandArgumentsField(document.data.arguments)

    return {
      name,
      description: description === undefined || description.length === 0 ? undefined : description,
      template: document.content,
      hints: commandHints(document.content),
      ...(commandArguments.length === 0 ? {} : { arguments: commandArguments }),
      ...(access === undefined ? {} : { access }),
      ...(fileRefs === undefined ? {} : { fileRefs }),
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
