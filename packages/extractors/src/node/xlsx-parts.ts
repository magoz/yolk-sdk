import { Buffer } from 'node:buffer'
import { prefixedAttribute, xmlAttributes } from './xml-text.ts'

/** The main workbook part every validated XLSX archive contains. */
export const workbookPartPath = 'xl/workbook.xml'

export const utf8Text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? '' : Buffer.from(bytes).toString('utf8')

/** Resolve a relationship target against the directory of its source part (`xl/`, …). */
export const resolvePartPath = (baseDirectory: string, target: string) => {
  const segments: Array<string> = []
  const path = target.startsWith('/') ? target.slice(1) : `${baseDirectory}${target}`

  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '.' && segment !== '') segments.push(segment)
  }

  return segments.join('/')
}

export const directoryOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

export const relationshipsPathFor = (partPath: string) =>
  `${directoryOf(partPath)}_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`

/**
 * Validated parts by case-insensitive name, as SheetJS and OPC look them up. Archive validation
 * rejects names that differ only in case, so each lower-cased name has one part.
 */
export type PartIndex = {
  /** The validated entry name and bytes of a part, matched ignoring case. */
  readonly find: (path: string) => { readonly name: string; readonly bytes: Uint8Array } | undefined
}

export const indexParts = (parts: Readonly<Record<string, Uint8Array>>): PartIndex => {
  const names = new Map<string, string>()

  for (const name of Object.keys(parts)) names.set(name.toLowerCase(), name)

  return {
    find: path => {
      const name = names.get(path.toLowerCase())
      const bytes = name === undefined ? undefined : parts[name]

      return name === undefined || bytes === undefined ? undefined : { name, bytes }
    }
  }
}

// `[^<>]` keeps each candidate inside one tag, so scans stay linear in the part size.
const startTagPattern = (localName: string) =>
  new RegExp(`<(?:[\\w.-]+:)?${localName}(?=[\\s/>])[^<>]*>`, 'g')

const sheetTag = startTagPattern('sheet')

const relationshipTag = startTagPattern('Relationship')

export type Relationship = {
  readonly target: string
  /** The `Type` attribute as written (relationship types are case-sensitive URIs). */
  readonly type: string | undefined
  readonly external: boolean
}

/** Relationships by `Id`; the first relationship with an `Id` wins. */
export const relationships = (xml: string): ReadonlyMap<string, Relationship> => {
  const byId = new Map<string, Relationship>()

  for (const [tag] of xml.matchAll(relationshipTag)) {
    const attributes = xmlAttributes(tag)
    const id = attributes.get('Id')
    const target = attributes.get('Target')

    if (id !== undefined && target !== undefined && !byId.has(id))
      byId.set(id, {
        target,
        type: attributes.get('Type'),
        external: attributes.get('TargetMode') === 'External'
      })
  }

  return byId
}

export type WorkbookSheet = {
  readonly name: string | undefined
  /** The `r:id` of the sheet's workbook relationship (any namespace prefix). */
  readonly id: string | undefined
}

/** `<sheet>` elements of `xl/workbook.xml`, in workbook order. */
export const workbookSheets = (xml: string): ReadonlyArray<WorkbookSheet> =>
  Array.from(xml.matchAll(sheetTag), ([tag]) => {
    const attributes = xmlAttributes(tag)

    return { name: attributes.get('name'), id: prefixedAttribute(attributes, 'id') }
  })
