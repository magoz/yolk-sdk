/**
 * Shared pieces of the OpenCode Go and subscription-usage fixture probes
 * (`record-opencode-fixtures.ts`, `record-usage-fixtures.ts`; not a CLI):
 *
 * - the strict CI refusal (`CI` set to any non-empty value, `0` and `false` included), also used
 *   by the Gateway, OpenAI, and Anthropic probes;
 * - value-only JSON string redaction in recorded text (stream chunks one by one, or a text body),
 *   never re-chunking and never touching `{ base64 }` chunks or base64 bodies;
 * - the fail-closed survivor check: every SSE `data:` payload of the reassembled stream (text and
 *   base64 chunks decoded together) or the whole body is scanned member by member with
 *   `json-members.ts` (repeated keys included); any redacted field with a value other than `null`,
 *   `""`, or the placeholder, any repeated redacted key, and any payload the scanner cannot fully
 *   scan (invalid JSON, nesting past its depth limit, undecodable base64) refuses the write; any
 *   SSE line the stream parsers ignore (not `data:`, `event:`, `id:`, or `retry:`) refuses it
 *   unconditionally, even when it parses as JSON; only the listed non-JSON sentinels (such as
 *   `[DONE]`) are exempt, and only as a recognised `data:` payload;
 * - the injectable fixture-module writer.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Predicate, Result } from 'effect'
import * as Base64 from 'effect/encoding/Base64'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireExchange,
  type WireResponse
} from '../packages/conformance/src/fixture.ts'
import { unredactedMembers } from './json-members.ts'

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The environment the argument checks read (only `CI`). */
export type ProbeEnv = Readonly<Record<string, string | undefined>>

/**
 * True when `CI` is set to any non-empty value, `0` and `false` included: only an unset or empty
 * `CI` allows a live run.
 */
export const isCiEnvironment = (env: ProbeEnv): boolean => env.CI !== undefined && env.CI.length > 0

/** What a probe redacts: JSON string fields, their placeholder, and the permitted non-JSON payloads. */
export type RedactionSpec = {
  readonly fields: ReadonlyArray<string>
  readonly placeholder: string
  readonly permittedNonJson: ReadonlyArray<string>
}

/**
 * Account-identifying JSON fields a subscription-usage body may carry next to its windows. None is
 * read by the usage parsers, so the probes redact them (and refuse non-string values).
 */
export const accountIdentifierFields: ReadonlyArray<string> = [
  'user',
  'user_id',
  'userId',
  'account_id',
  'accountId',
  'email',
  'workspace_id',
  'workspaceId',
  'workspaceID',
  'team_id',
  'teamId',
  'org_id',
  'orgId',
  'organization_id',
  'organizationId',
  'customer_id',
  'customerId',
  'subscription_id',
  'subscriptionId'
]

// A non-empty JSON string literal, escapes included.
const nonEmptyJsonString = String.raw`"(?:[^"\\]|\\.)+"`

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replace the values of `spec.fields` in a recorded exchange, value by value: each text stream
 * chunk on its own and a text body. Chunk boundaries and every other byte are kept; base64 chunks
 * and bodies are never rewritten, so a value inside one, or split across network chunks, stays in
 * place and `redactionRefusal` refuses the recording. Returns the exchange itself when nothing
 * changed.
 */
export const redactExchange = (exchange: WireExchange, spec: RedactionSpec): WireExchange => {
  const pattern = new RegExp(
    String.raw`("(?:${spec.fields.map(escapeRegExp).join('|')})"\s*:\s*)${nonEmptyJsonString}`,
    'g'
  )

  const placeholder = JSON.stringify(spec.placeholder)

  const redactText = (text: string): string =>
    text.replace(pattern, (_match, prefix: string) => `${prefix}${placeholder}`)

  const response = exchange.response

  if (isWireStreamResponse(response)) {
    const chunks = response.chunks.map(chunk =>
      Predicate.isString(chunk) ? redactText(chunk) : chunk
    )

    return chunks.every((chunk, index) => chunk === response.chunks[index])
      ? exchange
      : { ...exchange, response: { ...response, chunks } }
  }

  if (isWireBase64BodyResponse(response)) return exchange

  const body = redactText(response.body)

  return body === response.body ? exchange : { ...exchange, response: { ...response, body } }
}

// Exact bytes of base64 text, or undefined when it does not decode (the recorder never writes
// undecodable base64, so such a recording is refused as unscannable, never read as empty).
const base64Bytes = (base64: string): Uint8Array | undefined =>
  Result.getOrUndefined(Base64.decode(base64))

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }

  return joined
}

// Non-fatal UTF-8 decode: invalid bytes become U+FFFD, the rest of the text stays checkable.
const lossyText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** SSE field lines the stream parsers understand; any other non-blank line refuses the write. */
const sseFieldLinePattern = /^(data|event|id|retry):/

/** One thing the survivor check reads from a recorded response. */
type Payload =
  /** A recognised SSE `data:` payload (the only place a sentinel such as `[DONE]` is exempt). */
  | { readonly kind: 'data'; readonly text: string }
  /** A whole response body. */
  | { readonly kind: 'body'; readonly text: string }
  /** An SSE line the stream parsers ignore; refused whatever it contains. */
  | { readonly kind: 'unknown-line' }
  /** A base64 chunk or body that does not decode; refused as unscannable. */
  | { readonly kind: 'undecodable' }

// Every SSE event's `data:` of the whole stream (text and base64 chunks reassembled as bytes) and
// every line the parsers ignore, or the whole decoded body. An empty or whitespace-only body yields
// no payload.
const responsePayloads = (response: WireResponse): ReadonlyArray<Payload> => {
  if (!isWireStreamResponse(response)) {
    if (isWireBase64BodyResponse(response)) {
      const bytes = base64Bytes(response.bodyBase64)

      if (bytes === undefined) return [{ kind: 'undecodable' }]

      const body = lossyText(bytes)

      return body.trim().length > 0 ? [{ kind: 'body', text: body }] : []
    }

    return response.body.trim().length > 0 ? [{ kind: 'body', text: response.body }] : []
  }

  const parts: Array<Uint8Array> = []
  let undecodable = 0

  for (const chunk of response.chunks) {
    if (Predicate.isString(chunk)) {
      parts.push(new TextEncoder().encode(chunk))
      continue
    }

    const bytes = base64Bytes(chunk.base64)

    if (bytes === undefined) {
      undecodable++
      continue
    }

    parts.push(bytes)
  }

  const events = lossyText(concatBytes(parts))
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .flatMap((event): ReadonlyArray<Payload> => {
      const lines = event.split('\n')

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      const unknownLines = lines
        .filter(line => line.trim().length > 0 && !sseFieldLinePattern.test(line))
        .map((): Payload => ({ kind: 'unknown-line' }))

      return data.length > 0 ? [{ kind: 'data', text: data }, ...unknownLines] : unknownLines
    })

  return [
    ...Array.from({ length: undecodable }, (): Payload => ({ kind: 'undecodable' })),
    ...events
  ]
}

type PayloadScan = { readonly fields: Set<string>; unscannable: number; unknownLines: number }

const scanExchanges = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): PayloadScan => {
  const scan: PayloadScan = { fields: new Set(), unscannable: 0, unknownLines: 0 }

  for (const { response } of exchanges) {
    for (const payload of responsePayloads(response)) {
      if (payload.kind === 'unknown-line') {
        scan.unknownLines++
        continue
      }

      if (payload.kind === 'undecodable') {
        scan.unscannable++
        continue
      }

      if (payload.kind === 'data' && spec.permittedNonJson.includes(payload.text)) continue

      const survivors = unredactedMembers(payload.text, spec.fields, spec.placeholder)

      if (survivors === undefined) {
        scan.unscannable++
        continue
      }

      for (const field of survivors) scan.fields.add(field)
    }
  }

  return scan
}

/** Redacted fields still carrying a real value (or repeated) somewhere in the recorded responses. */
export const unredactedFields = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): ReadonlyArray<string> => {
  const { fields } = scanExchanges(exchanges, spec)

  return [...new Set(spec.fields)].filter(field => fields.has(field))
}

/**
 * How many response payloads the member scanner cannot fully scan: invalid JSON, nesting past its
 * depth limit, or undecodable base64 (any count refuses the write).
 */
export const unscannablePayloads = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): number => scanExchanges(exchanges, spec).unscannable

/**
 * How many SSE lines of the recorded streams the parsers ignore (not `data:`, `event:`, `id:`, or
 * `retry:`); any count refuses the write, whatever the lines contain.
 */
export const unknownSseLines = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): number => scanExchanges(exchanges, spec).unknownLines

/**
 * Why the recorded exchanges must not be written, or undefined when every payload was scanned and
 * no redacted field survives. Both the live recording step and the write gate use it.
 */
export const redactionRefusal = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): string | undefined => {
  const { fields, unscannable, unknownLines } = scanExchanges(exchanges, spec)
  const survivors = [...new Set(spec.fields)].filter(field => fields.has(field))

  const reasons = [
    ...(unknownLines > 0
      ? [
          `found ${unknownLines} SSE line(s) the stream parsers ignore (not data:, event:, id:, or retry:), which would be kept in a public fixture unread; refusing to write, re-record instead`
        ]
      : []),
    ...(unscannable > 0
      ? [
          `could not check ${unscannable} response payload(s) for redacted fields: not valid JSON, nested past the scanner's depth limit, undecodable base64, or otherwise unscannable (only ${spec.permittedNonJson.join(', ') || 'no payload'} may be non-JSON); refusing to write, re-record instead`
        ]
      : []),
    ...(survivors.length > 0
      ? [
          `could not redact ${survivors.join(', ')} from the recording: a value survives inside a base64 body or chunk, split across network chunks, as a non-string value, or under a repeated key, which value-only redaction cannot rewrite without changing recorded chunk boundaries; refusing to write (chunks are never re-split), re-record instead`
        ]
      : [])
  ]

  return reasons.length === 0 ? undefined : reasons.join('; ')
}

/** File side effects of a probe; injectable so the write gate can be tested without writing. */
export type FixtureWriter = {
  readonly writeFile: (path: string, contents: string) => void
  /** Formats the written files (default: `pnpm exec oxfmt --write`). */
  readonly formatFiles: (paths: ReadonlyArray<string>) => void
}

export const defaultFixtureWriter: FixtureWriter = {
  writeFile: (path, contents) => writeFileSync(path, contents),
  formatFiles: paths => {
    execFileSync('pnpm', ['exec', 'oxfmt', '--write', ...paths], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    })
  }
}

/** Today's UTC calendar date (`YYYY-MM-DD`), the `recordedAt` of a new recording. */
export const today = (): string => new Date().toISOString().slice(0, 10)

/**
 * Walk CLI arguments, calling `onFlag` with each flag (`--flag value` or `--flag=value`) and a
 * reader for its value (throws when the value is missing or empty).
 */
export const parseFlags = (
  argv: ReadonlyArray<string>,
  onFlag: (flag: string, argument: string, value: () => string) => void
): void => {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)

    onFlag(flag, argument, () => {
      const next = inline ?? argv[++index]

      if (next === undefined || next.length === 0) {
        throw new Error(`${flag} requires a value`)
      }

      return next
    })
  }
}

export const positiveInteger = (flag: string, value: string): number => {
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }

  return parsed
}

/** True when this module file is the process entry point. */
export const invokedAsCli = (moduleUrl: string, argv1: string | undefined): boolean =>
  argv1 !== undefined && resolve(argv1) === fileURLToPath(moduleUrl)
