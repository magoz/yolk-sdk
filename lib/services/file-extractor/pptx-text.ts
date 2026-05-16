import { strFromU8, unzipSync } from 'fflate'

type PptxXmlFile = {
  readonly fileName: string
  readonly bytes: Uint8Array
  readonly group: number
  readonly index: number
}

const slideXmlFile = /^ppt\/slides\/slide(\d+)\.xml$/
const notesXmlFile = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/
const xmlName = '[A-Za-z_][\\w.-]*'
const optionalXmlPrefix = `(?:${xmlName}:)?`
const paragraphXml = new RegExp(`<${optionalXmlPrefix}p\\b[^>]*>[\\s\\S]*?<\/${optionalXmlPrefix}p>`, 'g')
const textXml = new RegExp(`<${optionalXmlPrefix}t\\b[^>]*>([\\s\\S]*?)<\/${optionalXmlPrefix}t>`, 'g')
const lineBreakXml = new RegExp(`<${optionalXmlPrefix}br\\b[^>]*/>`, 'g')
const tabXml = new RegExp(`<${optionalXmlPrefix}tab\\b[^>]*/>`, 'g')
const xmlEntity = /&([^;]+);/g
const hexEntity = /^#x([0-9a-fA-F]+)$/
const decimalEntity = /^#(\d+)$/

const indexedXmlFile = (
  fileName: string,
  bytes: Uint8Array,
  pattern: RegExp,
  group: number
): PptxXmlFile | undefined => {
  const match = pattern.exec(fileName)
  const indexText = match?.[1]
  if (indexText === undefined) {
    return undefined
  }

  const index = Number.parseInt(indexText, 10)
  if (!Number.isInteger(index)) {
    return undefined
  }

  return { fileName, bytes, group, index }
}

const pptxXmlFile = (fileName: string, bytes: Uint8Array): PptxXmlFile | undefined => {
  const slideFile = indexedXmlFile(fileName, bytes, slideXmlFile, 0)
  if (slideFile !== undefined) {
    return slideFile
  }

  return indexedXmlFile(fileName, bytes, notesXmlFile, 1)
}

const comparePptxXmlFiles = (left: PptxXmlFile, right: PptxXmlFile) =>
  left.group - right.group || left.index - right.index || left.fileName.localeCompare(right.fileName)

const extractMatches = (text: string, pattern: RegExp, groupIndex: number): ReadonlyArray<string> => {
  const matches: Array<string> = []

  for (const match of text.matchAll(pattern)) {
    const value = match[groupIndex]
    if (value !== undefined) {
      matches.push(value)
    }
  }

  return matches
}

const decodeCodePoint = (raw: string, codePointText: string, radix: number) => {
  const codePoint = Number.parseInt(codePointText, radix)
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return raw
  }

  return String.fromCodePoint(codePoint)
}

const decodeXmlEntity = (raw: string, entity: string) => {
  switch (entity) {
    case 'amp':
      return '&'
    case 'lt':
      return '<'
    case 'gt':
      return '>'
    case 'quot':
      return '"'
    case 'apos':
      return "'"
    default:
      break
  }

  const hex = hexEntity.exec(entity)?.[1]
  if (hex !== undefined) {
    return decodeCodePoint(raw, hex, 16)
  }

  const decimal = decimalEntity.exec(entity)?.[1]
  if (decimal !== undefined) {
    return decodeCodePoint(raw, decimal, 10)
  }

  return raw
}

const decodeXmlEntities = (text: string) => {
  let decoded = ''
  let lastIndex = 0

  for (const match of text.matchAll(xmlEntity)) {
    const raw = match[0]
    const entity = match[1]
    const start = match.index

    if (entity === undefined || start === undefined) {
      continue
    }

    decoded += text.slice(lastIndex, start)
    decoded += decodeXmlEntity(raw, entity)
    lastIndex = start + raw.length
  }

  return decoded + text.slice(lastIndex)
}

const extractParagraphText = (paragraph: string) => {
  const xml = paragraph.replace(lineBreakXml, '<a:t>\n</a:t>').replace(tabXml, '<a:t>\t</a:t>')

  return extractMatches(xml, textXml, 1).map(decodeXmlEntities).join('').trim()
}

const extractXmlText = (xml: string) => {
  const paragraphs = extractMatches(xml, paragraphXml, 0)
  const textSources = paragraphs.length > 0 ? paragraphs : [xml]

  return textSources
    .map(extractParagraphText)
    .filter(text => text.length > 0)
    .join('\n')
}

export const extractPptxText = (bytes: Uint8Array) => {
  const archive = unzipSync(bytes)

  return Object.entries(archive)
    .flatMap(([fileName, fileBytes]) => {
      const xmlFile = pptxXmlFile(fileName, fileBytes)
      return xmlFile === undefined ? [] : [xmlFile]
    })
    .sort(comparePptxXmlFiles)
    .map(file => extractXmlText(strFromU8(file.bytes)))
    .filter(text => text.length > 0)
    .join('\n\n')
}
