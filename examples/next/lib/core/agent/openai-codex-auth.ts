import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { openAiCodexProviderId } from '@yolk-sdk/agent/providers/openai/codex'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { OpenAiCodexOAuth } from '@/lib/services/openai-codex-oauth/live-layer'
import {
  OpenAiCodexAuthInvalidError,
  OpenAiCodexAuthNotFoundError
} from '@/lib/services/openai-codex-oauth/errors'
import type { OpenAiCodexOAuthToken } from '@/lib/services/openai-codex-oauth/schemas'

const OPENAI_CODEX_PROVIDER_ID = openAiCodexProviderId

type OpenAiCodexAccount = {
  readonly id: string
  readonly accountId: string
  readonly accessToken: string | null
  readonly refreshToken: string | null
  readonly accessTokenExpiresAt: Date | null
}

const accountIdForToken = (token: OpenAiCodexOAuthToken) =>
  token.accountId ?? OPENAI_CODEX_PROVIDER_ID

const selectOpenAiCodexAccount = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [account] = yield* db
      .select({
        id: schema.account.id,
        accountId: schema.account.accountId,
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        accessTokenExpiresAt: schema.account.accessTokenExpiresAt
      })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, OPENAI_CODEX_PROVIDER_ID)
        )
      )
      .limit(1)

    return account
  })

const tokenFromAccount = (account: OpenAiCodexAccount) =>
  Effect.gen(function* () {
    if (account.accessToken === null || account.accessToken.length === 0) {
      return yield* new OpenAiCodexAuthInvalidError({
        message: 'OpenAI Codex auth is missing an access token'
      })
    }

    if (account.refreshToken === null || account.refreshToken.length === 0) {
      return yield* new OpenAiCodexAuthInvalidError({
        message: 'OpenAI Codex auth is missing a refresh token'
      })
    }

    if (account.accessTokenExpiresAt === null) {
      return yield* new OpenAiCodexAuthInvalidError({
        message: 'OpenAI Codex auth is missing an access token expiry'
      })
    }

    const base: OpenAiCodexOAuthToken = {
      type: 'oauth',
      refresh: account.refreshToken,
      access: account.accessToken,
      expires: account.accessTokenExpiresAt.getTime()
    }

    if (account.accountId === OPENAI_CODEX_PROVIDER_ID) {
      return base
    }

    return { ...base, accountId: account.accountId }
  })

export const hasOpenAiCodexAuth = (userId: string) =>
  Effect.gen(function* () {
    const account = yield* selectOpenAiCodexAccount(userId)
    return account !== undefined
  }).pipe(Effect.withSpan('agent.openaiCodexAuth.has'))

export const saveOpenAiCodexToken = (input: {
  readonly userId: string
  readonly token: OpenAiCodexOAuthToken
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const existing = yield* selectOpenAiCodexAccount(input.userId)
    const expiresAt = new Date(input.token.expires)
    const accountId = accountIdForToken(input.token)

    if (existing === undefined) {
      yield* db.insert(schema.account).values({
        id: createId(),
        userId: input.userId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        accountId,
        accessToken: input.token.access,
        refreshToken: input.token.refresh,
        accessTokenExpiresAt: expiresAt
      })
      return
    }

    yield* db
      .update(schema.account)
      .set({
        accountId,
        accessToken: input.token.access,
        refreshToken: input.token.refresh,
        accessTokenExpiresAt: expiresAt,
        updatedAt: new Date()
      })
      .where(eq(schema.account.id, existing.id))
  }).pipe(Effect.withSpan('agent.openaiCodexAuth.save'))

export const getOpenAiCodexToken = (userId: string) =>
  Effect.gen(function* () {
    const account = yield* selectOpenAiCodexAccount(userId)

    if (account === undefined) {
      return yield* new OpenAiCodexAuthNotFoundError({
        message: 'OpenAI Codex is not connected for this user'
      })
    }

    return yield* tokenFromAccount(account)
  }).pipe(Effect.withSpan('agent.openaiCodexAuth.get'))

export const getValidOpenAiCodexToken = (
  userId: string,
  options: { readonly minTtlMs?: number; readonly forceRefresh?: boolean } = {}
) =>
  Effect.gen(function* () {
    const oauth = yield* OpenAiCodexOAuth
    const token = yield* getOpenAiCodexToken(userId)

    const needsRefresh =
      options.forceRefresh === true || (yield* oauth.needsRefresh(token, options.minTtlMs))

    if (!needsRefresh) {
      return token
    }

    const refreshed = yield* oauth.refreshToken(token.refresh, token.accountId)
    yield* saveOpenAiCodexToken({ userId, token: refreshed })

    return refreshed
  }).pipe(Effect.withSpan('agent.openaiCodexAuth.getValid'))

export const deleteOpenAiCodexToken = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, OPENAI_CODEX_PROVIDER_ID)
        )
      )
  }).pipe(Effect.withSpan('agent.openaiCodexAuth.delete'))
