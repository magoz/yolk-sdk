/**
 * Plain-JSON R2 backends and the bridge that turns one into the host R2 ports (`R2Presigner` and
 * `R2ObjectClient`).
 *
 * An `R2Backend` answers one port call at a time: the port name, the method, and the request as
 * plain JSON, answered with a `response` value, a `failure`, or a fail-closed `notEmulated`. The
 * bridge (`r2PortsFromBackend` / `r2PortsLayerFromBackend`) lets the R2 conformance cases run the
 * real connector action and host-only helpers against replayed `PortFixture`s
 * (`makeR2ReplayBackend`) or any structural backend.
 *
 * Request JSON never carries a credential: the presigner request is built without `accessKeyId`
 * and `secretAccessKey` (and `redactPortPayload` strips those names too), and object requests drop
 * the `integration`. Bytes travel as standard base64 (`bodyBase64`).
 *
 * For conformance and tests only: it signs nothing, speaks no S3, and is never a production host
 * adapter. Hosts implement `R2Presigner` and `R2ObjectClient` themselves.
 *
 * @experimental
 */
import { Effect, Equal, Layer, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  redactPortPayload,
  syntheticPortCredentialParams,
  type PortFailure,
  type PortFixture
} from '@yolk-sdk/conformance/fixture'
import { ConnectorError, ConnectorErrorCause } from '../../error.ts'
import { ConnectorFileTransferError } from '../../file-transfer.ts'
import { R2ObjectClient, type R2ObjectClientApi, type R2ObjectMetadata } from '../files.ts'
import {
  R2PresignOutput,
  R2Presigner,
  r2StorageConnectorId,
  type R2PresignInput,
  type R2PresignerApi
} from '../index.ts'

/** The port name every presigner `PortFixture` carries. */
export const r2PresignerPortName = 'R2Presigner'

/** The port name every object-client `PortFixture` carries. */
export const r2ObjectClientPortName = 'R2ObjectClient'

/**
 * One backend answer: a `response` value, a `failure` (the port's error channel: a
 * `ConnectorError` for the presigner, a `ConnectorFileTransferError` for the object client), or
 * `notEmulated` (the backend refuses the request; the bridge fails with `transport_failed`).
 */
export type R2BackendReply =
  | { readonly response: Schema.Json }
  | { readonly failure: PortFailure }
  | { readonly notEmulated: { readonly reason: string } }

/**
 * A structural, plain-JSON R2 backend. `request` never carries credentials or the integration. A
 * throw is reported as `transport_failed`.
 */
export type R2Backend = {
  readonly call: (port: string, method: string, request: Schema.Json) => R2BackendReply
}

const base64Chunk = 0x8000

/** Standard base64 of `bytes` (no Node `Buffer`). */
export const r2BytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''

  for (let offset = 0; offset < bytes.byteLength; offset += base64Chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + base64Chunk))
  }

  return btoa(binary)
}

/** Bytes of standard base64, or `undefined` when it does not decode. */
const base64ToBytes = (base64: string): Uint8Array | undefined => {
  try {
    const binary = atob(base64)

    return Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** The credential-free JSON request of a `presignPutObject` call. */
export const r2PresignRequestJson = (input: R2PresignInput): Schema.Json => ({
  endpoint: input.endpoint,
  bucket: input.bucket,
  key: input.key,
  contentType: input.contentType
})

type ObjectGetRequest = Parameters<R2ObjectClientApi['get']>[0]

type ObjectPutRequest = Parameters<R2ObjectClientApi['put']>[0]

/** The JSON request of an object `get` (without the integration). */
export const r2GetRequestJson = (request: ObjectGetRequest): Schema.Json =>
  request.expectedEtag === undefined
    ? { bucket: request.bucket, key: request.key, maxBytes: request.maxBytes }
    : {
        bucket: request.bucket,
        key: request.key,
        expectedEtag: request.expectedEtag,
        maxBytes: request.maxBytes
      }

/** The JSON request of an object `put` (without the integration; bytes as base64). */
export const r2PutRequestJson = (request: ObjectPutRequest): Schema.Json => ({
  bucket: request.bucket,
  key: request.key,
  condition:
    request.condition.kind === 'absent'
      ? { kind: 'absent' }
      : { kind: 'etag', etag: request.condition.etag },
  bodyBase64: r2BytesToBase64(request.bytes),
  maxUploadBytes: request.maxUploadBytes
})

const isConnectorErrorCause = Schema.is(ConnectorErrorCause)

const transferCodes: ReadonlyArray<string> = ConnectorFileTransferError.fields.code.literals

type TransferCode = ConnectorFileTransferError['code']

const isTransferCode = (code: string): code is TransferCode => transferCodes.includes(code)

const presignError = (message: string, cause: ConnectorErrorCause = 'transport_failed') =>
  new ConnectorError({ cause, message, connectorId: r2StorageConnectorId })

const transferError = (code: TransferCode, status?: number) =>
  status === undefined
    ? new ConnectorFileTransferError({ code })
    : new ConnectorFileTransferError({ code, status })

const callBackend = <E>(
  backend: R2Backend,
  port: string,
  method: string,
  request: Schema.Json,
  onThrow: () => E
): Effect.Effect<R2BackendReply, E> =>
  Effect.try({ try: () => backend.call(port, method, redactPortPayload(request)), catch: onThrow })

const PresignAnswer = Schema.Struct({ uploadUrl: Schema.String })

const MetadataAnswer = Schema.Struct({ etag: Schema.String, size: Schema.Number })

const ObjectAnswer = Schema.Struct({
  etag: Schema.String,
  size: Schema.Number,
  bodyBase64: Schema.String
})

const decodeAnswer = <A>(
  schema: Schema.Schema<A> & { readonly DecodingServices: never },
  response: Schema.Json
): A | undefined => {
  const decoded = Schema.decodeUnknownOption(schema)(response)

  return Option.isSome(decoded) ? decoded.value : undefined
}

/** A presigner failure reply as the port's `ConnectorError`. */
const presignFailure = (failure: PortFailure) =>
  presignError(failure.message, isConnectorErrorCause(failure.code) ? failure.code : undefined)

/** An object-client failure reply as the port's code-only `ConnectorFileTransferError`. */
const objectFailure = (failure: PortFailure) =>
  transferError(isTransferCode(failure.code) ? failure.code : 'upstream_failed', failure.status)

/** Both host R2 port implementations over one backend. */
export type R2Ports = {
  readonly presigner: R2PresignerApi
  readonly objects: R2ObjectClientApi
}

/**
 * The host R2 ports over a plain-JSON backend. `presignPutObject` sends the credential-free
 * request and decodes `{ uploadUrl }` (anything else fails `validation_failed`); `get` decodes
 * `{ etag, size, bodyBase64 }` and `put` `{ etag, size }` (anything else fails `invalid_metadata`).
 * A `failure` becomes the port's error (an unknown presigner cause becomes `transport_failed`, an
 * unknown object code `upstream_failed`); `notEmulated` and a throwing backend fail
 * `transport_failed`. Conformance and tests only.
 */
export const r2PortsFromBackend = (backend: R2Backend): R2Ports => ({
  presigner: {
    presignPutObject: input =>
      callBackend(
        backend,
        r2PresignerPortName,
        'presignPutObject',
        r2PresignRequestJson(input),
        () => presignError('R2 backend failed while answering R2Presigner.presignPutObject')
      ).pipe(
        Effect.flatMap(reply => {
          if ('notEmulated' in reply) {
            return Effect.fail(
              presignError(
                `R2Presigner.presignPutObject is not emulated: ${reply.notEmulated.reason}`
              )
            )
          }

          if ('failure' in reply) {
            return Effect.fail(presignFailure(reply.failure))
          }

          const answer = decodeAnswer(PresignAnswer, reply.response)

          return answer === undefined
            ? Effect.fail(
                presignError('R2 backend returned an invalid presign answer', 'validation_failed')
              )
            : Effect.succeed(R2PresignOutput.make({ uploadUrl: answer.uploadUrl }))
        })
      )
  },
  objects: {
    get: request =>
      callBackend(backend, r2ObjectClientPortName, 'get', r2GetRequestJson(request), () =>
        transferError('transport_failed')
      ).pipe(
        Effect.flatMap(reply => {
          if ('notEmulated' in reply) {
            return Effect.fail(transferError('transport_failed'))
          }

          if ('failure' in reply) {
            return Effect.fail(objectFailure(reply.failure))
          }

          const answer = decodeAnswer(ObjectAnswer, reply.response)
          const bytes = answer === undefined ? undefined : base64ToBytes(answer.bodyBase64)

          return answer === undefined || bytes === undefined
            ? Effect.fail(transferError('invalid_metadata'))
            : Effect.succeed({ etag: answer.etag, size: answer.size, bytes })
        })
      ),
    put: request =>
      callBackend(backend, r2ObjectClientPortName, 'put', r2PutRequestJson(request), () =>
        transferError('transport_failed')
      ).pipe(
        Effect.flatMap(reply => {
          if ('notEmulated' in reply) {
            return Effect.fail(transferError('transport_failed'))
          }

          if ('failure' in reply) {
            return Effect.fail(objectFailure(reply.failure))
          }

          const answer = decodeAnswer(MetadataAnswer, reply.response)

          return answer === undefined
            ? Effect.fail(transferError('invalid_metadata'))
            : Effect.succeed<R2ObjectMetadata>({ etag: answer.etag, size: answer.size })
        })
      )
  }
})

/**
 * `R2Presigner` and `R2ObjectClient` layer over a backend. The backend value is captured, so every
 * build shares it (build a fresh backend per case, for example inside `Layer.suspend`, when cases
 * must not share state).
 */
export const r2PortsLayerFromBackend = (
  backend: R2Backend
): Layer.Layer<R2Presigner | R2ObjectClient> => {
  const ports = r2PortsFromBackend(backend)

  return Layer.mergeAll(
    Layer.succeed(R2Presigner, R2Presigner.of(ports.presigner)),
    Layer.succeed(R2ObjectClient, R2ObjectClient.of(ports.objects))
  )
}

/** One call a replay backend answered or refused. */
export type R2ReplayLedgerEntry = {
  readonly seq: number
  readonly port: string
  readonly method: string
  /** The credential-free request as received. */
  readonly request: Schema.Json
  readonly outcome: 'matched' | 'unmatched'
  /** The fixture that answered a matched call. */
  readonly fixtureId?: string
}

export type R2Replay = {
  readonly backend: R2Backend
  readonly ledger: {
    readonly entries: () => ReadonlyArray<R2ReplayLedgerEntry>
    /** Fixture ids not consumed yet, in fixture order. */
    readonly remaining: () => ReadonlyArray<string>
  }
}

const replyOf = (fixture: PortFixture): R2BackendReply =>
  fixture.failure === undefined ? { response: fixture.response } : { failure: fixture.failure }

/**
 * A fail-closed replay backend over R2 `PortFixture`s. A call matches the first unconsumed fixture
 * with the same port, method, and an equal credential-free request (structural JSON equality).
 * Each fixture answers at most once, in fixture order among identical requests. A call without an
 * unconsumed match is refused with `notEmulated` and still written to the ledger. State lives in
 * the returned value: create one replay per case.
 */
export const makeR2ReplayBackend = (fixtures: ReadonlyArray<PortFixture>): R2Replay => {
  const consumed = new Set<number>()
  const entries: Array<R2ReplayLedgerEntry> = []

  const call = (port: string, method: string, rawRequest: Schema.Json): R2BackendReply => {
    const request = redactPortPayload(rawRequest)
    const seq = entries.length + 1

    const index = fixtures.findIndex(
      (fixture, position) =>
        !consumed.has(position) &&
        fixture.port === port &&
        fixture.method === method &&
        Equal.equals(redactPortPayload(fixture.request), request)
    )

    const fixture = fixtures[index]

    if (fixture === undefined) {
      entries.push({ seq, port, method, request, outcome: 'unmatched' })

      return { notEmulated: { reason: 'no unconsumed fixture matches this request' } }
    }

    consumed.add(index)
    entries.push({ seq, port, method, request, outcome: 'matched', fixtureId: fixture.id })

    return replyOf(fixture)
  }

  return {
    backend: { call },
    ledger: {
      entries: () => entries.map(entry => ({ ...entry })),
      remaining: () =>
        fixtures.flatMap((fixture, position) => (consumed.has(position) ? [] : [fixture.id]))
    }
  }
}

// Presigned URLs carry their credential in the query string. Committed fixtures may only hold the
// synthetic placeholders below, which are exactly the SigV4 entries of the shared, frozen
// `syntheticPortCredentialParams` (one source: the shared `scanPortFixtureForSecrets` exempts only
// those exact values, under their own parameter names, and refuses every other credential
// parameter and any `accessKeyId` / `secretAccessKey` / `sessionToken` field).
// `findR2PortFixtureSecrets` is the fail-closed backstop for what the shared scan cannot read
// (encoded or escaped names): it blanks the canonical placeholder occurrences out and refuses any
// credential name left in any decoding layer. `scrubR2PortFixture` rewrites a recorded fixture to
// the placeholders.

/** The only `X-Amz-Signature` value a committed fixture may carry. */
export const r2ConformanceSyntheticSignature = syntheticPortCredentialParams['x-amz-signature']

/**
 * The only `X-Amz-Credential` value a committed fixture may carry, whole (access key id, date,
 * region, service, and `aws4_request`).
 */
export const r2ConformanceSyntheticCredential = syntheticPortCredentialParams['x-amz-credential']

/**
 * The access key id `r2ConformanceSyntheticCredential` names. Replay resolves the
 * `r2-storage.access_key_id` credential to it, so a replayed presigned URL is signed for the
 * credential the connector passed.
 */
export const r2ConformanceSyntheticAccessKeyId = r2ConformanceSyntheticCredential.slice(
  0,
  r2ConformanceSyntheticCredential.indexOf('/')
)

const signatureParam = 'x-amz-signature'

const credentialParam = 'x-amz-credential'

const sessionTokenParam = 'x-amz-security-token'

/**
 * `text` with one layer of `%XX` escapes decoded. The guard applies at most three rounds of it, the
 * same percent depth as the shared scan's `percentDecodedLayers` (`@yolk-sdk/conformance`,
 * internal): keep the two in step.
 */
const percentDecodedOnce = (text: string): string =>
  text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )

const codePoint = (value: number): string => String.fromCodePoint(Math.min(value, 0x10ffff))

/**
 * `text` with one layer of the escapes a serializer adds by accident decoded: JSON `\uXXXX`,
 * `\xXX`, `\\` (one backslash), and numeric HTML character references (`&#88;`, `&#x58;`). One
 * pass, left to right, so a doubly escaped `\\u0058` becomes `\u0058` and needs a second round.
 */
const escapesDecodedOnce = (text: string): string =>
  text.replace(
    /\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\\\|&#[xX]([0-9A-Fa-f]{1,6});?|&#([0-9]{1,7});?/g,
    (match, unicode?: string, hex?: string, entityHex?: string, entity?: string) => {
      const hexDigits = unicode ?? hex ?? entityHex

      if (hexDigits !== undefined) {
        return codePoint(Number.parseInt(hexDigits, 16))
      }

      if (entity !== undefined) {
        return codePoint(Number.parseInt(entity, 10))
      }

      return match === '\\\\' ? '\\' : match
    }
  )

/** Rounds of each decoding the guard applies, in any order (so at most six rounds in all). */
const maxRoundsPerDecoding = 3

/**
 * Every variant of `text` reachable with at most three rounds of percent-decoding and at most three
 * rounds of escape-decoding, in every order (the original included), deduplicated.
 */
const decodedVariants = (text: string): ReadonlyArray<string> => {
  const seen = new Set<string>([text])

  let frontier: ReadonlyArray<{ text: string; percent: number; escapes: number }> = [
    { text, percent: 0, escapes: 0 }
  ]

  while (frontier.length > 0) {
    frontier = frontier.flatMap(variant => {
      const next = [
        ...(variant.percent < maxRoundsPerDecoding
          ? [{ ...variant, text: percentDecodedOnce(variant.text), percent: variant.percent + 1 }]
          : []),
        ...(variant.escapes < maxRoundsPerDecoding
          ? [{ ...variant, text: escapesDecodedOnce(variant.text), escapes: variant.escapes + 1 }]
          : [])
      ]

      return next.filter(candidate => {
        if (seen.has(candidate.text)) {
          return false
        }

        seen.add(candidate.text)

        return true
      })
    })
  }

  return [...seen]
}

// The only credential parameters a committed fixture may spell out, each exactly as the fixtures
// and `scrubR2PortFixture` write it: `URLSearchParams` leaves the signature as it is and encodes
// the credential's `/` as `%2F`. Nothing else is exempt.
const canonicalPlaceholders = new Map<string, string>([
  [signatureParam, r2ConformanceSyntheticSignature],
  [credentialParam, encodeURIComponent(r2ConformanceSyntheticCredential)]
])

// A canonical placeholder occurrence: `?` or `&` (or the start), a raw ASCII name (any case), `=`,
// then the exact canonical value, followed by `&`, `#`, whitespace, `"`, `<`, `>`, or the end.
const canonicalNamesAt = /(^|[?&])(x-amz-signature|x-amz-credential)=/gi

const canonicalValueEnd = /^(?:[&#\s"<>]|$)/

/** `text` with every canonical placeholder occurrence (name, `=`, and value) blanked out. */
const withoutCanonicalPlaceholders = (text: string): string => {
  let masked = text

  for (const match of text.matchAll(canonicalNamesAt)) {
    const nameStart = match.index + (match[1] ?? '').length
    const valueStart = match.index + match[0].length
    const placeholder = canonicalPlaceholders.get((match[2] ?? '').toLowerCase()) ?? ''
    const valueEnd = valueStart + placeholder.length

    if (
      placeholder.length > 0 &&
      text.startsWith(placeholder, valueStart) &&
      canonicalValueEnd.test(text.slice(valueEnd))
    ) {
      const blank = ' '.repeat(valueEnd - nameStart)

      masked = `${masked.slice(0, nameStart)}${blank}${masked.slice(valueEnd)}`
    }
  }

  return masked
}

// The credential names the guard reports, in report order.
const credentialNames = [
  [credentialParam, 'a live X-Amz-Credential'],
  [signatureParam, 'a live X-Amz-Signature'],
  [sessionTokenParam, 'X-Amz-Security-Token']
] as const

/**
 * Why a string may not be committed: one finding per credential name it still carries once the
 * canonical placeholder occurrences are blanked out. The masked text and every variant reachable
 * with at most three rounds of percent-decoding and three of escape-decoding, in any order
 * (`decodedVariants`), are searched for each name anywhere, case-insensitively, with no `=` or
 * value needed, prose included. Deliberate obfuscation (base64, other encodings, deeper nesting)
 * is out of scope: a person reviews every recording before promoting it.
 */
const stringFindings = (text: string): ReadonlyArray<string> => {
  const searched = decodedVariants(withoutCanonicalPlaceholders(text)).map(variant =>
    variant.toLowerCase()
  )

  return credentialNames.flatMap(([name, finding]) =>
    searched.some(variant => variant.includes(name)) ? [finding] : []
  )
}

const isJsonRecord = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && Predicate.isObject(value) && !Array.isArray(value)

const findingsIn = (value: Schema.Json, location: string): ReadonlyArray<string> => {
  if (Predicate.isString(value)) {
    return stringFindings(value).map(finding => `${location}: ${finding}`)
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findingsIn(item, `${location}[${index}]`))
  }

  if (!isJsonRecord(value)) {
    return []
  }

  // Keys are searched too: a credential name spelled as a JSON key is refused like any other.
  return Object.entries(value).flatMap(([key, item]) => [
    ...stringFindings(key).map(finding => `${location}.${key}: ${finding}`),
    ...findingsIn(item, `${location}.${key}`)
  ])
}

/**
 * Why an R2 `PortFixture` may not be committed, beyond the shared `scanPortFixtureForSecrets` (run
 * both). Fail-closed, over every string (and JSON key) of the fixture: `id`, `port`, `method`,
 * `note`, `observed.account`, the request, and the response or the failure code and message.
 *
 * 1. The canonical placeholder occurrences are blanked out: `?` or `&` (or the start of the
 *    string), `X-Amz-Signature` or `X-Amz-Credential` in raw ASCII (any case), `=`, and exactly the
 *    value the fixtures and the scrubber write (`r2ConformanceSyntheticSignature`, or
 *    `encodeURIComponent(r2ConformanceSyntheticCredential)`), followed by `&`, `#`, whitespace,
 *    `"`, `<`, `>`, or the end.
 * 2. The rest is searched raw and in every variant reachable with at most three rounds of
 *    percent-decoding and three of escape-decoding (JSON `\uXXXX`, `\xXX`, `\\`, numeric HTML
 *    character references), in any order. ANY case-insensitive `x-amz-credential`,
 *    `x-amz-signature`, or `x-amz-security-token` is a finding: another value, an encoded or
 *    escaped name (even with the exact placeholder), an encoded URL, or a name in prose.
 *
 * Findings are `location: finding` lines, one per name and string, that never echo a value.
 * Deliberate obfuscation (base64, other encodings, deeper nesting) is out of scope; a person
 * reviews every recording before promoting it. Empty when clean.
 */
export const findR2PortFixtureSecrets = (fixture: PortFixture): ReadonlyArray<string> => [
  ...findingsIn(fixture.id, 'id'),
  ...findingsIn(fixture.port, 'port'),
  ...findingsIn(fixture.method, 'method'),
  ...(fixture.observed === undefined
    ? []
    : findingsIn(fixture.observed.account, 'observed.account')),
  ...findingsIn(fixture.request, 'request'),
  ...(fixture.failure === undefined
    ? findingsIn(fixture.response, 'response')
    : [
        ...findingsIn(fixture.failure.code, 'failure.code'),
        ...findingsIn(fixture.failure.message, 'failure.message')
      ]),
  ...(fixture.note === undefined ? [] : findingsIn(fixture.note, 'note'))
]

/** One presigned URL with its credential replaced by the synthetic placeholders. */
const scrubUrl = (text: string): string => {
  let url: URL

  try {
    url = new URL(text)
  } catch {
    return text
  }

  const names = [...url.searchParams.keys()]

  if (!names.some(name => name.toLowerCase().startsWith('x-amz-'))) {
    return text
  }

  for (const name of names) {
    const lower = name.toLowerCase()

    if (lower === sessionTokenParam) {
      url.searchParams.delete(name)
    } else if (lower === signatureParam) {
      url.searchParams.set(name, r2ConformanceSyntheticSignature)
    } else if (lower === credentialParam) {
      url.searchParams.set(name, r2ConformanceSyntheticCredential)
    }
  }

  return url.toString()
}

/**
 * `text` with every presigned URL in it (the whole string, or an `http(s)://` URL embedded in a
 * message, up to whitespace, `"`, `'`, `<`, or `>`) scrubbed: `X-Amz-Signature` becomes
 * `r2ConformanceSyntheticSignature`, the whole `X-Amz-Credential` becomes
 * `r2ConformanceSyntheticCredential` (the live date and region are not kept, since the shared scan
 * accepts only the exact placeholder), and
 * `X-Amz-Security-Token` is removed. Percent-encoded or `&amp;`-escaped URLs are NOT rewritten:
 * rerun `scanPortFixtureForSecrets` and `findR2PortFixtureSecrets` after scrubbing and remove what
 * they still find by hand. A URL quoted in `'` keeps its closing quote right after the scrubbed
 * value, which both scans then refuse (`'` continues a query value): remove the quote by hand.
 */
export const scrubR2PresignedUrl = (text: string): string =>
  text.replace(/https?:\/\/[^\s"'<>]+/g, scrubUrl)

const scrubJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    return scrubR2PresignedUrl(value)
  }

  if (Array.isArray(value)) {
    return value.map(scrubJson)
  }

  return isJsonRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubJson(item)]))
    : value
}

/**
 * An R2 `PortFixture` with every presigned URL scrubbed (`scrubR2PresignedUrl`) in the request,
 * the response, the note, and the failure message, and every credential field removed
 * (`redactPortPayload`), for promoting a fixture recorded from a live host by hand. Escaped URLs
 * are not rewritten: rerun both `scanPortFixtureForSecrets` and `findR2PortFixtureSecrets` on the
 * result, and review it.
 */
export const scrubR2PortFixture = (fixture: PortFixture): PortFixture => {
  const scrubbed: PortFixture =
    fixture.failure === undefined
      ? {
          ...fixture,
          request: scrubJson(redactPortPayload(fixture.request)),
          response: scrubJson(redactPortPayload(fixture.response))
        }
      : {
          ...fixture,
          request: scrubJson(redactPortPayload(fixture.request)),
          failure: { ...fixture.failure, message: scrubR2PresignedUrl(fixture.failure.message) }
        }

  return fixture.note === undefined
    ? scrubbed
    : { ...scrubbed, note: scrubR2PresignedUrl(fixture.note) }
}
