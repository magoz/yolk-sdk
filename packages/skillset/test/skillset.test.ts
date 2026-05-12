import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  emptySkillsetManifest,
  formatAvailableSkills,
  mergeSkillsets,
  parseCommandArguments,
  parseCommandMarkdown,
  parseSkillMarkdown,
  renderCommand
} from '../src'

const skillMarkdown = `---
name: git-release
description: Create consistent releases
---

Use this when preparing a release.
`

const commandMarkdown = `---
description: Review changes
---

Review $1 with context $2.
`

describe('skillset', () => {
  it.effect('parses skill markdown with validated name and content', () =>
    Effect.gen(function* () {
      const skill = yield* parseSkillMarkdown({
        markdown: skillMarkdown,
        location: '.opencode/skills/git-release/SKILL.md',
        directoryName: 'git-release',
        source: 'project'
      })

      expect(skill).toEqual({
        name: 'git-release',
        description: 'Create consistent releases',
        location: '.opencode/skills/git-release/SKILL.md',
        content: 'Use this when preparing a release.',
        source: 'project'
      })
    })
  )

  it.effect('rejects skill directory name mismatches', () =>
    Effect.gen(function* () {
      const result = yield* parseSkillMarkdown({
        markdown: skillMarkdown,
        location: '.opencode/skills/release/SKILL.md',
        directoryName: 'release'
      }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'SkillsetError', cause: 'name_mismatch' }
      })
    })
  )

  it.effect('formats available skills as compact XML metadata', () =>
    Effect.gen(function* () {
      const skill = yield* parseSkillMarkdown({
        markdown: skillMarkdown,
        location: '.opencode/skills/git-release/SKILL.md'
      })

      expect(formatAvailableSkills([skill])).toBe(
        [
          '<available_skills>',
          '  <skill>',
          '    <name>git-release</name>',
          '    <description>Create consistent releases</description>',
          '  </skill>',
          '</available_skills>'
        ].join('\n')
      )
    })
  )

  it.effect('parses command markdown and extracts placeholders', () =>
    Effect.gen(function* () {
      const command = yield* parseCommandMarkdown({
        markdown: commandMarkdown,
        name: 'review',
        location: '.opencode/commands/review.md'
      })

      expect(command).toEqual({
        name: 'review',
        description: 'Review changes',
        template: 'Review $1 with context $2.',
        hints: ['$1', '$2'],
        location: '.opencode/commands/review.md',
        source: undefined
      })
    })
  )

  it('parses quoted command arguments', () => {
    expect(parseCommandArguments('branch "with spaces" \'and more\'')).toEqual([
      'branch',
      'with spaces',
      'and more'
    ])
  })

  it.effect('renders numbered and catch-all command arguments', () =>
    Effect.gen(function* () {
      const command = yield* parseCommandMarkdown({
        markdown: commandMarkdown,
        name: 'review'
      })

      expect(renderCommand(command, 'branch "extra context here"')).toBe(
        'Review branch with context extra context here.'
      )
    })
  )

  it.effect('appends arguments when command has no placeholders', () =>
    Effect.gen(function* () {
      const command = yield* parseCommandMarkdown({
        markdown: `---
description: Explain
---

Explain this.
`,
        name: 'explain'
      })

      expect(renderCommand(command, 'src/file.ts')).toBe('Explain this.\n\nsrc/file.ts')
    })
  )

  it.effect('merges sources by priority and rejects duplicates inside one source', () =>
    Effect.gen(function* () {
      const baseSkill = yield* parseSkillMarkdown({
        markdown: skillMarkdown,
        location: 'base/SKILL.md'
      })
      const overrideSkill = yield* parseSkillMarkdown({
        markdown: `---
name: git-release
description: Override releases
---

Override.
`,
        location: 'override/SKILL.md'
      })

      const merged = yield* mergeSkillsets([
        { id: 'override', manifest: { ...emptySkillsetManifest, skills: [overrideSkill] } },
        { id: 'base', manifest: { ...emptySkillsetManifest, skills: [baseSkill] } }
      ])

      expect(merged.skills).toEqual([overrideSkill])

      const duplicate = yield* mergeSkillsets([
        { id: 'bad', manifest: { ...emptySkillsetManifest, skills: [baseSkill, baseSkill] } }
      ]).pipe(Effect.result)

      expect(duplicate).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'SkillsetError', cause: 'duplicate_entry' }
      })
    })
  )
})
