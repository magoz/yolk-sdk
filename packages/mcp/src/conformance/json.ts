/**
 * JSON views of wire text, with the SDK's `JSON.parse` semantics (internal).
 *
 * The pinned SDK parses answers with `JSON.parse`, which turns an out-of-range number such as
 * `1e400` into `Infinity`, and its loose schemas accept that in unvalidated positions. Effect's
 * `Schema.Json` rejects non-finite numbers, so reading answers with it would see "not JSON" where
 * the client sees a value. Every answer the cases and the observer read goes through
 * `parseWireJson` (`Schema.fromJsonString(Schema.Unknown)`, which is `JSON.parse`), and
 * `isWireJson` then accepts the parsed value structurally, non-finite numbers included.
 *
 * @experimental
 */
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'

export type Json = Schema.Json

export type JsonObject = Schema.JsonObject

const parseUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A value `JSON.parse` can produce (numbers may be non-finite, as `1e400` parses to Infinity). */
export const isWireJson = (value: unknown): value is Json => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return true
  }

  if (Predicate.isNumber(value)) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isWireJson)
  }

  return Predicate.isObject(value) && Object.values(value).every(isWireJson)
}

/** Parse wire text as `JSON.parse` does; `None` when it is not JSON. */
export const parseWireJson = (text: string): Option.Option<Json> =>
  Option.filter(parseUnknown(text), isWireJson)

export const isJsonObject = (value: Json | undefined): value is JsonObject =>
  Predicate.isObject(value)

export const field = (value: Json | undefined, key: string): Json | undefined =>
  isJsonObject(value) ? value[key] : undefined
