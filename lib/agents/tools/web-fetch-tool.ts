import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ToolError } from '@yolk/agent/loop'
import { ToolResult, type ToolCall } from '@yolk/agent/protocol'
import { makeTool, type ToolModule, type ToolRegistration } from '@yolk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const webFetchToolName = 'web_fetch'
const maxResponseSizeBytes = 5 * 1024 * 1024
const defaultTimeoutSeconds = 30
const maxTimeoutSeconds = 120
const maxRedirects = 5

const WebFetchFormat = Schema.Literals(['markdown', 'text', 'html'])
const WebFetchParams = Schema.Struct({
  url: Schema.String.pipe(Schema.annotate({ description: 'Fully-qualified public http(s) URL to fetch.' })),
  format: Schema.optional(WebFetchFormat).pipe(
    Schema.annotate({ description: 'Output format. Defaults to markdown.' })
  ),
  timeoutSeconds: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Optional timeout in seconds. Defaults to 30; capped at 120.' })
  )
})

type WebFetchFormat = typeof WebFetchFormat.Type
type WebFetchParams = typeof WebFetchParams.Type

export type WebFetchHttpResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Effect.Effect<ArrayBuffer, ToolError>
}

export type WebFetchToolDependencies = {
  readonly ensurePublicUrl: (url: URL) => Effect.Effect<void, ToolError>
  readonly request: (url: URL, timeoutMs: number) => Effect.Effect<WebFetchHttpResponse, ToolError>
}

const webFetchToolDescription = [
  'Fetch and read a public web URL. Returns markdown by default, or text/html when requested.',
  'Use this when the user provides a URL or asks about a known page.',
  'This tool does not search the web, click links, run page JavaScript, use cookies, or access logged-in pages.'
].join(' ')

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: webFetchToolName,
    message,
    cause
  })

const decodeWebFetchParams = (params: unknown) =>
  Schema.decodeUnknownEffect(WebFetchParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid web fetch arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

const normalizeFormat = (format: WebFetchFormat | undefined): WebFetchFormat => format ?? 'markdown'

const resolveTimeoutMs = (timeoutSeconds: number | undefined) => {
  const timeout = timeoutSeconds ?? defaultTimeoutSeconds

  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Effect.fail(
      makeToolError('timeoutSeconds must be a positive finite number', 'validation')
    )
  }

  return Effect.succeed(Math.min(timeout, maxTimeoutSeconds) * 1000)
}

const parsePublicHttpUrl = (rawUrl: string) => {
  const trimmed = rawUrl.trim()

  if (!URL.canParse(trimmed)) {
    return Effect.fail(makeToolError(`Invalid URL: ${rawUrl}`, 'validation'))
  }

  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Effect.fail(makeToolError('URL must use http or https', 'validation'))
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return Effect.fail(makeToolError('URL credentials are not allowed', 'validation'))
  }

  return Effect.succeed(url)
}

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')

const isLocalHostname = (hostname: string) =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === 'local' ||
  hostname.endsWith('.local')

export const parseIpv4Parts = (address: string) => {
  const parts = address.split('.').map(part => Number.parseInt(part, 10))

  return parts.length === 4 &&
    parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : []
}

export const isBlockedIpv4 = (address: string) => {
  const parts = parseIpv4Parts(address)
  if (parts.length !== 4) {
    return false
  }

  const first = parts[0]
  const second = parts[1]

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && second >= 18 && second <= 19) ||
    first >= 224
  )
}

export const isBlockedIpv6 = (address: string) => {
  const lower = address.toLowerCase()
  const mappedIpv4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : ''

  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('fec') ||
    lower.startsWith('fed') ||
    lower.startsWith('fee') ||
    lower.startsWith('fef') ||
    lower.startsWith('ff') ||
    (mappedIpv4.length > 0 && isBlockedIpv4(mappedIpv4))
  )
}

export const isIpv4Literal = (address: string) => parseIpv4Parts(address).length === 4

export const isIpv6Literal = (address: string) => address.includes(':')

export const isIpLiteral = (address: string) => isIpv4Literal(address) || isIpv6Literal(address)

export const isBlockedAddress = (address: string) =>
  isIpv4Literal(address) ? isBlockedIpv4(address) : isIpv6Literal(address) && isBlockedIpv6(address)

export const ensurePublicUrlWithoutDns = (url: URL) => {
  const hostname = normalizeHostname(url.hostname)
  if (hostname.length === 0 || isLocalHostname(hostname)) {
    return Effect.fail(makeToolError('URL host is not public', 'permission'))
  }

  if (isIpLiteral(hostname)) {
    return isBlockedAddress(hostname)
      ? Effect.fail(
          makeToolError('URL host resolves to a private or reserved address', 'permission')
        )
      : Effect.void
  }

  return Effect.void
}

export const ensureResolvedAddressesArePublic = (addresses: ReadonlyArray<string>) =>
  addresses.length === 0 || addresses.some(isBlockedAddress)
    ? Effect.fail(makeToolError('URL host resolves to a private or reserved address', 'permission'))
    : Effect.void

const requestHeaders = {
  accept:
    'text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, application/json;q=0.7, */*;q=0.1',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'YolkAgent/0.1 (+https://yolk.ai)'
}

const manualRedirectRequestInit: RequestInit = { redirect: 'manual' }

export const requestWithHttpClient = (url: URL, timeoutMs: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(url.toString()).pipe(
      HttpClientRequest.setHeaders(requestHeaders)
    )
    const response = yield* http.execute(request).pipe(
      Effect.mapError(error =>
        makeToolError(`Request failed: ${unknownToMessage(error)}`, 'execution')
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(makeToolError('Request timed out', 'timeout'))
      })
    )

    return {
      status: response.status,
      headers: response.headers,
      body: response.arrayBuffer.pipe(
        Effect.mapError(error =>
          makeToolError(`Could not read response body: ${unknownToMessage(error)}`, 'execution')
        )
      )
    }
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, manualRedirectRequestInit),
    Effect.provide(FetchHttpClient.layer)
  )

const headerValue = (headers: Readonly<Record<string, string | undefined>>, name: string) =>
  headers[name.toLowerCase()] ?? headers[name]

const isRedirectStatus = (status: number) => status >= 300 && status < 400

const resolveRedirectUrl = (baseUrl: URL, location: string) => {
  if (!URL.canParse(location, baseUrl.toString())) {
    return Effect.fail(makeToolError(`Invalid redirect URL: ${location}`, 'execution'))
  }

  return Effect.succeed(new URL(location, baseUrl.toString()))
}

const fetchWithRedirects = (
  deps: WebFetchToolDependencies,
  url: URL,
  timeoutMs: number,
  remainingRedirects: number
): Effect.Effect<{ readonly url: URL; readonly response: WebFetchHttpResponse }, ToolError> =>
  Effect.gen(function* () {
    yield* deps.ensurePublicUrl(url)
    const response = yield* deps.request(url, timeoutMs)

    if (!isRedirectStatus(response.status)) {
      return { url, response }
    }

    if (remainingRedirects <= 0) {
      return yield* Effect.fail(makeToolError('Too many redirects', 'execution'))
    }

    const location = headerValue(response.headers, 'location')
    if (location === undefined || location.length === 0) {
      return yield* Effect.fail(
        makeToolError(`Redirect ${response.status} missing Location header`, 'execution')
      )
    }

    const nextUrl = yield* resolveRedirectUrl(url, location)

    return yield* fetchWithRedirects(deps, nextUrl, timeoutMs, remainingRedirects - 1)
  })

const ensureSuccessfulStatus = (status: number) =>
  status >= 200 && status < 300
    ? Effect.void
    : Effect.fail(makeToolError(`Request failed with HTTP ${status}`, 'execution'))

const ensureContentLength = (headers: Readonly<Record<string, string | undefined>>) => {
  const rawContentLength = headerValue(headers, 'content-length')
  if (rawContentLength === undefined) {
    return Effect.void
  }

  const contentLength = Number.parseInt(rawContentLength, 10)

  return Number.isFinite(contentLength) && contentLength > maxResponseSizeBytes
    ? Effect.fail(makeToolError('Response too large (exceeds 5MB limit)', 'execution'))
    : Effect.void
}

const ensureArrayBufferSize = (arrayBuffer: ArrayBuffer) =>
  arrayBuffer.byteLength > maxResponseSizeBytes
    ? Effect.fail(makeToolError('Response too large (exceeds 5MB limit)', 'execution'))
    : Effect.void

const contentTypeMime = (contentType: string | undefined) =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

const isTextLikeMime = (mime: string) =>
  mime.length === 0 ||
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/javascript' ||
  mime === 'application/xml' ||
  mime.endsWith('+json') ||
  mime.endsWith('+xml')

const normalizeWhitespace = (input: string) =>
  input
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const decodeHtmlEntities = (input: string) =>
  input.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
    const normalized = value.toLowerCase()
    if (normalized === 'amp') return '&'
    if (normalized === 'lt') return '<'
    if (normalized === 'gt') return '>'
    if (normalized === 'quot') return '"'
    if (normalized === 'apos') return "'"
    if (normalized === 'nbsp') return ' '

    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10)

    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity
  })

const stripIgnoredHtml = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')

const stripTags = (html: string) => decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))

const htmlToText = (html: string) =>
  normalizeWhitespace(
    stripTags(
      stripIgnoredHtml(html)
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6])>/gi, '\n')
    )
  )

const inlineMarkdown = (html: string) => normalizeWhitespace(stripTags(stripIgnoredHtml(html)))

const htmlToMarkdown = (html: string) =>
  normalizeWhitespace(
    decodeHtmlEntities(
      stripIgnoredHtml(html)
        .replace(
          /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
          (_match, level, text) =>
            `\n\n${'#'.repeat(Number.parseInt(level, 10))} ${inlineMarkdown(text)}\n\n`
        )
        .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
          const label = inlineMarkdown(text)
          return label.length > 0 ? `${label} (${href})` : href
        })
        .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, text) => `\n- ${inlineMarkdown(text)}`)
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(
          /<\/(p|div|section|article|header|footer|main|aside|ul|ol|blockquote|pre|tr)>/gi,
          '\n\n'
        )
        .replace(/<[^>]*>/g, ' ')
    )
  )

const renderContent = (
  content: string,
  contentType: string | undefined,
  format: WebFetchFormat
) => {
  const isHtml = contentTypeMime(contentType).includes('html')

  if (format === 'html' || !isHtml) {
    return content.trim()
  }

  return format === 'text' ? htmlToText(content) : htmlToMarkdown(content)
}

const formatToolOutput = (input: {
  readonly finalUrl: URL
  readonly status: number
  readonly contentType: string | undefined
  readonly format: WebFetchFormat
  readonly content: string
}) =>
  [
    `URL: ${input.finalUrl.toString()}`,
    `Status: ${input.status}`,
    `Content-Type: ${input.contentType ?? 'unknown'}`,
    `Format: ${input.format}`,
    '',
    input.content
  ].join('\n')

export const fetchWebPage = (params: WebFetchParams, deps: WebFetchToolDependencies) =>
  Effect.gen(function* () {
    const url = yield* parsePublicHttpUrl(params.url)
    const timeoutMs = yield* resolveTimeoutMs(params.timeoutSeconds)
    const format = normalizeFormat(params.format)
    const { url: finalUrl, response } = yield* fetchWithRedirects(
      deps,
      url,
      timeoutMs,
      maxRedirects
    )
    yield* ensureSuccessfulStatus(response.status)
    yield* ensureContentLength(response.headers)

    const contentType = headerValue(response.headers, 'content-type')
    const mime = contentTypeMime(contentType)
    if (!isTextLikeMime(mime)) {
      return yield* Effect.fail(makeToolError(`Unsupported content type: ${mime}`, 'execution'))
    }

    const arrayBuffer = yield* response.body
    yield* ensureArrayBufferSize(arrayBuffer)

    const content = renderContent(new TextDecoder().decode(arrayBuffer), contentType, format)

    return formatToolOutput({
      finalUrl,
      status: response.status,
      contentType,
      format,
      content
    })
  })

export const executeWebFetchTool = (call: ToolCall, deps: WebFetchToolDependencies) => {
  if (call.name !== webFetchToolName) {
    return Effect.fail(
      new ToolError({
        tool: call.name,
        message: `Tool is not configured: ${call.name}`,
        cause: 'permission'
      })
    )
  }

  return Effect.gen(function* () {
    const params = yield* decodeWebFetchParams(call.params)
    const content = yield* fetchWebPage(params, deps)

    return ToolResult.make({ toolCallId: call.id, content })
  })
}

export const makeWebFetchToolRegistration = (
  deps: WebFetchToolDependencies
): ToolRegistration<AgentToolContext> => makeTool({
  name: webFetchToolName,
  description: webFetchToolDescription,
  parameters: WebFetchParams,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text' || context.surface === 'voice'),
  invalidParamsMessage: error => `Invalid web fetch arguments: ${unknownToMessage(error)}`,
  execute: ({ call, params }) =>
    fetchWebPage(params, deps).pipe(
      Effect.map(content => ToolResult.make({ toolCallId: call.id, content }))
    )
})

export const makeWebFetchToolModule = (
  deps: WebFetchToolDependencies
): ToolModule<AgentToolContext> => ({
  id: 'browser',
  tools: [makeWebFetchToolRegistration(deps)]
})
