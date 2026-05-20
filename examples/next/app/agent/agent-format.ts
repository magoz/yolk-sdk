export { contentPreview } from '@yolk-sdk/agent/protocol'

export const truncate = (value: string) =>
  value.length > 240 ? `${value.slice(0, 237)}...` : value

export const unknownPreview = (value: unknown) => {
  if (value === null) {
    return 'null'
  }

  if (typeof value === 'string') {
    return truncate(value)
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value)
  }

  const encoded = JSON.stringify(value)
  return truncate(encoded ?? String(value))
}

export const countLabel = (count: number, singular: string) =>
  `${count} ${count === 1 ? singular : `${singular}s`}`
