import { Effect } from 'effect'
import { SkillsetError } from './errors.ts'
import type { CommandInfo } from './command.ts'
import type { SkillInfo } from './skill.ts'
import type { SkillsetManifest } from './manifest.ts'

export type SkillsetSource = {
  readonly id: string
  readonly manifest: SkillsetManifest
}

export type MergedSkillset = {
  readonly skills: ReadonlyArray<SkillInfo>
  readonly commands: ReadonlyArray<CommandInfo>
}

const mergeByName = <Entry extends { readonly name: string }>(
  entries: ReadonlyArray<ReadonlyArray<Entry>>
) => {
  const byName = new Map<string, Entry>()

  const reversedEntries = [...entries].reverse()

  reversedEntries.forEach(group => {
    group.forEach(entry => byName.set(entry.name, entry))
  })

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const duplicateNames = <Entry extends { readonly name: string }>(entries: ReadonlyArray<Entry>) => {
  const names = entries.map(entry => entry.name)

  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
}

const rejectInternalDuplicates = (source: SkillsetSource) => {
  const duplicates = [
    ...duplicateNames(source.manifest.skills).map(name => `skill:${name}`),
    ...duplicateNames(source.manifest.commands).map(name => `command:${name}`)
  ]

  return duplicates.length === 0
    ? Effect.void
    : Effect.fail(
        new SkillsetError({
          cause: 'duplicate_entry',
          message: `Duplicate entries in source ${source.id}: ${duplicates.join(', ')}`
        })
      )
}

export const mergeSkillsets = (sources: ReadonlyArray<SkillsetSource>) =>
  Effect.gen(function* () {
    yield* Effect.forEach(sources, rejectInternalDuplicates, { discard: true })

    return {
      skills: mergeByName(sources.map(source => source.manifest.skills)),
      commands: mergeByName(sources.map(source => source.manifest.commands))
    }
  })
