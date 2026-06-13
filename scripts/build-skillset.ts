import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { type MergedSkillset, type SkillsetManifest } from '@yolk-sdk/agent/skillset'
import { loadProjectSkillset } from '../examples/next/lib/agents/skillset/project-source'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const rootDirectory = resolve(scriptDirectory, '..')
const outputPath = resolve(scriptDirectory, '../cloudflare/agent/src/generated/skillset.ts')

const portableLocation = (location: string | undefined) => {
  if (location === undefined) {
    return undefined
  }

  const relativeLocation = relative(rootDirectory, location)

  return relativeLocation.startsWith('..') ? location : relativeLocation
}

const manifestFromMergedSkillset = (skillset: MergedSkillset): SkillsetManifest => ({
  version: 1,
  skills: skillset.skills.map(skill => ({
    ...skill,
    ...(portableLocation(skill.location) === undefined
      ? {}
      : { location: portableLocation(skill.location) })
  })),
  commands: skillset.commands.map(command => ({
    ...command,
    ...(portableLocation(command.location) === undefined
      ? {}
      : { location: portableLocation(command.location) })
  }))
})

const encodeManifestJson = (manifest: SkillsetManifest) => JSON.stringify(manifest, undefined, 2)

const generatedSource = (
  manifestJson: string
) => `import type { SkillsetManifest } from '@yolk-sdk/agent/skillset'

export const generatedSkillsetManifest: SkillsetManifest = ${manifestJson}
`

const writeGeneratedSkillset = (source: string) =>
  Effect.promise(() =>
    mkdir(dirname(outputPath), { recursive: true }).then(() => writeFile(outputPath, source))
  )

const program = Effect.gen(function* () {
  const skillset = yield* loadProjectSkillset()
  const manifestJson = encodeManifestJson(manifestFromMergedSkillset(skillset))

  yield* writeGeneratedSkillset(generatedSource(manifestJson))
})

Effect.runPromise(program)
