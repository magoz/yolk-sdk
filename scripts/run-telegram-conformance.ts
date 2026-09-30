/**
 * Telegram conformance runner for a practice Telegram bot (`pnpm conformance:telegram`).
 *
 * Default: DRY RUN. Prints every case id, its safety, and whether it would run under the chosen
 * flags, then exits without any network call or credential read.
 *
 * `--live --owner-approved --account <label>`: runs the cases against the real Bot API with a
 * `FetchHttpClient`, through the real connector actions and the host-only `downloadTelegramFile`.
 * Refused whenever `CI` is non-empty and without `--owner-approved`. Requires `TELEGRAM_BOT_TOKEN`
 * (environment only, never a flag; the practice bot's token) and the seeds of every case that will
 * run (flags or environment, see the usage text). The read cases always run. There are no
 * write-reversible Telegram cases. The one write case, `telegram.messages.send-message`, is
 * write-irreversible: it posts a real message to `--chat` that the connector cannot delete, so it
 * runs only when named with `--allow-irreversible telegram.messages.send-message` (`--allow-writes`
 * never starts it). Its text names a fresh random `runId` the runner generates per invocation (never
 * a flag); an ambiguous send is reported with the exact text to look for in the chat. There is no
 * leftover lookup: the Bot API cannot list the messages a bot sent, and nothing is ever cleaned up.
 *
 * The bot token is part of every Bot API URL (`/bot<token>/`), so `--record` replaces it with the
 * synthetic `telegramConformanceReplayBotToken` in every recorded URL before the fixture is built,
 * verifies on replay with that token, and refuses to stage any recording in which the live token, or
 * its secret part, survives anywhere (URLs, headers, decoded bodies, reassembled stream chunks,
 * unescaped JSON strings) or that holds a body the guard cannot fully inspect (for example a
 * compressed file: seed a small plain-text file). A live token that is not `<bot id>:<secret>` is
 * refused before any request. `--record` stages verified recordings all or nothing in a new run directory under the
 * gitignored `.conformance-recordings/telegram/`. Promotion is manual: scrub the staged files of
 * practice-account data (chat ids and titles, bot and user names, file ids and paths, message
 * text, file bytes), copy them into `packages/connectors/src/telegram/conformance/`, run
 * `pnpm format:fix`, and update `packages/connectors/test/telegram-conformance.test.ts` and
 * `scripts/test/run-telegram-conformance.test.ts` in the same change. See
 * `connector-conformance-internal.ts` for the shared gates.
 *
 * Never run live in CI.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Layer } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClient } from 'effect/unstable/http'
import type { WireExchange } from '../packages/conformance/src/fixture.ts'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '../packages/connectors/src/conformance/index.ts'
import { ApiKeyCredential } from '../packages/connectors/src/credential.ts'
import {
  TelegramConformanceConfig,
  TelegramConformanceSeeds,
  telegramConformanceCases,
  telegramConformanceFixtureSeeds,
  telegramConformanceReplayBotToken,
  type TelegramConformanceError,
  type TelegramConformanceRequirements,
  type TelegramConformanceSeedKey
} from '../packages/connectors/src/telegram/conformance/index.ts'
import { telegramApiBaseUrl } from '../packages/connectors/src/telegram/index.ts'
import {
  recordingsRootFor,
  runConnectorConformanceCli,
  type CaseSpec,
  type ConnectorConformanceRunner,
  type SeedSource
} from './connector-conformance-internal.ts'

/** Where each seed comes from. Flags win over environment variables. */
export const telegramSeedSources: ReadonlyArray<SeedSource<TelegramConformanceSeedKey>> = [
  {
    key: 'chatId',
    flag: '--chat',
    env: 'TELEGRAM_CONFORMANCE_CHAT',
    description: 'practice chat id (or @username) the bot is a member of'
  },
  {
    key: 'fileId',
    flag: '--file-id',
    env: 'TELEGRAM_CONFORMANCE_FILE_ID',
    description: 'file_id of a small file (at most 1 MB) the bot received'
  }
]

/** Seeds each case needs, and the fixture module `--record` rewrites for it. */
export const telegramCaseSpecs: ReadonlyArray<CaseSpec<TelegramConformanceSeedKey>> = [
  {
    caseId: 'telegram.validate.get-chat',
    seeds: ['chatId'],
    optionalSeeds: [],
    fileName: 'validate-get-chat.ts',
    exportName: 'telegramValidateGetChatFixture',
    doc: '`telegram.validate` for the seeded chat: one POST `getChat`, answered with `{ ok: true, result }`.'
  },
  {
    caseId: 'telegram.errors.error-envelope',
    seeds: ['chatId'],
    optionalSeeds: [],
    fileName: 'error-envelope.ts',
    exportName: 'telegramErrorEnvelopeFixture',
    doc: '`telegram.validate` for an absent chat, then with an invalid bot token, both answered with the Bot API error envelope.'
  },
  {
    caseId: 'telegram.files.get-file-path',
    seeds: ['fileId'],
    optionalSeeds: [],
    fileName: 'get-file-path.ts',
    exportName: 'telegramGetFilePathFixture',
    doc: '`downloadTelegramFile` of the seeded file id: `getFile`, then the hosted file download.'
  },
  {
    caseId: 'telegram.messages.send-message',
    seeds: ['chatId', 'runId'],
    optionalSeeds: [],
    fileName: 'send-message.ts',
    exportName: 'telegramSendMessageFixture',
    doc: '`telegram.send_message` of the synthetic run-scoped text to the seeded chat.'
  }
]

/** A fresh invocation-unique run id (`run-<8 hex>`), named in the sent message text. */
export const generateRunId = (): string => `run-${randomBytes(4).toString('hex')}`

/** The live credential: the practice bot's token. */
export const liveCredential = (accessToken: string) => ApiKeyCredential.make({ key: accessToken })

/**
 * Replace the live bot token in every recorded URL (`/bot<token>/` and `/file/bot<token>/`) with
 * the synthetic replay token the committed fixtures use.
 */
export const scrubTelegramRecording = (
  exchanges: ReadonlyArray<WireExchange>,
  accessToken: string
): ReadonlyArray<WireExchange> =>
  exchanges.map(exchange => ({
    ...exchange,
    request: {
      ...exchange.request,
      url: exchange.request.url.replaceAll(
        `/bot${accessToken}/`,
        `/bot${telegramConformanceReplayBotToken}/`
      )
    }
  }))

const casePorts = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  accessToken: string,
  seeds: TelegramConformanceSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    staticCredentialResolverLayer(liveCredential(accessToken)),
    Layer.succeed(TelegramConformanceConfig, seeds)
  )

export const telegramRunner = {
  provider: 'telegram',
  displayName: 'Telegram',
  practiceTarget: 'a practice Telegram bot and chat',
  tokenEnv: 'TELEGRAM_BOT_TOKEN',
  tokenScopes: "the practice bot's token from @BotFather; the bot must be a member of --chat",
  endpoint: telegramApiBaseUrl,
  irreversibleNote:
    'The write-irreversible telegram.messages.send-message case posts a real message naming a fresh run id to --chat that the connector cannot delete; it runs only with --allow-irreversible telegram.messages.send-message',
  cases: telegramConformanceCases,
  seedSources: telegramSeedSources,
  generatedSeeds: { keys: ['runId'], generate: () => ({ runId: generateRunId() }) },
  caseSpecs: telegramCaseSpecs,
  fixtureSeeds: telegramConformanceFixtureSeeds,
  seedNoun: 'ids',
  seedsTypeName: 'TelegramConformanceSeeds',
  seedsExportName: 'telegramConformanceFixtureSeeds',
  configName: 'TelegramConformanceConfig',
  decodeSeeds: Schema.decodeUnknownOption(TelegramConformanceSeeds),
  invalidSeedsMessage:
    '--chat must be an integer chat id or @username, and --file-id a Bot API file_id (letters, digits, underscores, and hyphens)',
  casePorts,
  recordedRequestHeaders: [],
  // Checked before any request, never printed; downloadTelegramFile requires the same shape.
  tokenFormat: {
    pattern: /^[0-9]+:[A-Za-z0-9_-]+$/,
    description:
      'a bot token of the form <bot id>:<secret> (digits, a colon, then letters, digits, _ or -)'
  },
  // No cleanup exists, and there is no leftover lookup: only the chat itself shows what was sent.
  recoveryAdvice:
    'A message the send case posted stays in --chat (the connector cannot delete it): look there for yolk-conformance <run id> messages by hand; nothing else is created.',
  // The bot token is in every URL path: recordings carry the synthetic replay token instead.
  scrubRecording: scrubTelegramRecording,
  replayAccessToken: telegramConformanceReplayBotToken,
  nameKeys: /^(?:first_name|last_name|username|title|file_name|file_path)$/,
  textKeys: /^(?:text|caption|description|bio)$/
} satisfies ConnectorConformanceRunner<
  TelegramConformanceSeedKey,
  TelegramConformanceSeeds,
  TelegramConformanceError,
  TelegramConformanceRequirements
>

/** Gitignored root of staged Telegram recordings. */
export const recordingsRoot = recordingsRootFor(telegramRunner.provider)

const invokedAsCli = (): boolean => {
  const invoked = process.argv[1]

  return invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)
}

if (invokedAsCli()) {
  runConnectorConformanceCli(telegramRunner)
}
