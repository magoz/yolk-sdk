import { Buffer } from 'node:buffer'
import type { StrippedHyperlinkTags } from './office-archive.ts'
import { parseCellRange } from './xlsx-range.ts'
import type { CellRange } from './xlsx-range.ts'
import { prefixedAttribute, xmlAttributes } from './xml-text.ts'

export type XlsxHyperlink = {
  readonly range: CellRange
  /** Normalized `http:`, `https:`, or `mailto:` URL, at most 2,048 characters. */
  readonly target: string
  /** Label for cells without text, at most 1,024 characters (longer labels end in `…`). */
  readonly display?: string
}

/** Hyperlinks per worksheet name, in document order (a later link wins on overlap). */
export type XlsxHyperlinks = ReadonlyMap<string, ReadonlyArray<XlsxHyperlink>>

/** Longer targets are dropped: a truncated URL would point somewhere else. */
const maxHyperlinkTargetCharacters = 2048

/** Longer display labels are cut to this many characters, ending with an ellipsis. */
const maxHyperlinkDisplayCharacters = 1024

const capDisplay = (display: string) => {
  if (display.length <= maxHyperlinkDisplayCharacters) return display

  let kept = display.slice(0, maxHyperlinkDisplayCharacters - 1)
  const last = kept.charCodeAt(kept.length - 1)

  // Never leave half of a surrogate pair before the ellipsis.
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1)

  return `${kept}\u2026`
}

const shownProtocols = new Set(['http:', 'https:', 'mailto:'])

// `[^<>]` keeps each candidate inside one tag, so scans stay linear in the part size.
const startTagPattern = (localName: string) =>
  new RegExp(`<(?:[\\w.-]+:)?${localName}\\b[^<>]*>`, 'g')

const sheetTag = startTagPattern('sheet')

const relationshipTag = startTagPattern('Relationship')

const utf8Text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? '' : Buffer.from(bytes).toString('utf8')

const resolvePartPath = (baseDirectory: string, target: string) => {
  const segments: Array<string> = []
  const path = target.startsWith('/') ? target.slice(1) : `${baseDirectory}${target}`

  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '.' && segment !== '') segments.push(segment)
  }

  return segments.join('/')
}

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

const relationshipsPathFor = (partPath: string) =>
  `${directoryOf(partPath)}_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`

type Relationship = {
  readonly target: string
  readonly external: boolean
}

const relationships = (xml: string): ReadonlyMap<string, Relationship> => {
  const byId = new Map<string, Relationship>()

  for (const [tag] of xml.matchAll(relationshipTag)) {
    const attributes = xmlAttributes(tag)
    const id = attributes.get('Id')
    const target = attributes.get('Target')

    if (id !== undefined && target !== undefined && !byId.has(id))
      byId.set(id, { target, external: attributes.get('TargetMode') === 'External' })
  }

  return byId
}

const shownTarget = (target: string) => {
  if (target.length > maxHyperlinkTargetCharacters || !URL.canParse(target)) return undefined

  const url = new URL(target)

  if (!shownProtocols.has(url.protocol) || url.href.length > maxHyperlinkTargetCharacters)
    return undefined

  return url.href
}

const hyperlinkFrom = (
  tag: string,
  sheetRelationships: ReadonlyMap<string, Relationship>
): XlsxHyperlink | undefined => {
  // Tags were captured as Latin-1 text of the original bytes; attribute values are UTF-8.
  const attributes = xmlAttributes(Buffer.from(tag, 'latin1').toString('utf8'))
  const ref = attributes.get('ref')
  const range = ref === undefined ? undefined : parseCellRange(ref)
  const id = prefixedAttribute(attributes, 'id')
  const relationship = id === undefined ? undefined : sheetRelationships.get(id)

  // Internal `location`-only links (`#Sheet2!A1`) are omitted; external links keep their
  // location as a fragment, as SheetJS does.
  if (range === undefined || relationship === undefined || !relationship.external) return undefined

  const location = attributes.get('location')

  const target = shownTarget(
    location === undefined || location.length === 0
      ? relationship.target
      : `${relationship.target}#${location}`
  )

  if (target === undefined) return undefined

  const display = attributes.get('display')?.trim()

  return display === undefined || display.length === 0
    ? { range, target }
    : { range, target, display: capDisplay(display) }
}

/**
 * Map the hyperlink tags removed from a workbook to worksheet names through `xl/workbook.xml`,
 * its relationships, and each worksheet's relationships (targets need not end in `.xml`).
 */
export const resolveXlsxHyperlinks = (
  parts: Readonly<Record<string, Uint8Array>>,
  hyperlinkTags: StrippedHyperlinkTags
): XlsxHyperlinks => {
  const bySheet = new Map<string, ReadonlyArray<XlsxHyperlink>>()

  if (hyperlinkTags.size === 0) return bySheet

  const workbookPath = 'xl/workbook.xml'
  const workbookRelationships = relationships(utf8Text(parts[relationshipsPathFor(workbookPath)]))

  for (const [tag] of utf8Text(parts[workbookPath]).matchAll(sheetTag)) {
    const attributes = xmlAttributes(tag)
    const name = attributes.get('name')
    const id = prefixedAttribute(attributes, 'id')
    const relationship = id === undefined ? undefined : workbookRelationships.get(id)

    if (name === undefined || relationship === undefined || bySheet.has(name)) continue

    const sheetPath = resolvePartPath(directoryOf(workbookPath), relationship.target)
    const tags = hyperlinkTags.get(sheetPath)

    if (tags === undefined) continue

    const sheetRelationships = relationships(utf8Text(parts[relationshipsPathFor(sheetPath)]))

    const links = tags.flatMap(linkTag => {
      const link = hyperlinkFrom(linkTag, sheetRelationships)

      return link === undefined ? [] : [link]
    })

    if (links.length > 0) bySheet.set(name, links)
  }

  return bySheet
}

type ClippedLink = {
  readonly order: number
  readonly firstRow: number
  readonly lastRow: number
  readonly firstColumn: number
  readonly lastColumn: number
  readonly link: XlsxHyperlink
}

export type HyperlinkLookup = {
  /** The winning link at a cell. Rows must be queried in ascending order. */
  readonly at: (row: number, column: number) => XlsxHyperlink | undefined
}

/**
 * Index links clipped to the visited range for row-major lookup without scanning every link per
 * cell: a segment tree over columns whose nodes hold max-heaps (by document order) of the links
 * covering them. Links enter when the sweep reaches their first row and are discarded lazily once
 * it passes their last row. Work is O((links + cells) · log(columns) · log(links)).
 */
export const makeHyperlinkLookup = (
  links: ReadonlyArray<XlsxHyperlink>,
  visited: CellRange
): HyperlinkLookup => {
  const clipped = links
    .flatMap((link, order): ReadonlyArray<ClippedLink> => {
      const firstRow = Math.max(link.range.start.r, visited.start.r)
      const lastRow = Math.min(link.range.end.r, visited.end.r)
      const firstColumn = Math.max(link.range.start.c, visited.start.c) - visited.start.c
      const lastColumn = Math.min(link.range.end.c, visited.end.c) - visited.start.c

      return firstRow > lastRow || firstColumn > lastColumn
        ? []
        : [{ order, firstRow, lastRow, firstColumn, lastColumn, link }]
    })
    .sort((left, right) => left.firstRow - right.firstRow || left.order - right.order)

  if (clipped.length === 0) return { at: () => undefined }

  const width = visited.end.c - visited.start.c + 1
  let leaves = 1

  while (leaves < width) leaves *= 2

  const heaps: Array<Array<ClippedLink> | undefined> = []

  const push = (node: number, entry: ClippedLink) => {
    const heap = heaps[node] ?? []
    heaps[node] = heap
    heap.push(entry)

    let index = heap.length - 1

    while (index > 0) {
      const parent = (index - 1) >> 1
      const parentEntry = heap[parent]

      if (parentEntry === undefined || parentEntry.order >= entry.order) break

      heap[index] = parentEntry
      heap[parent] = entry
      index = parent
    }
  }

  const pop = (heap: Array<ClippedLink>) => {
    const last = heap.pop()

    if (last === undefined || heap.length === 0) return

    heap[0] = last

    let index = 0

    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let largest = index

      const largestOrder = () => heap[largest]?.order ?? -1

      if ((heap[left]?.order ?? -1) > largestOrder()) largest = left

      if ((heap[right]?.order ?? -1) > largestOrder()) largest = right

      const swapped = heap[largest]

      if (largest === index || swapped === undefined) return

      heap[largest] = last
      heap[index] = swapped
      index = largest
    }
  }

  const insert = (entry: ClippedLink) => {
    let low = entry.firstColumn + leaves
    let high = entry.lastColumn + leaves + 1

    while (low < high) {
      if ((low & 1) === 1) push(low++, entry)

      if ((high & 1) === 1) push(--high, entry)

      low >>= 1
      high >>= 1
    }
  }

  let nextEntry = 0

  return {
    at: (row, column) => {
      for (let entry = clipped[nextEntry]; entry !== undefined && entry.firstRow <= row;) {
        insert(entry)
        nextEntry += 1
        entry = clipped[nextEntry]
      }

      let best: ClippedLink | undefined

      for (let node = column - visited.start.c + leaves; node >= 1; node >>= 1) {
        const heap = heaps[node]

        if (heap === undefined) continue

        while (heap[0] !== undefined && heap[0].lastRow < row) pop(heap)

        const top = heap[0]

        if (top !== undefined && (best === undefined || top.order > best.order)) best = top
      }

      return best?.link
    }
  }
}
