/**
 * Shared pieces of the OpenCode Go and subscription-usage fixture probes
 * (`record-opencode-fixtures.ts`, `record-usage-fixtures.ts`; not a CLI):
 *
 * - the strict CI refusal (`CI` set to any non-empty value, `0` and `false` included);
 * - value-only JSON string redaction in recorded text (stream chunks one by one, or a text body),
 *   never re-chunking and never touching `{ base64 }` chunks or base64 bodies;
 * - the fail-closed survivor check: every SSE `data:` payload of the reassembled stream (text and
 *   base64 chunks decoded together) or the whole body is scanned member by member with
 *   `json-members.ts` (repeated keys included); any redacted field with a value other than `null`,
 *   `""`, or the placeholder, any repeated redacted key, and any payload the scanner cannot fully
 *   scan (invalid JSON, nesting past its depth limit, SSE lines the parsers ignore) refuses the
 *   write; only the listed non-JSON sentinels (such as `[DONE]`) are exempt;
 * - the injectable fixture-module writer.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Encoding, Predicate, Result } from 'effect'
import {
  isWireBase64BodyResponse,
  isWireStreamResponse,
  type WireChunk,
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

// Exact bytes of base64 text; undecodable base64 yields no bytes (the recorder never writes it).
const base64Bytes = (base64: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeBase64(base64), () => new Uint8Array())

const chunkBytes = (chunk: WireChunk): Uint8Array =>
  Predicate.isString(chunk) ? new TextEncoder().encode(chunk) : base64Bytes(chunk.base64)

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

/** SSE field lines the stream parsers understand; any other non-blank line is unscannable. */
const sseFieldLinePattern = /^(data|event|id|retry):/

// Every SSE event's `data:` of the whole stream (text and base64 chunks reassembled as bytes), or
// the whole decoded body. Unparsed SSE lines are returned as their own payloads, so the member
// scanner refuses them. An empty or whitespace-only body yields no payload.
const responsePayloads = (response: WireResponse): ReadonlyArray<string> => {
  if (!isWireStreamResponse(response)) {
    const body = isWireBase64BodyResponse(response)
      ? lossyText(base64Bytes(response.bodyBase64))
      : response.body

    return body.trim().length > 0 ? [body] : []
  }

  return lossyText(concatBytes(response.chunks.map(chunkBytes)))
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .flatMap(event => {
      const lines = event.split('\n')

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      const unparsedLines = lines.filter(
        line => line.trim().length > 0 && !sseFieldLinePattern.test(line)
      )

      return data.length > 0 ? [data, ...unparsedLines] : unparsedLines
    })
}

type PayloadScan = { readonly fields: Set<string>; unscannable: number }

const scanExchanges = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): PayloadScan => {
  const scan: PayloadScan = { fields: new Set(), unscannable: 0 }

  for (const { response } of exchanges) {
    for (const payload of responsePayloads(response)) {
      if (spec.permittedNonJson.includes(payload)) continue

      const survivors = unredactedMembers(payload, spec.fields, spec.placeholder)

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

/** How many response payloads the member scanner cannot fully scan (any count refuses the write). */
export const unscannablePayloads = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): number => scanExchanges(exchanges, spec).unscannable

/**
 * Why the recorded exchanges must not be written, or undefined when every payload was scanned and
 * no redacted field survives. Both the live recording step and the write gate use it.
 */
export const redactionRefusal = (
  exchanges: ReadonlyArray<WireExchange>,
  spec: RedactionSpec
): string | undefined => {
  const { fields, unscannable } = scanExchanges(exchanges, spec)
  const survivors = [...new Set(spec.fields)].filter(field => fields.has(field))

  const reasons = [
    ...(unscannable > 0
      ? [
          `could not check ${unscannable} response payload(s) for redacted fields: not valid JSON, nested past the scanner's depth limit, or otherwise unscannable (only ${spec.permittedNonJson.join(', ') || 'no payload'} may be non-JSON); refusing to write, re-record instead`
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
