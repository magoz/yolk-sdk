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
import {
  makeStatefulFixtureEmulator,
  type StatefulFixtureCoverage,
  type StatefulFixtureFault,
  type StatefulFixtureFaultState,
  type StatefulFixtureLedgerEntry
} from './stateful-fixture.ts'
import {
  registerTelegramApi,
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
  StatefulFixtureFault as TelegramFault,
  StatefulFixtureFaultMatch as TelegramFaultMatch
} from './stateful-fixture.ts'

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
  ({ handler: _handler, queryKeys: _queryKeys, corePath: _corePath, ...evidence }) => evidence
)

export type TelegramFaultState = StatefulFixtureFaultState

export type TelegramLedgerEntry = StatefulFixtureLedgerEntry

export type TelegramCoverage = StatefulFixtureCoverage

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
    readonly add: (fault: StatefulFixtureFault) => TelegramFaultState
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

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const definition = core.defineEmulator<TelegramEmulatorState>({
    name: 'telegram',
    cors: false,
    state: () => initial,
    validateSeed: value => {
      const decoded = decodeTelegramState(value)

      if (Predicate.isString(decoded)) {
        throw new TelegramEmulatorInputInvalid({ input: 'seed', reason: decoded })
      }

      return decoded
    },
    setup: ({ app, state }) => registerTelegramApi(app, state, env)
  })

  const runtime = await core.createCustomRuntime(definition, { seed: initial })

  const emulator = makeStatefulFixtureEmulator<TelegramEmulatorState, TelegramEmulatorSeed>({
    routes: telegramEmulatorRoutes,
    initial,
    runtime: {
      baseUrl: runtime.baseUrl,
      fetch: request => runtime.fetch(request),
      snapshot: () => runtime.snapshot().state,
      restore: state => runtime.restore({ ...runtime.snapshot(), state }),
      close: () => runtime.close()
    },
    resolve: resolveTelegramRequest,
    buildSeed: buildTelegramSeedState,
    clearRuntime: () => undefined,
    runtimeState: () => ({}),
    seedSummary: state => ({
      chats: state.chats.length,
      files: state.files.length
    })
  })

  return {
    fetch: emulator.fetch,
    ledger: emulator.ledger,
    faults: {
      add: fault => {
        const added = emulator.faults.add(fault)

        if (Predicate.isString(added)) {
          throw new TelegramEmulatorInputInvalid({ input: 'fault', reason: added })
        }

        return added
      },
      list: emulator.faults.list,
      clear: emulator.faults.clear
    },
    reset: emulator.reset,
    seed: async input => {
      const problem = await emulator.seed(input)

      if (problem !== undefined) {
        throw new TelegramEmulatorInputInvalid({ input: 'seed', reason: problem })
      }
    },
    snapshot: emulator.snapshot,
    coverage: emulator.coverage,
    close: emulator.close
  }
}
