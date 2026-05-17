import { and, desc, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { isValidSkillsetName } from '@yolk/skillset'
import { NotFoundError, PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export type AgentCommandInput = {
  readonly name: string
  readonly description: string
  readonly template: string
}

export type AgentCommandUpdateInput = AgentCommandInput & {
  readonly id: string
  readonly enabled: boolean
}

const validateText = (field: string, value: string) => {
  const trimmed = value.trim()

  return trimmed.length === 0
    ? Effect.fail(new ValidationError({ message: `${field} is required`, field }))
    : Effect.succeed(trimmed)
}

export const validateAgentCommandInput = (input: AgentCommandInput) =>
  Effect.gen(function* () {
    const name = input.name.trim()

    if (!isValidSkillsetName(name)) {
      return yield* Effect.fail(
        new ValidationError({ message: `Invalid command name: ${name}`, field: 'name' })
      )
    }

    const template = yield* validateText('template', input.template)

    return { name, description: input.description.trim(), template }
  })

export const listAgentCommands = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db

    return yield* db
      .select()
      .from(schema.agentCommand)
      .where(eq(schema.agentCommand.userId, input.userId))
      .orderBy(desc(schema.agentCommand.updatedAt))
  }).pipe(Effect.withSpan('agentCommand.list'))

export const createAgentCommand = (input: AgentCommandInput & { readonly userId: string }) =>
  Effect.gen(function* () {
    const values = yield* validateAgentCommandInput(input)
    const db = yield* Db
    const [command] = yield* db
      .insert(schema.agentCommand)
      .values({ ...values, userId: input.userId })
      .returning()

    if (command === undefined) {
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not create agent command', entity: 'agentCommand' })
      )
    }

    return command
  }).pipe(Effect.withSpan('agentCommand.create'))

export const upsertAgentCommand = (input: AgentCommandInput & { readonly userId: string }) =>
  Effect.gen(function* () {
    const values = yield* validateAgentCommandInput(input)
    const db = yield* Db
    const [command] = yield* db
      .insert(schema.agentCommand)
      .values({ ...values, enabled: true, userId: input.userId })
      .onConflictDoUpdate({
        target: [schema.agentCommand.userId, schema.agentCommand.name],
        set: {
          description: values.description,
          template: values.template,
          enabled: true,
          updatedAt: sql`CURRENT_TIMESTAMP`
        }
      })
      .returning()

    if (command === undefined) {
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not upsert agent command', entity: 'agentCommand' })
      )
    }

    return command
  }).pipe(Effect.withSpan('agentCommand.upsert'))

export const updateAgentCommand = (input: AgentCommandUpdateInput & { readonly userId: string }) =>
  Effect.gen(function* () {
    const values = yield* validateAgentCommandInput(input)
    const db = yield* Db
    const [command] = yield* db
      .update(schema.agentCommand)
      .set({ ...values, enabled: input.enabled })
      .where(and(eq(schema.agentCommand.id, input.id), eq(schema.agentCommand.userId, input.userId)))
      .returning()

    if (command === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent command not found', entity: 'agentCommand', id: input.id })
      )
    }

    return command
  }).pipe(Effect.withSpan('agentCommand.update'))

export const setAgentCommandEnabled = (input: {
  readonly id: string
  readonly userId: string
  readonly enabled: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [command] = yield* db
      .update(schema.agentCommand)
      .set({ enabled: input.enabled })
      .where(and(eq(schema.agentCommand.id, input.id), eq(schema.agentCommand.userId, input.userId)))
      .returning()

    if (command === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent command not found', entity: 'agentCommand', id: input.id })
      )
    }

    return command
  }).pipe(Effect.withSpan('agentCommand.setEnabled'))

export const deleteAgentCommand = (input: { readonly id: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [command] = yield* db
      .delete(schema.agentCommand)
      .where(and(eq(schema.agentCommand.id, input.id), eq(schema.agentCommand.userId, input.userId)))
      .returning({ id: schema.agentCommand.id })

    if (command === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Agent command not found', entity: 'agentCommand', id: input.id })
      )
    }

    return command
  }).pipe(Effect.withSpan('agentCommand.delete'))
