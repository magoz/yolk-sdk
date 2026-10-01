/**
 * The credential guard of the R2 port emulator (internal; used by `r2.ts`, and imported by
 * `test/r2.test.ts` for the exhaustive parity tests).
 *
 * The copied lists here mirror `@yolk-sdk/conformance` (`isPortCredentialKey`, the credential query
 * parameter names of `hasLiveCredentialParam`, `bearerPattern`, and `apiKeyPatterns`) and the R2
 * conformance guard `findR2PortFixtureSecrets` (canonical placeholders and decodings). Emulators
 * never import SDK code, so `test/r2.test.ts` holds one sample per entry of every list here,
 * asserts the sample count equals the list length, and checks each sample against the shared
 * scan; a new entry without a sample fails.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { textClosureOutcome } from './stateful-secrets.ts'

type JsonObject = Schema.JsonObject

const isJsonObject = (value: Schema.Json): value is JsonObject =>
  value !== null && Predicate.isObject(value) && !Array.isArray(value)

/**
 * The credential field names of the shared port scan (`isPortCredentialKey`): `credential(s)`
 * plus the credential field names, AWS-style `accessKeyId` / `secretAccessKey` / `sessionToken`
 * included. One regular-expression source per name; matched whole and case-insensitively.
 */
export const r2CredentialKeyNames: ReadonlyArray<string> = [
  'credentials?',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth[_-]?token',
  'api[_-]?token',
  'session[_-]?token',
  'private[_-]?token',
  'bearer[_-]?token',
  'oauth[_-]?token',
  'token',
  'client[_-]?secret',
  'secret(?:[_-]?key)?',
  'private[_-]?key',
  'password',
  'passwd',
  'api[_-]?key',
  'access[_-]?key[_-]?id',
  'secret[_-]?access[_-]?key',
  'authorization'
]

const credentialKeyPattern = new RegExp(`^(?:${r2CredentialKeyNames.join('|')})$`, 'i')

/** True for a key whose whole value is a credential (dropped, never compared or recorded). */
export const isR2CredentialKey = (key: string): boolean => credentialKeyPattern.test(key)

/**
 * The credential query or form parameter names of the shared port scan (`hasLiveCredentialParam`).
 * One regular-expression source per name.
 */
export const r2CredentialParamNames: ReadonlyArray<string> = [
  'api[_-]?key',
  'key',
  'token',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth',
  'secret',
  'password',
  'client[_-]?secret',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token'
]

// A credential parameter: a name at the start or after `?` / `&`, `=`, and a value (any character
// but `&` or `#`).
const credentialParamAt = new RegExp(`(?:^|[?&])(?:${r2CredentialParamNames.join('|')})=[^&#]`, 'i')

/**
 * The shared scan's token patterns (`bearerPattern` and `apiKeyPatterns`): a bearer token, common
 * API-key prefixes, JSON Web Tokens, and PEM private keys.
 */
export const r2TokenPatterns: ReadonlyArray<RegExp> = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bvck_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

// The SigV4 rules of the R2 conformance guard (`findR2PortFixtureSecrets` in
// `@yolk-sdk/connectors/r2-storage/conformance`), copied: the exact canonical placeholder
// occurrences are blanked out, then any credential name left in any decoding layer is refused.

/** The canonical placeholders (`syntheticPortCredentialParams`), as the fixtures write them. */
const canonicalPlaceholders = new Map<string, string>([
  ['x-amz-signature', 'yolk-synthetic-signature'],
  [
    'x-amz-credential',
    encodeURIComponent('yolk-synthetic-access-key-id/20260930/auto/s3/aws4_request')
  ]
])

const canonicalNamesAt = /(^|[?&])(x-amz-signature|x-amz-credential)=/gi

const canonicalValueEnd = /^(?:[&#\s"<>]|$)/

const withoutCanonicalPlaceholders = (text: string): string => {
  let masked = text

  for (const match of text.matchAll(canonicalNamesAt)) {
    const nameStart = match.index + (match[1] ?? '').length
    const valueStart = match.index + match[0].length
    const placeholder = canonicalPlaceholders.get((match[2] ?? '').toLowerCase()) ?? ''
    const valueEnd = valueStart + placeholder.length

    if (
      placeholder.length > 0 &&
      text.startsWith(placeholder, valueStart) &&
      canonicalValueEnd.test(text.slice(valueEnd))
    ) {
      const blank = ' '.repeat(valueEnd - nameStart)

      masked = `${masked.slice(0, nameStart)}${blank}${masked.slice(valueEnd)}`
    }
  }

  return masked
}

const percentDecodedOnce = (text: string): string =>
  text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )

const codePoint = (value: number): string => String.fromCodePoint(Math.min(value, 0x10ffff))

const escapesDecodedOnce = (text: string): string =>
  text.replace(
    /\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\\\|&#[xX]([0-9A-Fa-f]{1,6});?|&#([0-9]{1,7});?/g,
    (match, unicode?: string, hex?: string, entityHex?: string, entity?: string) => {
      const hexDigits = unicode ?? hex ?? entityHex

      if (hexDigits !== undefined) return codePoint(Number.parseInt(hexDigits, 16))

      if (entity !== undefined) return codePoint(Number.parseInt(entity, 10))

      return match === '\\\\' ? '\\' : match
    }
  )

const maxRoundsPerDecoding = 3

/** `text` and every variant within three percent rounds and three escape rounds, in any order. */
const decodedVariants = (text: string): ReadonlyArray<string> => {
  const seen = new Set<string>([text])

  let frontier: ReadonlyArray<{ text: string; percent: number; escapes: number }> = [
    { text, percent: 0, escapes: 0 }
  ]

  while (frontier.length > 0) {
    frontier = frontier.flatMap(variant =>
      [
        ...(variant.percent < maxRoundsPerDecoding
          ? [{ ...variant, text: percentDecodedOnce(variant.text), percent: variant.percent + 1 }]
          : []),
        ...(variant.escapes < maxRoundsPerDecoding
          ? [{ ...variant, text: escapesDecodedOnce(variant.text), escapes: variant.escapes + 1 }]
          : [])
      ].filter(candidate => {
        if (seen.has(candidate.text)) return false

        seen.add(candidate.text)

        return true
      })
    )
  }

  return [...seen]
}

const sigV4CredentialNames = /x-amz-credential|x-amz-signature|x-amz-security-token/i

/** True when `text` holds a SigV4 credential name, a credential parameter, or a token. */
const credentialText = (text: string): boolean =>
  sigV4CredentialNames.test(text) ||
  credentialParamAt.test(text) ||
  r2TokenPatterns.some(pattern => pattern.test(text))

/**
 * True when `text`, once its exact canonical placeholder occurrences are blanked out, holds a
 * credential (`credentialText`) raw, in any variant within three percent and three escape rounds
 * (the R2 guard's decodings), or anywhere in the fail-closed closure of `textClosureOutcome`
 * (any depth of percent-encoding and JSON escaping; a work cap counts as a credential).
 */
const carriesCredential = (text: string): boolean => {
  const masked = withoutCanonicalPlaceholders(text)

  return (
    decodedVariants(masked).some(credentialText) ||
    textClosureOutcome(masked, credentialText) !== 'clear'
  )
}

/**
 * True when `text` repeats a guarded value: raw, in any of R2's own decodings (`decodedVariants`:
 * percent, `\uXXXX` of any code point, `\xXX`, numeric HTML references, in any order), or
 * anywhere in the shared closure (a work cap counts as a repeat). Every non-empty value is
 * guarded: unlike the shared `textRepeatsSecret`, there is no minimum length.
 */
const repeatsGuardedValue = (text: string, guarded: ReadonlyArray<string>): boolean => {
  if (guarded.length === 0) return false

  const holds = (candidate: string) => guarded.some(value => candidate.includes(value))

  return decodedVariants(text).some(holds) || textClosureOutcome(text, holds) !== 'clear'
}

/** True when `text` carries a credential or repeats a guarded value. */
export const textCarriesCredential = (text: string, guarded: ReadonlyArray<string>): boolean =>
  carriesCredential(text) || repeatsGuardedValue(text, guarded)

const numericText = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/

/**
 * The texts a number is matched by: as JavaScript prints it (`1e+21`, `12345678`) and, for an
 * integer, its full digit string (`1000000000000000000000`).
 */
export const numberTexts = (value: number): ReadonlyArray<string> =>
  Number.isSafeInteger(value) || !Number.isInteger(value)
    ? [String(value)]
    : [String(value), BigInt(value).toString()]

/** A guarded value and, when it is numeric text (`0012345678`), the forms of its number. */
const guardedForms = (value: string): ReadonlyArray<string> => {
  if (value.length === 0) return []

  const number = Number(value)

  return numericText.test(value) && Number.isFinite(number)
    ? [value, ...numberTexts(number)]
    : [value]
}

/** Every key, string, and number under a credential field, at any depth (the values to guard). */
const credentialSubtree = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return guardedForms(value)

  if (Predicate.isNumber(value)) return numberTexts(value)

  if (Array.isArray(value)) return value.flatMap(credentialSubtree)

  return isJsonObject(value)
    ? Object.entries(value).flatMap(([key, item]) => [
        ...guardedForms(key),
        ...credentialSubtree(item)
      ])
    : []
}

/** The guarded values of every credential field of `value`, at any depth, deduplicated. */
export const guardedValues = (value: Schema.Json): ReadonlyArray<string> => {
  const collect = (item: Schema.Json): ReadonlyArray<string> => {
    if (Array.isArray(item)) return item.flatMap(collect)

    if (!isJsonObject(item)) return []

    return Object.entries(item).flatMap(([key, child]) =>
      isR2CredentialKey(key) ? credentialSubtree(child) : collect(child)
    )
  }

  return [...new Set(collect(value))]
}

/** True when `value` holds an own `__proto__` key at any depth (an admission bypass otherwise). */
export const hasOwnProtoKey = (value: Schema.Json): boolean => {
  if (Array.isArray(value)) return value.some(hasOwnProtoKey)

  if (!isJsonObject(value)) return false

  return Object.hasOwn(value, '__proto__') || Object.values(value).some(hasOwnProtoKey)
}

const strippedOf = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(strippedOf)

  return isJsonObject(value) ? withoutCredentials(value) : value
}

/**
 * A copy without credential fields, at any depth (`redactPortPayload` of the shared scan), built
 * with own data properties only (`Object.fromEntries`).
 */
export const withoutCredentials = (value: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      isR2CredentialKey(key) ? [] : [[key, strippedOf(item)]]
    )
  )

/** Every object key, string value, and number (`numberTexts`) of `value`. */
export const textsOf = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value]

  if (Predicate.isNumber(value)) return numberTexts(value)

  if (Array.isArray(value)) return value.flatMap(textsOf)

  return isJsonObject(value)
    ? Object.entries(value).flatMap(([key, item]) => [key, ...textsOf(item)])
    : []
}
