import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { SkillsetError } from './errors.ts'
import { parseMarkdownDocument } from './markdown.ts'
import { validateDirectoryName, validateSkillsetName } from './name.ts'

export const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  location: Schema.String,
  content: Schema.String,
  source: Schema.optional(Schema.String)
})
export type SkillInfo = typeof SkillInfo.Type

export type ParseSkillInput = {
  readonly markdown: string
  readonly location: string
  readonly directoryName?: string
  readonly source?: string
}

const requiredField = (data: Readonly<Record<string, string>>, field: string) => {
  const value = data[field]

  return value === undefined || value.length === 0
    ? Effect.fail(
        new SkillsetError({
          cause: 'frontmatter_field_missing',
          message: `Skill frontmatter requires ${field}`
        })
      )
    : Effect.succeed(value)
}

export const parseSkillMarkdown = (input: ParseSkillInput) =>
  Effect.gen(function* () {
    const document = yield* parseMarkdownDocument(input.markdown)
    const name = yield* requiredField(document.data, 'name').pipe(Effect.flatMap(validateSkillsetName))
    const description = yield* requiredField(document.data, 'description')

    if (input.directoryName !== undefined) {
      yield* validateDirectoryName(input.directoryName, name)
    }

    return {
      name,
      description,
      location: input.location,
      content: document.content,
      source: input.source
    }
  })

export const formatAvailableSkills = (skills: ReadonlyArray<SkillInfo>) =>
  skills.length === 0
    ? ''
    : [
        '<available_skills>',
        ...skills
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .flatMap(skill => [
            '  <skill>',
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            '  </skill>'
          ]),
        '</available_skills>'
      ].join('\n')
