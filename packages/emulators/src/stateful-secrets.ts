/**
 * Credential guarding and the fail-closed ledger constants shared by both stateful wrappers
 * (internal; imported by `src/stateful-fixture.ts` and `src/stateful-emulator.ts`, which issue #139
 * consolidates). No Node builtin and no core import, so both wrappers stay runtime-portable.
 *
 * A guarded secret (a request-carried credential value the wrapper extracted from a recognised
 * request shape) must never reach the ledger, a response, or `/_emulate/*`: `scrubSecrets` removes
 * it from everything recorded or answered, and the `*RepeatsSecret` checks find it in request text
 * raw, percent-decoded, or in any parsed JSON form (keys, string values with `\u` escapes undone,
 * and numbers as JavaScript prints them), so a request repeating it can be refused.
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
 * secret. Numbers are checked as JavaScript prints them (`1.2345678e7` parses to `12345678`).
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

const jsonNumberPattern = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * True when `text` looks like JSON that parses to something other than itself: an object, an
 * array, a string (`"..."`), or a number (`1.2345678e7`). Such text is checked in its parsed form
 * too.
 */
const looksLikeJson = (text: string): boolean => {
  const trimmed = text.trim()

  return (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('"') ||
    jsonNumberPattern.test(trimmed)
  )
}

/**
 * True when `text` repeats a secret raw, percent-decoded, or, when it parses as JSON, in any key,
 * string value, or number of the parsed value or in the value as it would be recorded (so `\u`
 * escapes and normalised numbers such as `1.2345678e7` are caught). `parse` is `'json-looking'`
 * (only text that looks like JSON, for query parts, headers, and path segments) or `'any'` (any
 * text, for a body). The one place this escape and number logic lives.
 */
export const textRepeatsSecret = (
  text: string,
  secrets: ReadonlyArray<string>,
  parse: 'json-looking' | 'any' = 'json-looking'
): boolean => {
  if (meaningful(secrets).length === 0) return false

  if (repeatsSecret(text, secrets)) return true

  const parsed =
    text !== '' && (parse === 'any' || looksLikeJson(text)) ? parseJsonText(text) : undefined

  return (
    parsed !== undefined &&
    (jsonRepeatsSecret(parsed, secrets) || repeatsSecret(JSON.stringify(parsed), secrets))
  )
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
