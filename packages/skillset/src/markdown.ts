import { Effect } from 'effect'
import { SkillsetError } from './errors.ts'

export type MarkdownDocument = {
  readonly data: Readonly<Record<string, string>>
  readonly content: string
}

const frontmatterStart = '---\n'

const frontmatterEndIndex = (markdown: string) => markdown.indexOf('\n---', frontmatterStart.length)

const parseFrontmatterLine = (line: string) => {
  const separatorIndex = line.indexOf(':')

  if (separatorIndex === -1) {
    return undefined
  }

  const key = line.slice(0, separatorIndex).trim()
  const value = line.slice(separatorIndex + 1).trim()

  return key.length === 0 ? undefined : { key, value }
}

export const parseMarkdownDocument = (markdown: string) =>
  Effect.gen(function* () {
    if (!markdown.startsWith(frontmatterStart)) {
      return yield* Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_missing',
          message: 'Markdown must start with YAML frontmatter'
        })
      )
    }

    const endIndex = frontmatterEndIndex(markdown)

    if (endIndex === -1) {
      return yield* Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_invalid',
          message: 'Markdown frontmatter is missing closing delimiter'
        })
      )
    }

    const entries = markdown
      .slice(frontmatterStart.length, endIndex)
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(parseFrontmatterLine)

    if (entries.some(entry => entry === undefined)) {
      return yield* Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_invalid',
          message: 'Markdown frontmatter only supports simple key: value fields'
        })
      )
    }

    const data = Object.fromEntries(
      entries.flatMap(entry => (entry === undefined ? [] : [[entry.key, entry.value]]))
    )
    const contentStart = markdown.startsWith('\n', endIndex + frontmatterStart.length)
      ? endIndex + frontmatterStart.length + 1
      : endIndex + frontmatterStart.length

    return {
      data,
      content: markdown.slice(contentStart).trim()
    }
  })
