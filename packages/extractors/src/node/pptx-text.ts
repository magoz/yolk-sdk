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

// Every pattern stops at the next `<` (`[^<>]`), and elements are paired in one forward pass, so
// extraction stays linear in the part size even for unterminated or unbalanced markup.
type XmlElement = { readonly start: RegExp; readonly end: RegExp }

const xmlElement = (localName: string): XmlElement => ({
  start: new RegExp(`<${optionalXmlPrefix}${localName}\\b[^<>]*>`, 'g'),
  end: new RegExp(`</${optionalXmlPrefix}${localName}>`, 'g')
})

const paragraphXml = xmlElement('p')

const textXml = xmlElement('t')

const lineBreakXml = new RegExp(`<${optionalXmlPrefix}br\\b[^<>]*/>`, 'g')

const tabXml = new RegExp(`<${optionalXmlPrefix}tab\\b[^<>]*/>`, 'g')

type ElementMatch = {
  /** Start tag through end tag. */
  readonly outer: string
  /** Text between the start and end tags. */
  readonly inner: string
}

/** Each start tag paired with the next end tag after it (the old lazy `[\s\S]*?` match). */
const elementMatches = (xml: string, element: XmlElement): ReadonlyArray<ElementMatch> => {
  const matches: Array<ElementMatch> = []
  let position = 0

  for (;;) {
    element.start.lastIndex = position
    const start = element.start.exec(xml)

    if (start === null) return matches

    const contentStart = start.index + start[0].length
    element.end.lastIndex = contentStart
    const end = element.end.exec(xml)

    // No end tag after this start means none after any later start either.
    if (end === null) return matches

    position = end.index + end[0].length
    matches.push({
      outer: xml.slice(start.index, position),
      inner: xml.slice(contentStart, end.index)
    })
  }
}

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

const extractParagraphText = (paragraph: string) => {
  const xml = paragraph.replace(lineBreakXml, '<a:t>\n</a:t>').replace(tabXml, '<a:t>\t</a:t>')

  return elementMatches(xml, textXml)
    .map(match => decodeXmlEntities(match.inner))
    .join('')
    .trim()
}

const extractXmlText = (xml: string) => {
  const paragraphs = elementMatches(xml, paragraphXml).map(match => match.outer)
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
