import { describe, expect, it } from '@effect/vitest'
import {
  encodeGmailQuotedPrintable,
  gmailDraftAlternativeBoundary,
  gmailDraftBodyMime,
  gmailDraftHtmlFromText
} from '../src/google/gmail-draft-mime.ts'

/** RFC 2045 quoted-printable decoding, written independently of the encoder under test. */
const decodeQuotedPrintable = (encoded: string): string => {
  const bytes: Array<number> = []
  const text = encoded.replaceAll('=\r\n', '')

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''

    if (char === '=') {
      const pair = text.slice(index + 1, index + 3)

      expect(pair).toMatch(/^[0-9A-F]{2}$/)
      bytes.push(Number.parseInt(pair, 16))
      index += 2
    } else {
      expect(char.charCodeAt(0)).toBeLessThan(0x80)
      bytes.push(char.charCodeAt(0))
    }
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
}

type Part = { readonly headers: ReadonlyArray<string>; readonly body: string }

const splitPart = (part: string): Part => {
  const end = part.indexOf('\r\n\r\n')

  expect(end).toBeGreaterThan(0)

  return { headers: part.slice(0, end).split('\r\n'), body: part.slice(end + 4) }
}

/** The two parts of a `multipart/alternative` draft body MIME, asserting its exact framing. */
const alternativeParts = (mime: string): readonly [Part, Part] => {
  const delimiter = `--${gmailDraftAlternativeBoundary}`
  const head = `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${gmailDraftAlternativeBoundary}"\r\n\r\n${delimiter}\r\n`
  const close = `\r\n${delimiter}--`

  expect(mime.startsWith(head)).toBe(true)
  expect(mime.endsWith(close)).toBe(true)

  const inner = mime.slice(head.length, mime.length - close.length).split(`\r\n${delimiter}\r\n`)

  expect(inner).toHaveLength(2)

  return [splitPart(inner[0] ?? ''), splitPart(inner[1] ?? '')]
}

const partHeaders = (type: 'plain' | 'html') => [
  `Content-Type: text/${type}; charset=UTF-8`,
  'Content-Transfer-Encoding: quoted-printable'
]

/** Decodes both parts and checks they are exactly the body and its HTML rendering. */
const expectRoundTrip = (body: string) => {
  const mime = gmailDraftBodyMime(body, 'text')
  const [plain, html] = alternativeParts(mime)
  const normalized = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

  expect(plain.headers).toEqual(partHeaders('plain'))
  expect(html.headers).toEqual(partHeaders('html'))
  expect(decodeQuotedPrintable(plain.body)).toBe(normalized.replaceAll('\n', '\r\n'))
  expect(decodeQuotedPrintable(html.body)).toBe(gmailDraftHtmlFromText(body))

  for (const line of mime.split('\r\n')) {
    expect(line.length).toBeLessThanOrEqual(76)
    expect(line).toMatch(/^[\x20-\x7e]*$/)
    // Quoted-printable never leaves whitespace at the end of an encoded line.
    expect(line).not.toMatch(/[ \t]$/)
  }

  return { mime, plain, html }
}

const swedishParagraph =
  'Hej Åsa! Jag såg att ni på Ängelholms Fönsterputs AB nyligen öppnat ett nytt kontor i Malmö, och jag tänkte höra om ni har funderat på hur ni hanterar bokningar när säsongen drar igång. Vi hjälper små tjänsteföretag att få kunderna att boka själva, dygnet runt, utan att någon behöver svara i telefon – och det tar ungefär en kvart att komma igång.'

const finnishParagraph =
  'Hyvää päivää! Huomasin, että yrityksenne Jyväskylän Ikkunapesu Oy on laajentanut toimintaansa Tampereelle, ja halusin kysyä, miten asiakkaidenne ajanvaraukset hoituvat kiireisimpänä aikana. Ääkköset: ä ö å Ä Ö Å.'

describe('Gmail draft body MIME', () => {
  it('serializes a text body as multipart/alternative, byte for byte', () => {
    expect(gmailDraftBodyMime('Hej Åsa,\n\nVälkommen <3 & hej!', 'text')).toBe(
      [
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="=_yolk-draft-alternative"',
        '',
        '--=_yolk-draft-alternative',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Hej =C3=85sa,',
        '',
        'V=C3=A4lkommen <3 & hej!',
        '--=_yolk-draft-alternative',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '<div dir=3D"ltr">Hej =C3=85sa,<br><br>V=C3=A4lkommen &lt;3 &amp; hej!</div>',
        '--=_yolk-draft-alternative--'
      ].join('\r\n')
    )
  })

  it('serializes an html body as one text/html part', () => {
    expect(gmailDraftBodyMime('<p>Hej <b>Åsa</b></p>', 'html')).toBe(
      [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '<p>Hej <b>=C3=85sa</b></p>'
      ].join('\r\n')
    )
  })

  it('round-trips long Swedish and Finnish paragraphs with lines of at most 76 characters', () => {
    const body = `${swedishParagraph}\n\n${finnishParagraph}`

    expect(swedishParagraph.length).toBeGreaterThan(300)

    const { plain } = expectRoundTrip(body)

    // Soft breaks never split a character's UTF-8 escapes: every encoded line decodes alone.
    for (const line of plain.body.split('\r\n')) {
      expect(() => decodeQuotedPrintable(line.replace(/=$/, ''))).not.toThrow()
    }

    // A paragraph stays one hard line: only soft breaks inside it.
    expect(plain.body.split(/(?<!=)\r\n/)).toHaveLength(3)
  })

  it('keeps blank lines and signature lines as line breaks in the HTML', () => {
    const body = 'Hej Anna,\n\nKort fråga.\n\nMed vänliga hälsningar\nElina\nSpeldosa'

    expectRoundTrip(body)
    expect(gmailDraftHtmlFromText(body)).toBe(
      '<div dir="ltr">Hej Anna,<br><br>Kort fråga.<br><br>Med vänliga hälsningar<br>Elina<br>Speldosa</div>'
    )
  })

  it('normalizes CRLF and lone CR line breaks', () => {
    const { plain } = expectRoundTrip('a\r\nb\rc\n\r\nd')

    expect(decodeQuotedPrintable(plain.body)).toBe('a\r\nb\r\nc\r\n\r\nd')
    expect(gmailDraftHtmlFromText('a\r\nb\rc\n\r\nd')).toBe(
      '<div dir="ltr">a<br>b<br>c<br><br>d</div>'
    )
  })

  it('escapes HTML special characters', () => {
    const body = `<script>alert("x")</script> & 'quoted' &amp;`

    expectRoundTrip(body)
    expect(gmailDraftHtmlFromText(body)).toBe(
      '<div dir="ltr">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39; &amp;amp;</div>'
    )
  })

  it('preserves runs of spaces and leading indentation', () => {
    expectRoundTrip('a  b   c\n  indented\n end')
    expect(gmailDraftHtmlFromText('a  b   c\n  indented\n end')).toBe(
      '<div dir="ltr">a &nbsp;b &nbsp;&nbsp;c<br>&nbsp;&nbsp;indented<br>&nbsp;end</div>'
    )
  })

  it('encodes trailing whitespace, equals signs, and control characters', () => {
    expect(encodeGmailQuotedPrintable('end \nTab\t\nx=20\u0007')).toBe(
      'end=20\r\nTab=09\r\nx=3D20=07'
    )
    expectRoundTrip('end \nTab\t\nx=20 ?date=2026-10-05')
  })

  it('links http(s) URLs with the URL as the visible text', () => {
    const body =
      'Boka: https://cal.example.com/speldosa?a=1&b=2. Eller (se https://example.com/a_(b)) och http://example.org/x, men inte xhttps://no eller https://'

    expectRoundTrip(body)
    expect(gmailDraftHtmlFromText(body)).toBe(
      '<div dir="ltr">Boka: <a href="https://cal.example.com/speldosa?a=1&amp;b=2">https://cal.example.com/speldosa?a=1&amp;b=2</a>. Eller (se <a href="https://example.com/a_(b)">https://example.com/a_(b)</a>) och <a href="http://example.org/x">http://example.org/x</a>, men inte xhttps://no eller https://</div>'
    )
  })

  it('leaves unbalanced closing brackets out of links', () => {
    expect(gmailDraftHtmlFromText('[https://x.example/a] [https://x.example/b[1]]')).toBe(
      '<div dir="ltr">[<a href="https://x.example/a">https://x.example/a</a>] [<a href="https://x.example/b[1]">https://x.example/b[1]</a>]</div>'
    )
  })

  it('never lets the body produce a boundary delimiter', () => {
    const body = `--${gmailDraftAlternativeBoundary}\n--${gmailDraftAlternativeBoundary}--\n${gmailDraftAlternativeBoundary}`
    const { mime } = expectRoundTrip(body)

    expect(
      mime.split('\r\n').filter(line => line.startsWith(`--${gmailDraftAlternativeBoundary}`))
    ).toEqual([
      `--${gmailDraftAlternativeBoundary}`,
      `--${gmailDraftAlternativeBoundary}`,
      `--${gmailDraftAlternativeBoundary}--`
    ])
  })

  it('wraps lines without spaces and keeps 4-byte characters whole', () => {
    expectRoundTrip(`${'x'.repeat(200)}\n${'😀'.repeat(40)}\n${'='.repeat(100)}`)
  })

  it('serializes an empty body', () => {
    expectRoundTrip('')
    expect(gmailDraftHtmlFromText('')).toBe('<div dir="ltr"></div>')
  })
})
