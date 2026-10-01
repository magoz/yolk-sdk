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
 * `src/stateful-fixture.ts`; the fail-closed mode of `src/stateful-emulator.ts` uses
 * `textRepeatsSecret`, a bounded decoding closure, and recognises only bearers outside the
 * JSON-number alphabet (`isRecognisableBearerValue`).
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

/** True when a bearer value holds a character outside the JSON-number alphabet `[0-9.eE+-]`. */
export const isRecognisableBearerValue = (value: string): boolean => !jsonNumberAlphabet.test(value)

/** How many rounds of decoding `textRepeatsSecret` applies (after checking the raw text). */
export const secretClosureRounds = 4

/** The string values and object keys of a parsed JSON value, at any depth. */
const jsonStrings = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value]

  if (Array.isArray(value)) return value.flatMap(jsonStrings)

  if (isJsonRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonStrings(item)])
  }

  return []
}

/** One decoding round of a text: its percent-decodings, and its JSON strings when it parses. */
const decodings = (text: string): ReadonlyArray<string> => {
  const parsed = text.trim() === '' ? undefined : parseJsonText(text)

  return [
    decodedOrRaw(text),
    decodedOrRaw(text.replaceAll('+', ' ')),
    ...(parsed === undefined ? [] : jsonStrings(parsed))
  ]
}

/**
 * True when `text` repeats a secret anywhere in its bounded decoding closure: starting from the raw
 * text, up to `secretClosureRounds` rounds, each applying percent-decoding and, when a text parses
 * as JSON, taking its string values and object keys (so `\u` escapes are undone); every
 * intermediate text is checked. A breadth-first walk with deduplication. Numbers need no handling:
 * a recognisable bearer never fits the JSON-number alphabet.
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
      for (const decoded of decodings(candidate)) {
        if (!seen.has(decoded)) {
          seen.add(decoded)
          next.push(decoded)
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
