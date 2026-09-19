/**
 * Unsubscribe discovery from RFC 5322 message headers.
 *
 * Mailing lists advertise removal methods in `List-Unsubscribe` headers (RFC 2369) as
 * comma-separated `<mailto:...>` and `<https://...>` values, plus an optional
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header (RFC 8058) marking HTTP
 * endpoints that require a POST instead of a GET.
 *
 * This module only parses what the message advertises; it never unsubscribes by itself.
 * Executing a method stays host-owned: `mailto:` methods send through the existing
 * `email.send_message` / `outlook.send_mail` actions (or a Gmail draft for review), while
 * HTTP methods need a host network call with host transport policy. Never route publisher
 * URLs through the provider `ConnectorHttpClient` port; that port is for provider APIs.
 */

export type UnsubscribeMailtoMethod = {
  readonly uri: string
  readonly address: string
}

export type UnsubscribeHttpMethod = {
  readonly url: string
  readonly oneClick: boolean
}

export type UnsubscribeMethods = {
  readonly mailto: ReadonlyArray<UnsubscribeMailtoMethod>
  readonly http: ReadonlyArray<UnsubscribeHttpMethod>
}

const unsubscribeHeaderName = 'list-unsubscribe'

const unsubscribePostHeaderName = 'list-unsubscribe-post'

const oneClickPostValue = 'list-unsubscribe=one-click'

const bracketedValue = /<([^<>]*)>/g

// RFC 2369 section 2: internal whitespace inside brackets carries no meaning.
const compactBracketedValue = (raw: string) => raw.replaceAll(/\s/g, '')

const parseMailtoAddress = (uri: string) => {
  const withoutScheme = uri.slice('mailto:'.length)
  const queryIndex = withoutScheme.indexOf('?')
  const address = (queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)).trim()

  return address === '' ? undefined : address
}

const isHttpUrl = (value: string) => {
  const lowercased = value.toLowerCase()

  return lowercased.startsWith('https://') || lowercased.startsWith('http://')
}

/**
 * Extract unsubscribe methods from message headers. Header names match
 * case-insensitively; surrounding whitespace and RFC 5322 folding are tolerated.
 * Unknown schemes are ignored. Results are deduplicated, preserving header order.
 */
export const parseUnsubscribeMethods = (
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
): UnsubscribeMethods => {
  const oneClick = headers.some(
    header =>
      header.name.toLowerCase() === unsubscribePostHeaderName &&
      header.value.split(';')[0]?.trim().toLowerCase() === oneClickPostValue
  )

  const mailto: Array<UnsubscribeMailtoMethod> = []
  const http: Array<UnsubscribeHttpMethod> = []
  const seen = new Set<string>()

  for (const header of headers) {
    if (header.name.toLowerCase() !== unsubscribeHeaderName) continue

    for (const match of header.value.matchAll(bracketedValue)) {
      const raw = compactBracketedValue(match[1] ?? '')

      if (raw === '' || seen.has(raw.toLowerCase())) continue
      seen.add(raw.toLowerCase())

      const lowercased = raw.toLowerCase()

      if (lowercased.startsWith('mailto:')) {
        const address = parseMailtoAddress(raw)

        if (address !== undefined) mailto.push({ uri: raw, address })
      } else if (isHttpUrl(raw)) {
        http.push({ url: raw, oneClick })
      }
    }
  }

  return { mailto, http }
}
