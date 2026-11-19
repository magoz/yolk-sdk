import { parse, stringify } from 'devalue'
import { Option } from 'effect'
import * as Schema from 'effect/Schema'

/**
 * How values cross a durable boundary (a step's result or error, a hook payload, a run's input and
 * result): devalue, like Vercel Workflow, so the same values survive (Date, Map, Set, typed arrays,
 * undefined) and errors keep their name, message, stack, cause and the platform's step signals
 * (`fatal`, `retryAfter`). Anything else on an error is dropped, as the platform does.
 */

const StoredError = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.Unknown,
  Schema.Boolean,
  Schema.UndefinedOr(Schema.Number)
])

/** `[name, message, stack, cause, fatal, retryAfter]`. */
type StoredError = typeof StoredError.Type

const decodeStoredError = Schema.decodeUnknownOption(StoredError)

const ownValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)

  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

const reduceError = (value: unknown): StoredError | false => {
  if (!(value instanceof Error)) return false

  const retryAfter = ownValue(value, 'retryAfter')

  return [
    value.name,
    value.message,
    value.stack ?? '',
    ownValue(value, 'cause'),
    ownValue(value, 'fatal') === true,
    retryAfter instanceof Date ? retryAfter.getTime() : undefined
  ]
}

const reviveError = (value: unknown): Error => {
  const stored = decodeStoredError(value)

  if (Option.isNone(stored)) return new Error('Unreadable stored error')

  const [name, message, stack, cause, fatal, retryAfter] = stored.value
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })

  error.name = name
  error.stack = stack

  if (fatal) Object.defineProperty(error, 'fatal', { value: true, enumerable: true })

  if (retryAfter !== undefined) {
    Object.defineProperty(error, 'retryAfter', { value: new Date(retryAfter), enumerable: true })
  }

  return error
}

export const serialize = (value: unknown): string => stringify(value, { Error: reduceError })

export const deserialize = (text: string): unknown => parse(text, { Error: reviveError })
