/** Zero-based cell position. */
export type CellPosition = {
  readonly r: number
  readonly c: number
}

export type CellRange = {
  readonly start: CellPosition
  readonly end: CellPosition
}

const maxExcelRows = 1_048_576

const maxExcelColumns = 16_384

const cellAddressPattern = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/

const cellAddress = (value: string): CellPosition | undefined => {
  const match = cellAddressPattern.exec(value)

  if (match?.[1] === undefined || match[2] === undefined) return undefined

  let column = 0

  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64

  const row = Number(match[2])

  if (!Number.isSafeInteger(row) || row > maxExcelRows || column > maxExcelColumns) return undefined

  return { r: row - 1, c: column - 1 }
}

/**
 * Strictly parse `A1` or `A1:B2` within Excel's grid. Permissive SheetJS range decoders wrap or
 * normalize invalid and overflowed references, so they are never used on untrusted refs.
 */
export const parseCellRange = (ref: string): CellRange | undefined => {
  if (ref.length > 21) return undefined

  const parts = ref.split(':')
  const first = parts[0]

  if (first === undefined || parts.length > 2) return undefined

  const start = cellAddress(first)
  const end = cellAddress(parts[1] ?? first)

  if (start === undefined || end === undefined || end.r < start.r || end.c < start.c)
    return undefined

  return { start, end }
}

export const cellCount = (range: CellRange) =>
  (range.end.r - range.start.r + 1) * (range.end.c - range.start.c + 1)

/** `A1`-style address of a zero-based position. */
export const encodeCellAddress = (position: CellPosition) => {
  let column = ''
  let remaining = position.c + 1

  while (remaining > 0) {
    const letter = (remaining - 1) % 26
    column = String.fromCharCode(65 + letter) + column
    remaining = Math.floor((remaining - 1) / 26)
  }

  return `${column}${position.r + 1}`
}
