/**
 * Telegram Bot API emulator state: the typed entities, the seed input, the default seed, and the
 * profiles (internal; re-exported by `src/telegram.ts`).
 *
 * Entity shapes and the default entities are copied as data from the synthetic Telegram
 * conformance fixtures (the same chat and file ids as `telegramConformanceFixtureSeeds`, the bot
 * the send fixture answers as `from`, and the 32-byte synthetic file), never imported from SDK
 * code. The state holds no bot token: tokens are never stored.
 *
 * @experimental
 */
import { Result } from 'effect'
import * as Schema from 'effect/Schema'

/** The bot every token with a non-zero bot id answers as (`from` of sent messages). */
export const TelegramEmulatorBot = Schema.Struct({
  id: Schema.Int,
  first_name: Schema.String,
  username: Schema.String
})

export type TelegramEmulatorBot = typeof TelegramEmulatorBot.Type

/** A chat the bot is a member of, in the `getChat` fixture's wire shape. */
export const TelegramEmulatorChat = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  type: Schema.String,
  permissions: Schema.Struct({ can_send_messages: Schema.Boolean }),
  accent_color_id: Schema.Int,
  max_reaction_count: Schema.Int
})

export type TelegramEmulatorChat = typeof TelegramEmulatorChat.Type

const FileId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/u))

/** A relative file path the download helper accepts (no empty or dot segments). */
const FilePath = Schema.String.check(
  Schema.makeFilter(path =>
    /^[A-Za-z0-9_./-]+$/.test(path) &&
    !path.startsWith('/') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
      ? undefined
      : 'a relative path of letters, digits, and _ . / - without empty or dot segments'
  )
)

/** A file the bot received: its `getFile` answer and its UTF-8 text content. */
export const TelegramEmulatorFile = Schema.Struct({
  file_id: FileId,
  file_unique_id: FileId,
  file_size: Schema.Int,
  file_path: FilePath,
  /** UTF-8 text; `file_size` must equal its byte length. */
  content: Schema.String
})

export type TelegramEmulatorFile = typeof TelegramEmulatorFile.Type

/** A message the bot sent (irreversible: kept until reset or seed). */
export const TelegramEmulatorSentMessage = Schema.Struct({
  message_id: Schema.Int,
  chat_id: Schema.Int,
  text: Schema.String,
  date: Schema.Int,
  disable_web_page_preview: Schema.Boolean
})

export type TelegramEmulatorSentMessage = typeof TelegramEmulatorSentMessage.Type

const Counters = Schema.Struct({
  /** Next `message_id` of a sent message. */
  nextMessageId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})

/** The whole emulator state (JSON-compatible; what `snapshot()` returns). */
export const TelegramEmulatorStateSchema = Schema.Struct({
  bot: TelegramEmulatorBot,
  chats: Schema.Array(TelegramEmulatorChat),
  files: Schema.Array(TelegramEmulatorFile),
  sentMessages: Schema.Array(TelegramEmulatorSentMessage),
  counters: Counters
})

/** The emulator state. The container is mutable; entities are replaced, never edited in place. */
export type TelegramEmulatorState = {
  bot: TelegramEmulatorBot
  chats: ReadonlyArray<TelegramEmulatorChat>
  files: ReadonlyArray<TelegramEmulatorFile>
  sentMessages: ReadonlyArray<TelegramEmulatorSentMessage>
  counters: typeof Counters.Type
}

/** Account-variance profiles for the default seed. */
export const TelegramEmulatorProfile = Schema.Literals(['default', 'empty'])

export type TelegramEmulatorProfile = typeof TelegramEmulatorProfile.Type

/**
 * A typed seed. Start from `profile` (default `'default'`, the fixture entities; `'empty'` keeps
 * only the bot); every other key, when given, replaces that part of the profile.
 * `nextMessageId` defaults to 101 (the send fixture's `message_id`).
 */
export const TelegramEmulatorSeed = Schema.Struct({
  profile: Schema.optionalKey(TelegramEmulatorProfile),
  bot: Schema.optionalKey(TelegramEmulatorBot),
  chats: Schema.optionalKey(Schema.Array(TelegramEmulatorChat)),
  files: Schema.optionalKey(Schema.Array(TelegramEmulatorFile)),
  nextMessageId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
})

export type TelegramEmulatorSeed = typeof TelegramEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeedInput = Schema.decodeUnknownResult(TelegramEmulatorSeed, strict)

const decodeStateInput = Schema.decodeUnknownResult(TelegramEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// Default entities, copied from the fixtures.

const defaultBot: TelegramEmulatorBot = {
  id: 123456789,
  first_name: 'Synthetic Practice Bot',
  username: 'yolk_synthetic_bot'
}

const defaultChats: ReadonlyArray<TelegramEmulatorChat> = [
  {
    id: -1001000000001,
    title: 'Synthetic practice group',
    type: 'supergroup',
    permissions: { can_send_messages: true },
    accent_color_id: 0,
    max_reaction_count: 11
  }
]

const defaultFiles: ReadonlyArray<TelegramEmulatorFile> = [
  {
    file_id: 'BQACAgIAAxkDAAIC-yolk_synthetic_file_0001',
    file_unique_id: 'AgADyolkSynthetic01',
    file_size: 32,
    file_path: 'documents/file_0.txt',
    content: 'yolk-conformance synthetic file\n'
  }
]

type ProfileEntities = {
  readonly bot: TelegramEmulatorBot
  readonly chats: ReadonlyArray<TelegramEmulatorChat>
  readonly files: ReadonlyArray<TelegramEmulatorFile>
}

const profileEntities = (profile: TelegramEmulatorProfile): ProfileEntities => {
  switch (profile) {
    case 'default':
      return { bot: defaultBot, chats: defaultChats, files: defaultFiles }
    case 'empty':
      return { bot: defaultBot, chats: [], files: [] }
  }
}

const duplicate = <A>(values: ReadonlyArray<A>): A | undefined =>
  values.find((value, index) => values.indexOf(value) !== index)

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength

const seedProblem = (entities: ProfileEntities): string | undefined => {
  if (entities.bot.id <= 0) return 'the bot id must be positive'

  const chat = duplicate(entities.chats.map(item => item.id))

  if (chat !== undefined) return `duplicate chat id ${chat}`

  const fileId = duplicate(entities.files.map(item => item.file_id))

  if (fileId !== undefined) return `duplicate file id ${fileId}`

  const filePath = duplicate(entities.files.map(item => item.file_path))

  if (filePath !== undefined) return `duplicate file path ${filePath}`

  const sized = entities.files.find(item => item.file_size !== utf8Length(item.content))

  return sized === undefined
    ? undefined
    : `file ${sized.file_id} has a file_size other than its content's byte length`
}

const stateFromSeed = (seed: TelegramEmulatorSeed): TelegramEmulatorState | string => {
  const profile = profileEntities(seed.profile ?? 'default')

  const entities: ProfileEntities = {
    bot: seed.bot ?? profile.bot,
    chats: seed.chats ?? profile.chats,
    files: seed.files ?? profile.files
  }

  const problem = seedProblem(entities)

  if (problem !== undefined) return problem

  return {
    ...entities,
    sentMessages: [],
    counters: { nextMessageId: seed.nextMessageId ?? 101 }
  }
}

/** Decode and build a seed; a string is the reason it is invalid. */
export const buildTelegramSeedState = (input: unknown): TelegramEmulatorState | string => {
  const decoded = decodeSeedInput(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : stateFromSeed(decoded.success)
}

/** Decode a full state (a restored snapshot); a string is the reason it is invalid. */
export const decodeTelegramState = (input: unknown): TelegramEmulatorState | string => {
  const decoded = decodeStateInput(input)

  return Result.isFailure(decoded) ? issueMessage(decoded.failure.issue) : { ...decoded.success }
}
