import { Predicate } from 'effect'

export { contentPreview } from '@yolk-sdk/agent/protocol'

export type JsonPreviewObject = {
  readonly [key: string]: JsonPreviewValue
}

export type JsonPreviewValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | ReadonlyArray<JsonPreviewValue>
  | JsonPreviewObject

export const isJsonPreviewValue = (value: unknown): value is JsonPreviewValue => {
  if (value === null) {
    return true
  }

  if (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isSymbol(value)
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isJsonPreviewValue)
  }

  if (!Predicate.isObjectOrArray(value)) {
    return false
  }

  return Object.values(value).every(isJsonPreviewValue)
}

export const truncate = (value: string) =>
  value.length > 240 ? `${value.slice(0, 237)}...` : value

export const jsonPreview = (value: JsonPreviewValue) => {
  if (value === null) {
    return 'null'
  }

  if (Predicate.isString(value)) {
    return truncate(value)
  }

  if (Predicate.isNumber(value) || Predicate.isBoolean(value) || Predicate.isBigInt(value)) {
    return String(value)
  }

  if (Predicate.isSymbol(value)) {
    return String(value)
  }

  const encoded = JSON.stringify(value)

  return truncate(encoded ?? String(value))
}

export const unknownPreview = (value: unknown) => {
  if (isJsonPreviewValue(value)) {
    return jsonPreview(value)
  }

  const encoded = JSON.stringify(value)

  return truncate(encoded ?? String(value))
}

export const countLabel = (count: number, singular: string) =>
  `${count} ${count === 1 ? singular : `${singular}s`}`
