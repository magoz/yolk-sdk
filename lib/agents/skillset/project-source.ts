import { Effect } from 'effect'
import { mergeSkillsets, type MergedSkillset, type SkillsetManifest } from '@yolk-sdk/skillset'
import { loadConfigSkillsetManifest } from './config-source'
import { loadUserSkillsetManifest } from './db-source'
import { loadProjectSkillset as loadProjectFileSkillset } from './file-source'

export const skillsetManifestFromMergedSkillset = (skillset: MergedSkillset): SkillsetManifest => ({
  version: 1,
  skills: skillset.skills,
  commands: skillset.commands
})

export const loadProjectSkillset = (rootDirectory = process.cwd()) =>
  Effect.gen(function* () {
    const configManifest = yield* loadConfigSkillsetManifest()
    const fileSkillset = yield* loadProjectFileSkillset(rootDirectory)

    return yield* mergeSkillsets([
      { id: 'config', manifest: configManifest },
      { id: 'filesystem', manifest: skillsetManifestFromMergedSkillset(fileSkillset) }
    ])
  })

export const loadRuntimeSkillset = (input: { readonly userId: string; readonly rootDirectory?: string }) =>
  Effect.gen(function* () {
    const dbManifest = yield* loadUserSkillsetManifest({ userId: input.userId })
    const configManifest = yield* loadConfigSkillsetManifest()
    const fileSkillset = yield* loadProjectFileSkillset(input.rootDirectory)

    return yield* mergeSkillsets([
      { id: 'database', manifest: dbManifest },
      { id: 'config', manifest: configManifest },
      { id: 'filesystem', manifest: skillsetManifestFromMergedSkillset(fileSkillset) }
    ])
  })
