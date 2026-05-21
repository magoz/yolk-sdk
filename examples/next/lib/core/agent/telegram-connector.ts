import { Data, Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const telegramConnectorProviderId = 'telegram'

export type TelegramConnectorConfig = {
  readonly botToken: string
  readonly chatId: string
}

export type TelegramConnectorStatus =
  | { readonly _tag: 'Connected'; readonly chatId: string }
  | { readonly _tag: 'Disconnected' }

export class TelegramConnectorValidationError extends Data.TaggedError(
  'TelegramConnectorValidationError'
)<{
  readonly message: string
}> {}

const trimmed = (value: string) => value.trim()

const validateTelegramConnectorConfig = (input: TelegramConnectorConfig) =>
  Effect.gen(function* () {
    const botToken = trimmed(input.botToken)
    const chatId = trimmed(input.chatId)

    if (botToken.length === 0) {
      return yield* new TelegramConnectorValidationError({ message: 'Bot token required' })
    }

    if (chatId.length === 0) {
      return yield* new TelegramConnectorValidationError({ message: 'Chat id required' })
    }

    return { botToken, chatId }
  })

const selectTelegramAccount = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [account] = yield* db
      .select({
        id: schema.account.id,
        accountId: schema.account.accountId,
        accessToken: schema.account.accessToken
      })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, telegramConnectorProviderId)
        )
      )
      .limit(1)

    return account
  })

export const getTelegramConnectorConfig = (userId: string) =>
  Effect.gen(function* () {
    const account = yield* selectTelegramAccount(userId)

    if (account === undefined || account.accessToken === null || account.accessToken.length === 0) {
      return undefined
    }

    return {
      botToken: account.accessToken,
      chatId: account.accountId
    }
  }).pipe(Effect.withSpan('agent.telegramConnector.getConfig'))

export const getTelegramConnectorStatus = (userId: string) =>
  Effect.gen(function* () {
    const config = yield* getTelegramConnectorConfig(userId)

    return config === undefined
      ? { _tag: 'Disconnected' as const }
      : { _tag: 'Connected' as const, chatId: config.chatId }
  }).pipe(Effect.withSpan('agent.telegramConnector.status'))

export const saveTelegramConnectorConfig = (input: TelegramConnectorConfig & { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const config = yield* validateTelegramConnectorConfig(input)
    const existing = yield* selectTelegramAccount(input.userId)

    if (existing === undefined) {
      yield* db.insert(schema.account).values({
        id: createId(),
        userId: input.userId,
        providerId: telegramConnectorProviderId,
        accountId: config.chatId,
        accessToken: config.botToken
      })
      return
    }

    yield* db
      .update(schema.account)
      .set({
        accountId: config.chatId,
        accessToken: config.botToken,
        updatedAt: new Date()
      })
      .where(eq(schema.account.id, existing.id))
  }).pipe(Effect.withSpan('agent.telegramConnector.save'))

export const deleteTelegramConnectorConfig = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, telegramConnectorProviderId)
        )
      )
  }).pipe(Effect.withSpan('agent.telegramConnector.delete'))
