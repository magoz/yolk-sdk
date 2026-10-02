/**
 * Stateful Telegram Bot API emulator (`https://api.telegram.org`), built on the upstream
 * `@emulators/core` custom runtime, with a request ledger, status faults, and an `/_emulate/*`
 * control plane.
 *
 * Fixture-only: it never imports SDK code; its wire shapes and default seed are copied as data
 * from the synthetic Telegram conformance fixtures, and every route names the conformance cases it
 * follows in `telegramEmulatorRoutes`. Only the routes the four Telegram cases need are emulated
 * (`getChat`, `getFile`, the hosted file download, `sendMessage`); anything the fixtures do not
 * record answers one ledgered 400 `{ error: { type: 'not_emulated', message } }`.
 *
 * The bot token travels in the URL path (`/bot<token>/<method>`). It is required but never checked
 * against a value, stored, forwarded to the core, ledgered, or echoed. Resolution fails closed: a
 * request is recognised only when its raw path is exactly an emulated route shape
 * (`/bot<token>/<method>` or `/file/bot<token>/<file_path>`, the strict token on the raw segment,
 * an emulated method, no other path text); the token is taken from that exact segment. Every other
 * request is ledgered and answered with constant text only (`/<unrecognised>`, a standard method or
 * `<other>`, no query or body, a constant reason). For a recognised request, the ledgered method,
 * path (`/bot<redacted>/...`), query keys and values, and every not-emulated message are scrubbed
 * of the token and its secret part, and a query, remaining path, or body that repeats either (raw,
 * percent-decoded, or in any parsed JSON key, string value, or number) is refused with constant
 * text. A token whose bot id is `0` names no bot: `getChat` answers the recorded 401.
 *
 * `sendMessage` is irreversible on the real service; the emulator records each sent message in its
 * state (`sentMessages`) and never delivers anything.
 *
 * Request-shape latitude (the only accepted deviations from the fixture requests): any credential
 * value of at least 8 characters that occurs nowhere else in the request (its path, query, or body;
 * never checked against anything, stored, or ledgered); extra request headers; `content-type`
 * parameters; a well-formed `<digits>:<secret>` bot token with a secret of at least 8 characters
 * (the bot id `0` names no bot); any well-formed `chat_id` string (an integer or a public
 * `@username`; one the bot is not in answers the recorded 400 on `getChat`); any non-empty message
 * `text`.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeTelegramEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import { Data, Predicate } from 'effect'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import { statefulCoreRuntime } from './stateful-core.ts'
import {
  makeHeaderlessStatefulEmulator,
  routeEvidence,
  type StatefulCoverage,
  type StatefulErrorTexts,
  type StatefulFault,
  type StatefulFaultState,
  type StatefulHeaderlessLedgerEntry,
  type StatefulInputKind
} from './stateful-emulator.ts'
import {
  resolveTelegramRequest,
  telegramApiRoutes,
  type TelegramApiEnv,
  type TelegramEmulatorDrills
} from './telegram/api.ts'
import {
  buildTelegramSeedState,
  decodeTelegramState,
  type TelegramEmulatorSeed,
  type TelegramEmulatorState
} from './telegram/state.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export {
  StatefulFault as TelegramFault,
  StatefulFaultMatch as TelegramFaultMatch
} from './stateful-emulator.ts'

export type { TelegramEmulatorDrills } from './telegram/api.ts'

export {
  TelegramEmulatorBot,
  TelegramEmulatorChat,
  TelegramEmulatorFile,
  TelegramEmulatorProfile,
  TelegramEmulatorSeed,
  TelegramEmulatorSentMessage,
  TelegramEmulatorStateSchema,
  type TelegramEmulatorState
} from './telegram/state.ts'

/** Origin the connector calls (Bot API methods and hosted file downloads). */
export const telegramEmulatorDefaultOrigin = 'https://api.telegram.org'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. `{token}` stands for the bot
 * token path segment, which is never recorded.
 */
export const telegramEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = telegramApiRoutes.map(
  ({ route }) => routeEvidence(route)
)

export type TelegramFaultState = StatefulFaultState

export type TelegramLedgerEntry = StatefulHeaderlessLedgerEntry

export type TelegramCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed or a fault. A programmer error. */
export class TelegramEmulatorInputInvalid extends Data.TaggedError('TelegramEmulatorInputInvalid')<{
  readonly input: 'seed' | 'fault'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Telegram emulator ${this.input}: ${this.reason}`
  }
}

export type TelegramEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: TelegramEmulatorSeed
  /** Clock in epoch milliseconds (`date` of sent messages). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: TelegramEmulatorDrills
}

export type TelegramEmulator = {
  /** The fetch handler (Bot API routes, file downloads, and `/_emulate/*`). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<TelegramLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws `TelegramEmulatorInputInvalid` for an invalid fault. */
    readonly add: (fault: StatefulFault) => TelegramFaultState
    readonly list: () => ReadonlyArray<TelegramFaultState>
    readonly clear: () => void
  }
  /** Restore the current seed (dropping sent messages) and clear the ledger and faults. */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores. Rejects with
   * `TelegramEmulatorInputInvalid` for an invalid seed.
   */
  readonly seed: (seed: TelegramEmulatorSeed) => Promise<void>
  /** A deep copy of the current state (entities, sent messages, and the message counter). */
  readonly snapshot: () => TelegramEmulatorState
  readonly coverage: () => TelegramCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

/** The texts of Telegram's recovery answers (500 failed, 503 closed, 500 unhandled). */
const errorTexts: StatefulErrorTexts = {
  failed: 'Synthetic: the emulator could not build the response.',
  closed: 'Synthetic: the emulator is closed.',
  unhandled: 'emulator failed to handle the request'
}

/** The wrapper reports invalid seeds and faults only (Telegram takes no other option input). */
const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new TelegramEmulatorInputInvalid({ input: input === 'seed' ? 'seed' : 'fault', reason })

/**
 * Create a stateful Telegram Bot API emulator on the `@emulators/core` custom runtime. Each call
 * has its own state, ledger, and faults. Rejects with `TelegramEmulatorInputInvalid` for an
 * invalid seed. See `README.md` (Telegram emulator) for the wire claims.
 */
export const makeTelegramEmulator = async (
  options: TelegramEmulatorOptions = {}
): Promise<TelegramEmulator> => {
  const initial = buildTelegramSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw new TelegramEmulatorInputInvalid({ input: 'seed', reason: initial })
  }

  const drills = options.drills ?? {}

  const env: TelegramApiEnv = {
    now: options.now ?? (() => Date.now()),
    drills: {
      getChatOkFalse: drills.getChatOkFalse ?? false,
      errorsAs200: drills.errorsAs200 ?? false,
      fileSizeOffByOne: drills.fileSizeOffByOne ?? false,
      sendOkFalse: drills.sendOkFalse ?? false
    }
  }

  const emulator = await makeHeaderlessStatefulEmulator<
    TelegramEmulatorState,
    TelegramApiEnv,
    TelegramEmulatorSeed
  >(
    {
      routes: telegramApiRoutes.map(({ route }) => route),
      env,
      initial,
      buildSeed: buildTelegramSeedState,
      resolveRequest: resolveTelegramRequest,
      errorTexts,
      clearRuntime: () => undefined,
      runtimeState: () => ({ runtime: {} }),
      seedSummary: state => ({
        chats: state.chats.length,
        files: state.files.length
      }),
      inputInvalid
    },
    statefulCoreRuntime({
      name: 'telegram',
      initial,
      decodeState: decodeTelegramState,
      inputInvalid
    })
  )

  return {
    fetch: emulator.fetch,
    ledger: emulator.ledger,
    faults: emulator.faults,
    reset: emulator.reset,
    seed: emulator.seed,
    snapshot: emulator.snapshot,
    coverage: emulator.coverage,
    close: emulator.close
  }
}
