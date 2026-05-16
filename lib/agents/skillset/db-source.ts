import { and, asc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import type { SkillInfo, SkillsetManifest } from '@yolk/skillset'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const dbSkillSource = 'db'

export type AgentSkillManifestRow = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
}

const rowToSkillInfo = (row: AgentSkillManifestRow): SkillInfo => ({
  name: row.name,
  description: row.description,
  location: `db:agentSkill:${row.id}`,
  content: row.content,
  source: dbSkillSource
})

export const agentSkillRowsToManifest = (
  rows: ReadonlyArray<AgentSkillManifestRow>
): SkillsetManifest => ({
  version: 1,
  skills: rows.map(rowToSkillInfo),
  commands: []
})

export const loadUserSkillsetManifest = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db
      .select({
        id: schema.agentSkill.id,
        name: schema.agentSkill.name,
        description: schema.agentSkill.description,
        content: schema.agentSkill.content
      })
      .from(schema.agentSkill)
      .where(and(eq(schema.agentSkill.userId, input.userId), eq(schema.agentSkill.enabled, true)))
      .orderBy(asc(schema.agentSkill.name))

    return agentSkillRowsToManifest(rows)
  }).pipe(Effect.withSpan('skillset.loadUserSkillsetManifest'))
