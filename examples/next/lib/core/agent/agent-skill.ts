import { and, desc, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { isValidSkillsetName } from '@yolk-sdk/agent/skillset'
import { NotFoundError, PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { validateAgentCommandInput, type AgentCommandInput } from './agent-command'

export type AgentSkillInput = {
  readonly name: string
  readonly description: string
  readonly content: string
}

export type AgentSkillUpdateInput = AgentSkillInput & {
  readonly id: string
  readonly enabled: boolean
}

export type AgentSkillCommandInput =
  | { readonly _tag: 'CreateCommand'; readonly command: AgentCommandInput }
  | { readonly _tag: 'SkipCommand' }

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
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not create agent skill', entity: 'agentSkill' })
      )
    }

    return skill
  }).pipe(Effect.withSpan('agentSkill.create'))

export const createAgentSkillWithCommand = (
  input: AgentSkillInput & {
    readonly userId: string
    readonly commandInput: AgentSkillCommandInput
  }
) =>
  Effect.gen(function* () {
    const values = yield* validateSkillInput(input)
    const commandValues =
      input.commandInput._tag === 'CreateCommand'
        ? yield* validateAgentCommandInput(input.commandInput.command)
        : undefined
    const db = yield* Db

    return yield* db.transaction(tx =>
      Effect.gen(function* () {
        const [skill] = yield* tx
          .insert(schema.agentSkill)
          .values({ ...values, userId: input.userId })
          .returning()

        if (skill === undefined) {
          return yield* Effect.fail(
            new PersistenceError({ message: 'Could not create agent skill', entity: 'agentSkill' })
          )
        }

        if (commandValues !== undefined) {
          const [command] = yield* tx
            .insert(schema.agentCommand)
            .values({ ...commandValues, enabled: true, userId: input.userId })
            .onConflictDoUpdate({
              target: [schema.agentCommand.userId, schema.agentCommand.name],
              set: {
                description: commandValues.description,
                template: commandValues.template,
                enabled: true,
                updatedAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .returning()

          if (command === undefined) {
            return yield* Effect.fail(
              new PersistenceError({
                message: 'Could not upsert agent command',
                entity: 'agentCommand'
              })
            )
          }
        }

        return skill
      })
    )
  }).pipe(Effect.withSpan('agentSkill.createWithCommand'))

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

export const updateAgentSkillWithCommand = (
  input: AgentSkillUpdateInput & {
    readonly userId: string
    readonly commandInput: AgentSkillCommandInput
  }
) =>
  Effect.gen(function* () {
    const values = yield* validateSkillInput(input)
    const commandValues =
      input.commandInput._tag === 'CreateCommand'
        ? yield* validateAgentCommandInput(input.commandInput.command)
        : undefined
    const db = yield* Db

    return yield* db.transaction(tx =>
      Effect.gen(function* () {
        const [skill] = yield* tx
          .update(schema.agentSkill)
          .set({ ...values, enabled: input.enabled })
          .where(
            and(eq(schema.agentSkill.id, input.id), eq(schema.agentSkill.userId, input.userId))
          )
          .returning()

        if (skill === undefined) {
          return yield* Effect.fail(
            new NotFoundError({
              message: 'Agent skill not found',
              entity: 'agentSkill',
              id: input.id
            })
          )
        }

        if (commandValues !== undefined) {
          const [command] = yield* tx
            .insert(schema.agentCommand)
            .values({ ...commandValues, enabled: true, userId: input.userId })
            .onConflictDoUpdate({
              target: [schema.agentCommand.userId, schema.agentCommand.name],
              set: {
                description: commandValues.description,
                template: commandValues.template,
                enabled: true,
                updatedAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .returning()

          if (command === undefined) {
            return yield* Effect.fail(
              new PersistenceError({
                message: 'Could not upsert agent command',
                entity: 'agentCommand'
              })
            )
          }
        }

        return skill
      })
    )
  }).pipe(Effect.withSpan('agentSkill.updateWithCommand'))

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
