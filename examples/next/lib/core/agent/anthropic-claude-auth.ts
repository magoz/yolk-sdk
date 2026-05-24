import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { anthropicClaudeProviderId } from '@yolk-sdk/anthropic/claude'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AnthropicClaudeOAuth } from '@/lib/services/anthropic-oauth/live-layer'
import {
  AnthropicClaudeAuthInvalidError,
  AnthropicClaudeAuthNotFoundError
} from '@/lib/services/anthropic-oauth/errors'
import type { AnthropicClaudeOAuthToken } from '@/lib/services/anthropic-oauth/schemas'

const ANTHROPIC_CLAUDE_PROVIDER_ID = anthropicClaudeProviderId

type AnthropicClaudeAccount = {
  readonly id: string
  readonly accessToken: string | null
  readonly refreshToken: string | null
  readonly accessTokenExpiresAt: Date | null
}

const selectAnthropicClaudeAccount = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [account] = yield* db
      .select({
        id: schema.account.id,
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        accessTokenExpiresAt: schema.account.accessTokenExpiresAt
      })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, ANTHROPIC_CLAUDE_PROVIDER_ID)
        )
      )
      .limit(1)

    return account
  })

const tokenFromAccount = (account: AnthropicClaudeAccount) =>
  Effect.gen(function* () {
    if (account.accessToken === null || account.accessToken.length === 0) {
      return yield* new AnthropicClaudeAuthInvalidError({
        message: 'Anthropic Claude auth is missing an access token'
      })
    }

    if (account.refreshToken === null || account.refreshToken.length === 0) {
      return yield* new AnthropicClaudeAuthInvalidError({
        message: 'Anthropic Claude auth is missing a refresh token'
      })
    }

    if (account.accessTokenExpiresAt === null) {
      return yield* new AnthropicClaudeAuthInvalidError({
        message: 'Anthropic Claude auth is missing an access token expiry'
      })
    }

    return {
      type: 'oauth' as const,
      refresh: account.refreshToken,
      access: account.accessToken,
      expires: account.accessTokenExpiresAt.getTime()
    }
  })

export const hasAnthropicClaudeAuth = (userId: string) =>
  Effect.gen(function* () {
    const account = yield* selectAnthropicClaudeAccount(userId)
    return account !== undefined
  }).pipe(Effect.withSpan('agent.anthropicClaudeAuth.has'))

export const saveAnthropicClaudeToken = (input: {
  readonly userId: string
  readonly token: AnthropicClaudeOAuthToken
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const existing = yield* selectAnthropicClaudeAccount(input.userId)
    const expiresAt = new Date(input.token.expires)

    if (existing === undefined) {
      yield* db.insert(schema.account).values({
        id: createId(),
        userId: input.userId,
        providerId: ANTHROPIC_CLAUDE_PROVIDER_ID,
        accountId: ANTHROPIC_CLAUDE_PROVIDER_ID,
        accessToken: input.token.access,
        refreshToken: input.token.refresh,
        accessTokenExpiresAt: expiresAt
      })
      return
    }

    yield* db
      .update(schema.account)
      .set({
        accessToken: input.token.access,
        refreshToken: input.token.refresh,
        accessTokenExpiresAt: expiresAt,
        updatedAt: new Date()
      })
      .where(eq(schema.account.id, existing.id))
  }).pipe(Effect.withSpan('agent.anthropicClaudeAuth.save'))

export const getAnthropicClaudeToken = (userId: string) =>
  Effect.gen(function* () {
    const account = yield* selectAnthropicClaudeAccount(userId)

    if (account === undefined) {
      return yield* new AnthropicClaudeAuthNotFoundError({
        message: 'Anthropic Claude is not connected for this user'
      })
    }

    return yield* tokenFromAccount(account)
  }).pipe(Effect.withSpan('agent.anthropicClaudeAuth.get'))

export const getValidAnthropicClaudeToken = (
  userId: string,
  options: { readonly minTtlMs?: number; readonly forceRefresh?: boolean } = {}
) =>
  Effect.gen(function* () {
    const oauth = yield* AnthropicClaudeOAuth
    const token = yield* getAnthropicClaudeToken(userId)

    const needsRefresh =
      options.forceRefresh === true || (yield* oauth.needsRefresh(token, options.minTtlMs))

    if (!needsRefresh) {
      return token
    }

    const refreshed = yield* oauth.refreshToken(token.refresh)
    yield* saveAnthropicClaudeToken({ userId, token: refreshed })

    return refreshed
  }).pipe(Effect.withSpan('agent.anthropicClaudeAuth.getValid'))

export const deleteAnthropicClaudeToken = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, ANTHROPIC_CLAUDE_PROVIDER_ID)
        )
      )
  }).pipe(Effect.withSpan('agent.anthropicClaudeAuth.delete'))
