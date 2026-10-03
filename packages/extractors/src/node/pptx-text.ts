import { strFromU8 } from 'fflate'
import { decodeXmlEntities } from './xml-text.ts'

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

const paragraphXml = new RegExp(
  `<${optionalXmlPrefix}p\\b[^>]*>[\\s\\S]*?</${optionalXmlPrefix}p>`,
  'g'
)

const textXml = new RegExp(
  `<${optionalXmlPrefix}t\\b[^>]*>([\\s\\S]*?)</${optionalXmlPrefix}t>`,
  'g'
)

const lineBreakXml = new RegExp(`<${optionalXmlPrefix}br\\b[^>]*/>`, 'g')

const tabXml = new RegExp(`<${optionalXmlPrefix}tab\\b[^>]*/>`, 'g')

const indexedXmlFile = (
  fileName: string,
  bytes: Uint8Array,
  pattern: RegExp,
  group: number
): PptxXmlFile | undefined => {
  const indexText = pattern.exec(fileName)?.[1]

  if (indexText === undefined) return undefined

  const index = Number.parseInt(indexText, 10)

  if (!Number.isInteger(index)) return undefined

  return { fileName, bytes, group, index }
}

const pptxXmlFile = (fileName: string, bytes: Uint8Array): PptxXmlFile | undefined =>
  indexedXmlFile(fileName, bytes, slideXmlFile, 0) ??
  indexedXmlFile(fileName, bytes, notesXmlFile, 1)

const comparePptxXmlFiles = (left: PptxXmlFile, right: PptxXmlFile) =>
  left.group - right.group ||
  left.index - right.index ||
  left.fileName.localeCompare(right.fileName)

const extractMatches = (
  text: string,
  pattern: RegExp,
  groupIndex: number
): ReadonlyArray<string> => {
  const matches: Array<string> = []

  for (const match of text.matchAll(pattern)) {
    const value = match[groupIndex]

    if (value !== undefined) matches.push(value)
  }

  return matches
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

/** Slide text in slide order, then speaker notes, from the parts of a validated archive. */
export const extractPptxText = (parts: Readonly<Record<string, Uint8Array>>) =>
  Object.entries(parts)
    .flatMap(([fileName, fileBytes]) => {
      const xmlFile = pptxXmlFile(fileName, fileBytes)

      return xmlFile === undefined ? [] : [xmlFile]
    })
    .sort(comparePptxXmlFiles)
    .map(file => extractXmlText(strFromU8(file.bytes)))
    .filter(text => text.length > 0)
    .join('\n\n')
