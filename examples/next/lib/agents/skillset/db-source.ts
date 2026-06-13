import { and, asc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { commandHints, type CommandInfo, type SkillInfo, type SkillsetManifest } from '@yolk-sdk/agent/skillset'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const dbSkillSource = 'db'
const dbCommandSource = 'db'

export type AgentSkillManifestRow = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
}

export type AgentCommandManifestRow = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly template: string
}

const rowToSkillInfo = (row: AgentSkillManifestRow): SkillInfo => ({
  name: row.name,
  description: row.description,
  location: `db:agentSkill:${row.id}`,
  content: row.content,
  source: dbSkillSource
})

const rowToCommandInfo = (row: AgentCommandManifestRow): CommandInfo => ({
  name: row.name,
  ...(row.description.length === 0 ? {} : { description: row.description }),
  template: row.template,
  hints: commandHints(row.template),
  location: `db:agentCommand:${row.id}`,
  source: dbCommandSource
})

export const agentRowsToManifest = (
  skillRows: ReadonlyArray<AgentSkillManifestRow>,
  commandRows: ReadonlyArray<AgentCommandManifestRow>
): SkillsetManifest => ({
  version: 1,
  skills: skillRows.map(rowToSkillInfo),
  commands: commandRows.map(rowToCommandInfo)
})

export const agentSkillRowsToManifest = (rows: ReadonlyArray<AgentSkillManifestRow>) =>
  agentRowsToManifest(rows, [])

export const loadUserSkillsetManifest = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const skillRows = yield* db
      .select({
        id: schema.agentSkill.id,
        name: schema.agentSkill.name,
        description: schema.agentSkill.description,
        content: schema.agentSkill.content
      })
      .from(schema.agentSkill)
      .where(and(eq(schema.agentSkill.userId, input.userId), eq(schema.agentSkill.enabled, true)))
      .orderBy(asc(schema.agentSkill.name))
    const commandRows = yield* db
      .select({
        id: schema.agentCommand.id,
        name: schema.agentCommand.name,
        description: schema.agentCommand.description,
        template: schema.agentCommand.template
      })
      .from(schema.agentCommand)
      .where(and(eq(schema.agentCommand.userId, input.userId), eq(schema.agentCommand.enabled, true)))
      .orderBy(asc(schema.agentCommand.name))

    return agentRowsToManifest(skillRows, commandRows)
  }).pipe(Effect.withSpan('skillset.loadUserSkillsetManifest'))
