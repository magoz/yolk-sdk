/**
 * Credential guarding and the fail-closed ledger constants shared by both stateful wrappers
 * (internal; imported by `src/stateful-fixture.ts` and `src/stateful-emulator.ts`, which issue #139
 * consolidates). No Node builtin and no core import, so both wrappers stay runtime-portable.
 *
 * A guarded secret (a request-carried credential value the wrapper extracted from a recognised
 * request shape) must never reach the ledger, a response, or `/_emulate/*`: `scrubSecrets` removes
 * it from everything recorded or answered, and the `*RepeatsSecret` checks find it in request text
 * so a request repeating it can be refused. `repeatsSecret` and `jsonRepeatsSecret` (raw, once
 * percent-decoded, parsed JSON keys, strings, and numbers as JavaScript prints them) serve
 * `src/stateful-fixture.ts`, unchanged; the fail-closed mode of `src/stateful-emulator.ts` uses
 * `textRepeatsSecret`, a bounded closure of two total, lexical transforms that cannot fail
 * (`tolerantPercentDecode`, `tolerantJsonUnescape`), and recognises only RFC 6750 `b64token`
 * bearers outside the JSON-number alphabet (`isRecognisableBearerValue`).
 *
 * @experimental
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'

/** The ledgered path of every unrecognised request (constant: nothing from the request). */
export const unrecognisedLedgerPath = '/<unrecognised>'

const ledgerableMethods: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
])

/** The ledgered method of an unrecognised request: a standard method, or `<other>`. */
export const unrecognisedMethod = (method: string): string =>
  ledgerableMethods.has(method) ? method : '<other>'

/** `value` percent-decoded once, or unchanged when it is not valid percent-encoding. */
export const decodedOrRaw = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Secrets shorter than this are not scrubbed (they would redact ordinary text). */
const minimumSecretLength = 4

const meaningful = (secrets: ReadonlyArray<string>): ReadonlyArray<string> =>
  secrets.filter(secret => secret.length >= minimumSecretLength)

/** True when `text`, raw or percent-decoded, contains a secret. */
export const repeatsSecret = (text: string, secrets: ReadonlyArray<string>): boolean => {
  const decoded = decodedOrRaw(text.replaceAll('+', ' '))

  return meaningful(secrets).some(secret => text.includes(secret) || decoded.includes(secret))
}

const isJsonRecord = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && Predicate.isObject(value) && !Array.isArray(value)

/**
 * True when any object key, string value, or number of `value` (raw or percent-decoded) holds a
 * secret. Numbers are checked as JavaScript prints them (`1.2345678e7` parses to `12345678`). Used
 * by `src/stateful-fixture.ts` (Todoist, Telegram), unchanged.
 */
export const jsonRepeatsSecret = (value: Schema.Json, secrets: ReadonlyArray<string>): boolean => {
  if (Predicate.isString(value)) return repeatsSecret(value, secrets)

  if (Predicate.isNumber(value)) return repeatsSecret(String(value), secrets)

  if (Array.isArray(value)) return value.some(item => jsonRepeatsSecret(item, secrets))

  if (isJsonRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => repeatsSecret(key, secrets) || jsonRepeatsSecret(item, secrets)
    )
  }

  return false
}

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

/**
 * The JSON-number alphabet. A fail-closed bearer must hold at least one character outside it
 * (`isRecognisableBearerValue`), so no number's text can ever contain or equal it: numeric forms
 * (`1.2345678e7`, any precision) need no normalisation.
 */
const jsonNumberAlphabet = /^[0-9.eE+-]+$/

/**
 * The RFC 6750 `b64token` syntax (`1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="`),
 * at least 8 characters: what every GitHub (`ghp_…`, `github_pat_…`, `gho_…`) and Google (`ya29.…`)
 * token is made of. Why exactly this: it holds no escape introducer the closure's transforms
 * recognise (`%`, `\`, nor `"`), so no escape can start inside a bearer; with `firstCharacter`,
 * no escape starting to its left can complete with its first character either (see there).
 */
const b64token = /^[A-Za-z0-9\-._~+/]+=*$/

/**
 * The first character a fail-closed bearer may start with: `[G-Zg-z\-._~+/]` without the
 * lower-case JSON escape letters `n`, `r`, `t`, `u`. Proof that no neighbour can then hide the
 * bearer:
 *
 * 1. The bearer holds no escape introducer (a `b64token` has no `%`, `\`, or `"`), so no escape
 *    the transforms recognise can start inside it.
 * 2. An escape that starts to its left (a stray `%`, `%X`, `\`, `\u`, `\u0`, `\u00`, `\u006`, or
 *    such an introducer produced by an earlier round, `%25` or `%5C` decoded) can only reach the
 *    bearer by consuming its first character. That character completes no escape form: it is no
 *    hex digit (so no `%X`, `%XX`, or `\uXXXX` prefix completes with it) and no short JSON escape
 *    letter (`b` and `f` are hex; `n`, `r`, `t`, `u` are excluded). `/` is kept: `\/` decodes to
 *    `/`, which leaves the character in place.
 * 3. So the bearer's characters always decode in place, and the closure finds the bearer once its
 *    own encodings are undone.
 *
 * Upper-case `N`, `R`, `T`, `U` are allowed: the JSON escape letters are case-sensitive, and
 * `tolerantJsonUnescape` recognises only the lower-case ones (`\N` stays as it is), so they
 * complete no escape either.
 */
const firstCharacter = /^[G-Zg-mo-qsv-z\-._~+/]/

/**
 * True when a bearer value matches the RFC 6750 `b64token` syntax exactly (at least 8
 * characters), starts with a character that completes no escape (`firstCharacter`), and holds a
 * character outside the JSON-number alphabet `[0-9.eE+-]`, so it is never the text of a number
 * and no escape can be shifted across its characters.
 */
export const isRecognisableBearerValue = (value: string): boolean =>
  value.length >= 8 &&
  b64token.test(value) &&
  firstCharacter.test(value) &&
  !jsonNumberAlphabet.test(value)

/** How many rounds `textRepeatsSecret` applies (after checking the raw text). */
export const secretClosureRounds = 4

/**
 * Tolerant percent-decode, total: every `%XX` whose value is below `0x80` becomes its ASCII
 * character; every other `%` sequence (a stray `%`, `%E9`, `%zz`) is left as it is. It never
 * throws, so an encoded fragment next to `100%` or `%E9` is still decoded.
 */
export const tolerantPercentDecode = (text: string): string =>
  text.replace(/%([0-7][0-9A-Fa-f])/g, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )

/** The short JSON escapes and the characters they stand for. */
const jsonEscapes = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t']
])

/**
 * Tolerant JSON-unescape, total and lexical: within any text, whether or not it parses as JSON,
 * `\uXXXX` below `\u0080` and `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` become their
 * characters (one left-to-right pass); every other sequence is left as it is. Being lexical, it
 * sees every string of a JSON text, duplicate keys and overwritten values included.
 */
export const tolerantJsonUnescape = (text: string): string =>
  text.replace(/\\(?:u([0-9A-Fa-f]{4})|(["\\/bfnrt]))/g, (escape, hex?: string, short?: string) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16)

      return code < 0x80 ? String.fromCharCode(code) : escape
    }

    return jsonEscapes.get(short ?? '') ?? escape
  })

/**
 * True when `text` repeats a secret anywhere in its bounded closure: starting from the raw text, up
 * to `secretClosureRounds` rounds, each applying either total transform (`tolerantPercentDecode`,
 * `tolerantJsonUnescape`) to every text of the previous round, deduplicated; every intermediate
 * text is checked for a secret as a substring. So up to four layers of percent-encoding or JSON
 * escaping, in any order, are seen through. No JSON is parsed and nothing can fail, and each round
 * holds at most twice the texts of the one before, none longer than the raw text. Numbers need no
 * handling: a recognisable bearer never fits the JSON-number alphabet.
 */
export const textRepeatsSecret = (text: string, secrets: ReadonlyArray<string>): boolean => {
  const guarded = meaningful(secrets)

  if (guarded.length === 0) return false

  const seen = new Set([text])
  let frontier: ReadonlyArray<string> = [text]

  for (let round = 0; frontier.length > 0; round += 1) {
    if (frontier.some(candidate => guarded.some(secret => candidate.includes(secret)))) {
      return true
    }

    if (round === secretClosureRounds) return false

    const next: Array<string> = []

    for (const candidate of frontier) {
      for (const transformed of [
        tolerantPercentDecode(candidate),
        tolerantJsonUnescape(candidate)
      ]) {
        if (!seen.has(transformed)) {
          seen.add(transformed)
          next.push(transformed)
        }
      }
    }

    frontier = next
  }

  return false
}

/**
 * `text` with every secret (raw and percent-encoded) replaced by `<redacted>`; when a secret still
 * shows after that (for example in another percent-encoding), the whole text is `<redacted>`.
 * Applied to everything the ledger keeps or a refusal answers.
 */
export const scrubSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  const variants = meaningful(secrets)
    .flatMap(secret => [secret, encodeURIComponent(secret)])
    .sort((left, right) => right.length - left.length)

  let result = text

  for (const variant of variants) result = result.replaceAll(variant, '<redacted>')

  return repeatsSecret(result, secrets) ? '<redacted>' : result
}
