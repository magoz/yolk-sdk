import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Path } from 'effect'
import {
  emptySkillsetManifest,
  mergeSkillsets,
  parseCommandMarkdown,
  parseSkillMarkdown,
  type CommandInfo,
  type SkillInfo,
  type SkillsetManifest
} from '@yolk-sdk/skillset'

type FileSkillsetSource = {
  readonly id: string
  readonly rootDirectory: string
  readonly skills: boolean
  readonly commands: boolean
}

const sourceDirectories: ReadonlyArray<Omit<FileSkillsetSource, 'rootDirectory'>> = [
  { id: 'project-.yolk', skills: true, commands: true },
  { id: 'project-.opencode', skills: true, commands: true },
  { id: 'project-.claude', skills: true, commands: false },
  { id: 'project-.agents', skills: true, commands: false }
]

const optionalDirectoryEntries = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if (!(yield* fs.exists(directory))) {
      return []
    }

    return yield* fs.readDirectory(directory)
  })

const readOptionalFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if (!(yield* fs.exists(filePath))) {
      return undefined
    }

    return yield* fs.readFileString(filePath)
  })

const loadSourceSkills = (source: FileSkillsetSource) =>
  Effect.gen(function* () {
    if (!source.skills) {
      return []
    }

    const path = yield* Path.Path
    const skillsDirectory = path.join(source.rootDirectory, 'skills')
    const entries = yield* optionalDirectoryEntries(skillsDirectory)

    return yield* Effect.forEach(
      entries,
      entry =>
        Effect.gen(function* () {
          const skillPath = path.join(skillsDirectory, entry, 'SKILL.md')
          const markdown = yield* readOptionalFile(skillPath)

          if (markdown === undefined) {
            return []
          }

          const skill = yield* parseSkillMarkdown({
            markdown,
            location: skillPath,
            directoryName: entry,
            source: source.id
          })

          return [skill]
        }),
      { concurrency: 'unbounded' }
    ).pipe(Effect.map(groups => groups.flat()))
  })

const commandNameFromFile = (fileName: string) =>
  fileName.endsWith('.md') && fileName.length > '.md'.length
    ? fileName.slice(0, -'.md'.length)
    : undefined

const loadSourceCommands = (source: FileSkillsetSource) =>
  Effect.gen(function* () {
    if (!source.commands) {
      return []
    }

    const path = yield* Path.Path
    const commandsDirectory = path.join(source.rootDirectory, 'commands')
    const entries = yield* optionalDirectoryEntries(commandsDirectory)

    return yield* Effect.forEach(
      entries,
      entry =>
        Effect.gen(function* () {
          const name = commandNameFromFile(entry)

          if (name === undefined) {
            return []
          }

          const commandPath = path.join(commandsDirectory, entry)
          const markdown = yield* readOptionalFile(commandPath)

          if (markdown === undefined) {
            return []
          }

          const command = yield* parseCommandMarkdown({
            markdown,
            name,
            location: commandPath,
            source: source.id
          })

          return [command]
        }),
      { concurrency: 'unbounded' }
    ).pipe(Effect.map(groups => groups.flat()))
  })

const loadSourceManifest = (source: FileSkillsetSource) =>
  Effect.gen(function* () {
    const skills: ReadonlyArray<SkillInfo> = yield* loadSourceSkills(source)
    const commands: ReadonlyArray<CommandInfo> = yield* loadSourceCommands(source)

    return {
      version: 1,
      skills,
      commands
    } satisfies SkillsetManifest
  })

export const loadProjectSkillsetFromFileSystem = (rootDirectory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const sources = sourceDirectories.map(source => ({
      ...source,
      rootDirectory: path.join(rootDirectory, source.id.replace('project-', ''))
    }))
    const manifests = yield* Effect.forEach(
      sources,
      source =>
        loadSourceManifest(source).pipe(
          Effect.map(manifest => ({
            id: source.id,
            manifest
          }))
        ),
      { concurrency: 'unbounded' }
    )

    return yield* mergeSkillsets([
      ...manifests,
      { id: 'empty-default', manifest: emptySkillsetManifest }
    ])
  })

export const loadProjectSkillset = (rootDirectory = process.cwd()) =>
  loadProjectSkillsetFromFileSystem(rootDirectory).pipe(
    Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )
