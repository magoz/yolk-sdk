import { and, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { isValidSkillsetName } from '@yolk/skillset'
import { NotFoundError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export type AgentSkillInput = {
  readonly name: string
  readonly description: string
  readonly content: string
}

export type AgentSkillUpdateInput = AgentSkillInput & {
  readonly id: string
  readonly enabled: boolean
}

const validateText = (field: string, value: string) => {
  const trimmed = value.trim()

  return trimmed.length === 0
    ? Effect.fail(new ValidationError({ message: `${field} is required`, field }))
    : Effect.succeed(trimmed)
}

const validateSkillInput = (input: AgentSkillInput) =>
  Effect.gen(function* () {
    const name = input.name.trim()

    if (!isValidSkillsetName(name)) {
      return yield* Effect.fail(
        new ValidationError({ message: `Invalid skillset entry name: ${name}`, field: 'name' })
      )
    }

    const description = yield* validateText('description', input.description)
    const content = yield* validateText('content', input.content)

    return { name, description, content }
  })

export const listAgentSkills = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db

    return yield* db
      .select()
      .from(schema.agentSkill)
      .where(eq(schema.agentSkill.userId, input.userId))
      .orderBy(desc(schema.agentSkill.updatedAt))
  }).pipe(Effect.withSpan('agentSkill.list'))

export const createAgentSkill = (input: AgentSkillInput & { readonly userId: string }) =>
  Effect.gen(function* () {
    const values = yield* validateSkillInput(input)
    const db = yield* Db
    const [skill] = yield* db
      .insert(schema.agentSkill)
      .values({ ...values, userId: input.userId })
      .returning()

    if (skill === undefined) {
      return yield* Effect.die(new Error('Could not create agent skill'))
    }

    return skill
  }).pipe(Effect.withSpan('agentSkill.create'))

export const updateAgentSkill = (input: AgentSkillUpdateInput & { readonly userId: string }) =>
  Effect.gen(function* () {
    const values = yield* validateSkillInput(input)
    const db = yield* Db
    const [skill] = yield* db
      .update(schema.agentSkill)
      .set({ ...values, enabled: input.enabled })
      .where(and(eq(schema.agentSkill.id, input.id), eq(schema.agentSkill.userId, input.userId)))
      .returning()

    if (skill === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent skill not found', entity: 'agentSkill', id: input.id })
      )
    }

    return skill
  }).pipe(Effect.withSpan('agentSkill.update'))

export const setAgentSkillEnabled = (input: {
  readonly id: string
  readonly userId: string
  readonly enabled: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [skill] = yield* db
      .update(schema.agentSkill)
      .set({ enabled: input.enabled })
      .where(and(eq(schema.agentSkill.id, input.id), eq(schema.agentSkill.userId, input.userId)))
      .returning()

    if (skill === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent skill not found', entity: 'agentSkill', id: input.id })
      )
    }

    return skill
  }).pipe(Effect.withSpan('agentSkill.setEnabled'))

export const deleteAgentSkill = (input: { readonly id: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [skill] = yield* db
      .delete(schema.agentSkill)
      .where(and(eq(schema.agentSkill.id, input.id), eq(schema.agentSkill.userId, input.userId)))
      .returning({ id: schema.agentSkill.id })

    if (skill === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent skill not found', entity: 'agentSkill', id: input.id })
      )
    }

    return skill
  }).pipe(Effect.withSpan('agentSkill.delete'))
