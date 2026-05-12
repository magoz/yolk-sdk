import { Effect } from 'effect'
import { mergeSkillsets, type MergedSkillset, type SkillsetManifest } from '@yolk/skillset'
import { loadConfigSkillsetManifest } from './config-source'
import { loadProjectSkillset as loadProjectFileSkillset } from './file-source'

const manifestFromMergedSkillset = (skillset: MergedSkillset): SkillsetManifest => ({
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
      { id: 'filesystem', manifest: manifestFromMergedSkillset(fileSkillset) }
    ])
  })
