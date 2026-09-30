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
 * Request JSON never carries a credential: the presigner request drops `accessKeyId` and
 * `secretAccessKey` (they are not caught by the generic `redactPortPayload` names), and object
 * requests drop the `integration`. Bytes travel as standard base64 (`bodyBase64`).
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
// synthetic placeholders below; `findR2PortFixtureSecrets` refuses anything else, and
// `scrubR2PortFixture` rewrites a recorded fixture to them.

/** The only `X-Amz-Signature` value a committed fixture may carry. */
export const r2ConformanceSyntheticSignature = '0'.repeat(64)

/** The only access key id a committed fixture's `X-Amz-Credential` may name. */
export const r2ConformanceSyntheticAccessKeyId = 'SYNTHETICR2ACCESSKEYID'

const signatureParam = 'x-amz-signature'

const credentialParam = 'x-amz-credential'

const sessionTokenParam = 'x-amz-security-token'

/** Keys that hold an R2 credential in a port payload, whatever their case. */
const credentialKeyPattern =
  /^(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)$/i

const percentDecoded = (text: string): string => {
  let current = text

  for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(current); round++) {
    current = current.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  }

  return current
}

/** `name=value` query parameters in `text` (percent-decoded first), names lower-cased. */
const queryParams = (text: string): ReadonlyArray<readonly [string, string]> =>
  [...percentDecoded(text).matchAll(/(?:^|[?&\s"'])(x-amz-[a-z-]+)=([^&#\s"']*)/gi)].map(
    match => [(match[1] ?? '').toLowerCase(), match[2] ?? ''] as const
  )

const isSyntheticCredential = (value: string) =>
  value === r2ConformanceSyntheticAccessKeyId ||
  value.startsWith(`${r2ConformanceSyntheticAccessKeyId}/`)

/** Why a string may not be committed: one finding per live credential parameter it carries. */
const stringFindings = (text: string): ReadonlyArray<string> =>
  queryParams(text).flatMap(([name, value]) => {
    if (name === sessionTokenParam) {
      return ['X-Amz-Security-Token']
    }

    if (name === signatureParam && value !== r2ConformanceSyntheticSignature) {
      return ['a live X-Amz-Signature']
    }

    if (name === credentialParam && !isSyntheticCredential(value)) {
      return ['a live X-Amz-Credential']
    }

    return []
  })

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

  return Object.entries(value).flatMap(([key, item]) => [
    ...(credentialKeyPattern.test(key) && item !== null
      ? [`${location}.${key}: a credential`]
      : []),
    ...findingsIn(item, `${location}.${key}`)
  ])
}

/**
 * Why an R2 `PortFixture` may not be committed: every live presigned-URL credential it carries (an
 * `X-Amz-Signature` other than `r2ConformanceSyntheticSignature`, an `X-Amz-Credential` for another
 * access key id than `r2ConformanceSyntheticAccessKeyId`, any `X-Amz-Security-Token`, raw or
 * percent-encoded, anywhere in a string) and every credential key (`accessKeyId`,
 * `secretAccessKey`, `sessionToken`), as `location: finding` lines that never echo the value.
 * Empty when the fixture is safe to commit. The generic `scanPortFixtureForSecrets` does not look
 * for credential query parameters inside JSON strings, so R2 fixtures need both.
 */
export const findR2PortFixtureSecrets = (fixture: PortFixture): ReadonlyArray<string> => [
  ...findingsIn(fixture.request, 'request'),
  ...(fixture.failure === undefined
    ? findingsIn(fixture.response, 'response')
    : findingsIn(fixture.failure.message, 'failure.message'))
]

/**
 * A presigned URL with its credential replaced by the synthetic placeholders: `X-Amz-Signature`
 * becomes `r2ConformanceSyntheticSignature`, the access key id in `X-Amz-Credential` becomes
 * `r2ConformanceSyntheticAccessKeyId` (the date, region, and service scope are kept), and
 * `X-Amz-Security-Token` is removed. Other text is returned unchanged.
 */
export const scrubR2PresignedUrl = (text: string): string => {
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
    const value = url.searchParams.get(name) ?? ''

    if (lower === sessionTokenParam) {
      url.searchParams.delete(name)
    } else if (lower === signatureParam) {
      url.searchParams.set(name, r2ConformanceSyntheticSignature)
    } else if (lower === credentialParam) {
      const scope = value.split('/').slice(1)

      url.searchParams.set(name, [r2ConformanceSyntheticAccessKeyId, ...scope].join('/'))
    }
  }

  return url.toString()
}

const scrubJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) {
    return scrubR2PresignedUrl(value)
  }

  if (Array.isArray(value)) {
    return value.map(scrubJson)
  }

  if (!isJsonRecord(value)) {
    return value
  }

  const copy: Record<string, Schema.Json> = {}

  for (const [key, item] of Object.entries(value)) {
    if (!credentialKeyPattern.test(key)) {
      copy[key] = scrubJson(item)
    }
  }

  return copy
}

/**
 * An R2 `PortFixture` with every presigned URL scrubbed (`scrubR2PresignedUrl`) and every
 * credential key removed, for promoting a fixture recorded from a live host by hand. Review the
 * result anyway, and check it with `findR2PortFixtureSecrets`.
 */
export const scrubR2PortFixture = (fixture: PortFixture): PortFixture =>
  fixture.failure === undefined
    ? { ...fixture, request: scrubJson(fixture.request), response: scrubJson(fixture.response) }
    : { ...fixture, request: scrubJson(fixture.request) }
