const xmlEntity = /&([^;&\s]{1,16});/g

const hexEntity = /^#x([0-9a-fA-F]+)$/

const decimalEntity = /^#(\d+)$/

const namedEntities: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"]
])

const decodeCodePoint = (raw: string, codePointText: string, radix: number) => {
  const codePoint = Number.parseInt(codePointText, radix)

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return raw

  return String.fromCodePoint(codePoint)
}

const decodeXmlEntity = (raw: string, entity: string) => {
  const named = namedEntities.get(entity)

  if (named !== undefined) return named

  const hex = hexEntity.exec(entity)?.[1]

  if (hex !== undefined) return decodeCodePoint(raw, hex, 16)

  const decimal = decimalEntity.exec(entity)?.[1]

  if (decimal !== undefined) return decodeCodePoint(raw, decimal, 10)

  return raw
}

/** Decode the predefined XML entities and numeric character references; keep unknown ones. */
export const decodeXmlEntities = (text: string) =>
  text.replace(xmlEntity, (raw, entity: string) => decodeXmlEntity(raw, entity))

// A name may only start after a non-name character, so a long run of name characters is scanned
// once rather than once per starting position.
const attributePattern = /(?<![\w.:-])([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** Attributes of one start tag, entity-decoded, keyed by their qualified name. */
export const xmlAttributes = (tag: string): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>()

  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1]
    const value = match[2] ?? match[3]

    if (name !== undefined && value !== undefined && !attributes.has(name))
      attributes.set(name, decodeXmlEntities(value))
  }

  return attributes
}

/** The value of a namespace-prefixed attribute such as `r:id`, whatever the prefix. */
export const prefixedAttribute = (attributes: ReadonlyMap<string, string>, localName: string) => {
  for (const [name, value] of attributes) {
    const separator = name.indexOf(':')

    if (separator > 0 && name.slice(separator + 1) === localName) return value
  }

  return undefined
}
