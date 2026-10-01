/**
 * R2 emulator: a fixture-driven, in-memory fake backend for the host R2 ports `R2Presigner` and
 * `R2ObjectClient`.
 *
 * The R2 connector never talks to R2 itself: hosts implement `R2Presigner` (local SigV4 signing of
 * a PUT URL) and `R2ObjectClient` (conditional get and put). This emulator stands in for such a
 * host at the port level: `call(port, method, request)` takes one port call as plain JSON (the
 * credential-free request; bytes as base64) and answers `{ response }`, `{ failure }`, or a
 * fail-closed `{ notEmulated }`. There is no S3, SigV4 signer, socket, `node:` builtin, or SDK
 * import here: it is a plain structural object, and `r2PortsLayerFromBackend` in
 * `@yolk-sdk/connectors/r2-storage/conformance` turns it into both port layers.
 *
 * Response behaviour comes ONLY from the R2 conformance fixtures (copied as data in
 * `r2-fixtures.ts`). The emulator keeps an in-memory bucket (objects with their etag and bytes)
 * seeded with the object the fixtures describe; the state only selects which fixture answers (the
 * first matching fixture consistent with the bucket) and is updated with what that fixture says
 * happened (an object created or replaced under the etag the fixture names). It never invents an
 * etag, a byte, a failure, or a response. Presigning writes nothing.
 *
 * Credentials: every credential field (the shared port scan's `isPortCredentialKey` names, copied
 * in `r2-guard.ts`) is dropped at any depth before anything is compared or recorded. Every refusal
 * (`unknown-method`, `invalid-request`, `uncheckable-body`, `credential-in-request`,
 * `uncheckable-request`, `no-matching-fixture`, `state-conflict`) is ledgered with constant text
 * only (request `<redacted>`; port and method `<unrecognised>` for `unknown-method` and
 * `uncheckable-request`), uses no fault, and changes no state. Only a request equal to a fixture
 * request (minus credential fields) is recorded, so the ledger holds fixture text, with every
 * `bodyBase64` as `<redacted>` plus `bodyBytes` (the decoded length). An own `__proto__` key at any
 * depth is `invalid-request`. Every `bodyBase64` must be canonical standard base64 of UTF-8 text
 * (else `uncheckable-body`); its decoded text is checked with the request's own texts. A request is
 * `credential-in-request` when any key, string value, number (as printed and, for an integer, as
 * its digit string), or decoded body repeats a guarded value, or holds, once the exact canonical
 * placeholders are blanked out, a SigV4 credential name, a credential query parameter, or a token
 * the shared scan flags (a bearer token, an API-key prefix, a JSON Web Token, a PEM private key).
 * Guarded values are every non-empty key, string, and number under a credential field (a numeric
 * string also in its number forms), with no minimum length, unlike the shared helpers. Both checks
 * run raw, in R2's own decodings (`decodedVariants`: up to three percent and three escape rounds,
 * with `\uXXXX`, `\xXX`, and numeric HTML references), and through the shared fail-closed closure
 * (`textClosureOutcome` of `stateful-secrets.ts`, imported, never copied; a cap refuses). A request
 * the checks cannot walk (cyclic, or nested too deeply) is `uncheckable-request`: `call` never
 * throws. The copied credential key, parameter, and token lists live in `r2-guard.ts`;
 * `test/r2.test.ts` holds one sample per entry of each, asserts each sample count equals its list's
 * length, and checks every sample against the shared scan (`isPortCredentialKey`,
 * `scanPortFixtureForSecrets`) and the emulator, so an entry added here without a sample fails. A
 * name or pattern the shared scan adds later is not enforced until it is copied here with a sample.
 *
 * Request-shape latitude (the only one): credential fields are never compared or recorded, and JSON
 * key order is not compared. Everything else (the endpoint, bucket, key, content type, `maxBytes`,
 * `expectedEtag`, the put `condition`, `bodyBase64`, and `maxUploadBytes`) must equal a fixture
 * request exactly, so only the fixtures' `run-synthetic` run id is emulated. A `bodyBase64` must be
 * canonical standard base64 of UTF-8 text (else `uncheckable-body`); it is compared as sent but
 * recorded only as its decoded length. No object may have an own `__proto__` key (else
 * `invalid-request`), and no key or value, the decoded body included, may carry a credential or
 * repeat a dropped credential value of any length (else `credential-in-request`). Every refusal is
 * ledgered with constant text only (request `<redacted>`). Anything that does not match (an unknown
 * port or method, no matching fixture, or no fixture consistent with the bucket) fails closed with
 * a ledgered `notEmulated` answer, the port analogue of HTTP 400.
 *
 * @experimental
 */
import { Data, Equal, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  r2EmulatorFixtures,
  type R2EmulatorFailure,
  type R2EmulatorFixture
} from './r2-fixtures.ts'
import {
  bindRouteHandlers,
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'
import {
  guardedValues,
  hasOwnProtoKey,
  textCarriesCredential,
  textsOf,
  withoutCredentials
} from './r2-guard.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { r2EmulatorFixtures, type R2EmulatorFailure, type R2EmulatorFixture }

/** The presigner port the presign fixture and manifest route name. */
export const r2EmulatorPresignerPort = 'R2Presigner'

/** The object-client port the get and put fixtures and manifest routes name. */
export const r2EmulatorObjectClientPort = 'R2ObjectClient'

/** Manifest routes of port emulators use this pseudo method; `path` is `<Port>.<method>`. */
export const r2EmulatorRouteMethod = 'PORT'

const portRoute = (
  port: string,
  method: string,
  write: boolean,
  caseIds: ReadonlyArray<string>
): EmulatorRouteEvidence => ({
  method: r2EmulatorRouteMethod,
  path: `${port}.${method}`,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  observedAt: undefined
})

const presignUploadUrl = 'r2.presign.put-upload-url'

const getMaxBytes = 'r2.objects.get-max-bytes'

const getExpectedEtag = 'r2.objects.get-expected-etag'

const getMissing = 'r2.objects.get-missing-not-found'

const createIfAbsent = 'r2.objects.create-if-absent'

const updateIfMatch = 'r2.objects.update-if-match'

/**
 * Route evidence manifest: every emulated port method (`PORT <Port>.<method>`) and the R2
 * conformance cases whose (synthetic, unverified) fixtures it follows. `R2ObjectClient.put` is an
 * unverified connector write: it needs a pending entry in the repo's evidence check until an
 * owner-approved live run against a practice bucket verifies it. Presigning is local signing and
 * `get` reads, so neither is a write.
 */
export const r2EmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  portRoute(r2EmulatorPresignerPort, 'presignPutObject', false, [presignUploadUrl]),
  portRoute(r2EmulatorObjectClientPort, 'get', false, [
    getMaxBytes,
    getExpectedEtag,
    getMissing,
    createIfAbsent,
    updateIfMatch
  ]),
  portRoute(r2EmulatorObjectClientPort, 'put', true, [createIfAbsent, updateIfMatch])
]

const NonEmpty = Schema.String.check(Schema.isNonEmpty())

/** Bytes of canonical standard base64, or `undefined` when it does not decode canonically. */
const base64Bytes = (text: string): Uint8Array | undefined => {
  let binary: string

  try {
    binary = atob(text)
  } catch {
    return undefined
  }

  return btoa(binary) === text
    ? Uint8Array.from(binary, character => character.charCodeAt(0))
    : undefined
}

const Base64 = Schema.String.check(
  Schema.makeFilter((text: string) => base64Bytes(text) !== undefined, {
    identifier: 'R2EmulatorBase64',
    description: 'canonical standard base64'
  })
)

/** One object in the emulated bucket: its key, its etag (quotes kept), and its bytes as base64. */
export const R2EmulatorObject = Schema.Struct({
  key: NonEmpty,
  etag: NonEmpty,
  bodyBase64: Base64
})

export type R2EmulatorObject = typeof R2EmulatorObject.Type

export const R2EmulatorBucket = Schema.Struct({
  name: NonEmpty,
  objects: Schema.Array(R2EmulatorObject)
})

export type R2EmulatorBucket = typeof R2EmulatorBucket.Type

/** The emulated buckets: plain JSON, used both as the seed and as the `state()` snapshot. */
export const R2EmulatorSeed = Schema.Struct({
  buckets: Schema.Array(R2EmulatorBucket)
})

export type R2EmulatorSeed = typeof R2EmulatorSeed.Type

/**
 * The synthetic practice bucket the R2 fixtures describe (the default seed): the seeded object the
 * get fixtures read, with the etag and bytes they answer.
 */
export const r2EmulatorDefaultSeed: R2EmulatorSeed = {
  buckets: [
    {
      name: 'yolk-synthetic-bucket',
      objects: [
        {
          key: 'fixtures/synthetic-object.txt',
          etag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
          bodyBase64: 'U3ludGhldGljIGNvbmZvcm1hbmNlIG9iamVjdDogc2FmZSB0byByZWFkLgo='
        }
      ]
    }
  ]
}

const Failure = Schema.Struct({
  kind: Schema.Literals(['expected', 'error']),
  code: NonEmpty,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int)
})

/**
 * A fault: answer the next `count` calls (every one when omitted) of `port` and `method` whose
 * credential-free request contains `match` (a deep subset: objects by key, arrays element by
 * element, other values exactly) with `failure` instead of a fixture. Faults apply only to a call a
 * fixture would answer, and change no bucket state.
 */
export const R2EmulatorFault = Schema.Struct({
  kind: Schema.Literal('failure'),
  port: NonEmpty,
  method: NonEmpty,
  match: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  count: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  failure: Failure
})

export type R2EmulatorFault = typeof R2EmulatorFault.Type

export type R2EmulatorFaultState = {
  readonly id: number
  readonly fault: R2EmulatorFault
  /** Remaining matching calls; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

/** Thrown by `makeR2Emulator` (invalid seed) and `faults.add` (invalid fault). */
export class R2EmulatorInputInvalid extends Data.TaggedError('R2EmulatorInputInvalid')<{
  readonly input: 'seed' | 'fault'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid R2 emulator ${this.input}: ${this.reason}`
  }
}

/** Why a call failed closed. */
export type R2EmulatorNotEmulatedReason =
  | 'unknown-method'
  | 'invalid-request'
  | 'uncheckable-body'
  | 'credential-in-request'
  | 'uncheckable-request'
  | 'no-matching-fixture'
  | 'state-conflict'

const notEmulatedText: Record<R2EmulatorNotEmulatedReason, string> = {
  'unknown-method': 'unknown-method: the port and method have no emulated route',
  'invalid-request': 'invalid-request: the request is not a JSON object',
  'uncheckable-body': 'uncheckable-body: a bodyBase64 is not canonical base64 of UTF-8 text',
  'credential-in-request':
    'credential-in-request: the request carries a credential outside its credential fields',
  'uncheckable-request': 'uncheckable-request: the request could not be checked',
  'no-matching-fixture': 'no-matching-fixture: no fixture matches this request',
  'state-conflict': 'state-conflict: no matching fixture is consistent with the emulated bucket'
}

/** The constant port, method, and request of a ledger entry that records nothing it received. */
export const r2EmulatorRedacted = '<redacted>'

export const r2EmulatorUnrecognised = '<unrecognised>'

/** One emulator answer; structurally the reply of a plain-JSON `R2Backend`. */
export type R2EmulatorReply =
  | { readonly response: Schema.Json }
  | { readonly failure: R2EmulatorFailure }
  | { readonly notEmulated: { readonly reason: string } }

export type R2EmulatorLedgerEntry = {
  readonly seq: number
  /** The port, or `<unrecognised>` for an `unknown-method` or `uncheckable-request` refusal. */
  readonly port: string
  /** The method, or `<unrecognised>` for an `unknown-method` or `uncheckable-request` refusal. */
  readonly method: string
  /**
   * For an answered or faulted call, the request without credential fields (a fixture request) with
   * every `bodyBase64` value replaced by `<redacted>`; `<redacted>` whole for every refusal.
   */
  readonly request: Schema.Json
  /** The decoded byte length of a recorded request's top-level `bodyBase64`. */
  readonly bodyBytes?: number
  readonly outcome: 'answered' | 'fault' | 'not-emulated'
  /** `unknown-method` for a call outside the manifest. */
  readonly evidence: EmulatorEvidence | 'unknown-method'
  readonly fixtureId?: string
  readonly faultId?: number
  readonly reason?: R2EmulatorNotEmulatedReason
}

export type R2EmulatorRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger calls to this route since the last ledger clear or reset. */
  readonly calls: number
}

export type R2EmulatorCoverage = {
  readonly routes: ReadonlyArray<R2EmulatorRouteCoverage>
  /** Ledger calls that failed closed. */
  readonly notEmulatedCalls: number
  /** Fixtures that have not answered a call since the emulator was made or last reset. */
  readonly unusedFixtureIds: ReadonlyArray<string>
}

export type R2EmulatorOptions = {
  /** The initial buckets. Defaults to `r2EmulatorDefaultSeed`. */
  readonly seed?: R2EmulatorSeed
}

export type R2Emulator = {
  /** Answer one R2 port call; never throws. This makes the emulator an `R2Backend`. */
  readonly call: (port: string, method: string, request: Schema.Json) => R2EmulatorReply
  /** The current buckets (a copy). */
  readonly state: () => R2EmulatorSeed
  /** The seed the emulator started from (a copy). */
  readonly seed: () => R2EmulatorSeed
  readonly ledger: {
    readonly entries: () => ReadonlyArray<R2EmulatorLedgerEntry>
    readonly clear: () => void
  }
  /** Clear the ledger and faults, forget fixture use, and restore the seeded buckets. */
  readonly reset: () => void
  readonly faults: {
    readonly add: (fault: R2EmulatorFault) => R2EmulatorFaultState
    readonly list: () => ReadonlyArray<R2EmulatorFaultState>
    readonly clear: () => void
  }
  readonly coverage: () => R2EmulatorCoverage
}

// JSON helpers.

type JsonObject = Schema.JsonObject

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

const objectField = (value: Schema.Json | undefined, key: string): JsonObject | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return isJsonObject(field) ? field : undefined
}

const stringField = (value: Schema.Json | undefined, key: string): string | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return Predicate.isString(field) ? field : undefined
}

const numberField = (value: Schema.Json | undefined, key: string): number | undefined => {
  const field = isJsonObject(value) ? value[key] : undefined

  return Predicate.isNumber(field) ? field : undefined
}

/** The field that carries put bytes as base64; checked and recorded only as decoded text. */
const bodyField = 'bodyBase64'

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The UTF-8 text of canonical standard base64, or `undefined` when it is anything else. */
const bodyText = (value: Schema.Json): string | undefined => {
  const bytes = Predicate.isString(value) ? base64Bytes(value) : undefined

  if (bytes === undefined) return undefined

  try {
    return utf8.decode(bytes)
  } catch {
    return undefined
  }
}

/** Every `bodyBase64` value of `value`, at any depth. */
const bodyValues = (value: Schema.Json): ReadonlyArray<Schema.Json> => {
  if (Array.isArray(value)) return value.flatMap(bodyValues)

  if (!isJsonObject(value)) return []

  return Object.entries(value).flatMap(([key, item]) =>
    key === bodyField ? [item] : bodyValues(item)
  )
}

/** A copy with every `bodyBase64` value replaced by `<redacted>`, at any depth. */
const withoutBodies = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(withoutBodies)

  if (!isJsonObject(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === bodyField ? r2EmulatorRedacted : withoutBodies(item)
    ])
  )
}

/** Deep subset: objects by key, arrays element by element (same length), other values exactly. */
const containsSubset = (value: Schema.Json | undefined, pattern: Schema.Json): boolean => {
  if (value === undefined) return false

  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) &&
      value.length === pattern.length &&
      pattern.every((item, index) => containsSubset(value[index], item))
    )
  }

  if (isJsonObject(pattern)) {
    return (
      isJsonObject(value) &&
      Object.entries(pattern).every(
        ([key, item]) => Object.hasOwn(value, key) && containsSubset(value[key], item)
      )
    )
  }

  return Equal.equals(value, pattern)
}

// Bucket state.

type ObjectState = { readonly key: string; etag: string; bodyBase64: string }

type BucketState = { readonly name: string; objects: Array<ObjectState> }

type BucketsState = { readonly buckets: Array<BucketState> }

const bucketsFrom = (seed: R2EmulatorSeed): BucketsState => ({
  buckets: seed.buckets.map(bucket => ({
    name: bucket.name,
    objects: bucket.objects.map(object => ({ ...object }))
  }))
})

const snapshotOf = (state: BucketsState): R2EmulatorSeed => ({
  buckets: state.buckets.map(bucket => ({
    name: bucket.name,
    objects: bucket.objects.map(object => ({ ...object }))
  }))
})

const bucketOf = (state: BucketsState, request: JsonObject): BucketState | undefined => {
  const name = stringField(request, 'bucket')

  return state.buckets.find(bucket => bucket.name === name)
}

const objectIn = (bucket: BucketState, request: JsonObject): ObjectState | undefined => {
  const key = stringField(request, 'key')

  return bucket.objects.find(object => object.key === key)
}

const byteLength = (bodyBase64: string | undefined): number | undefined =>
  bodyBase64 === undefined ? undefined : base64Bytes(bodyBase64)?.byteLength

/** A state model for one route: whether a fixture is consistent, and what it changes. */
type RouteModel = {
  readonly consistent: (
    state: BucketsState,
    request: JsonObject,
    fixture: R2EmulatorFixture
  ) => boolean
  readonly apply: (state: BucketsState, request: JsonObject, fixture: R2EmulatorFixture) => void
}

/** Presigning is local signing: every matching fixture is consistent, and nothing changes. */
const presignModel: RouteModel = {
  consistent: () => true,
  apply: () => undefined
}

const getModel: RouteModel = {
  consistent: (state, request, fixture) => {
    const bucket = bucketOf(state, request)

    if (bucket === undefined) return false

    const object = objectIn(bucket, request)
    const expected = stringField(request, 'expectedEtag')
    const maxBytes = numberField(request, 'maxBytes')
    const size = byteLength(object?.bodyBase64)
    const etagHolds = object !== undefined && (expected === undefined || expected === object.etag)

    if (fixture.failure !== undefined) {
      switch (fixture.failure.code) {
        case 'not_found':
          return object === undefined
        case 'conflict':
          return object !== undefined && expected !== undefined && expected !== object.etag
        case 'response_too_large':
          return etagHolds && size !== undefined && maxBytes !== undefined && size > maxBytes
        default:
          // No other get failure is recorded with a state it follows from.
          return false
      }
    }

    return (
      object !== undefined &&
      etagHolds &&
      size !== undefined &&
      maxBytes !== undefined &&
      size <= maxBytes &&
      Equal.equals(fixture.response, {
        etag: object.etag,
        size,
        bodyBase64: object.bodyBase64
      })
    )
  },
  apply: () => undefined
}

const putModel: RouteModel = {
  consistent: (state, request, fixture) => {
    const bucket = bucketOf(state, request)

    if (bucket === undefined) return false

    const object = objectIn(bucket, request)
    const condition = objectField(request, 'condition')
    const kind = stringField(condition, 'kind')
    const conditionEtag = stringField(condition, 'etag')

    if (fixture.failure !== undefined) {
      if (fixture.failure.code !== 'conflict') return false

      return kind === 'absent'
        ? object !== undefined
        : kind === 'etag' && object !== undefined && object.etag !== conditionEtag
    }

    const size = byteLength(stringField(request, 'bodyBase64'))
    const maxUploadBytes = numberField(request, 'maxUploadBytes')
    const etag = stringField(fixture.response, 'etag')

    const conditionHolds =
      kind === 'absent'
        ? object === undefined
        : kind === 'etag' &&
          object !== undefined &&
          object.etag === conditionEtag &&
          etag !== object.etag

    return (
      conditionHolds &&
      etag !== undefined &&
      size !== undefined &&
      maxUploadBytes !== undefined &&
      size <= maxUploadBytes &&
      numberField(fixture.response, 'size') === size
    )
  },
  apply: (state, request, fixture) => {
    const bucket = bucketOf(state, request)
    const key = stringField(request, 'key')
    const bodyBase64 = stringField(request, 'bodyBase64')
    const etag = stringField(fixture.response, 'etag')

    if (
      fixture.failure !== undefined ||
      bucket === undefined ||
      key === undefined ||
      bodyBase64 === undefined ||
      etag === undefined
    ) {
      return
    }

    const object = objectIn(bucket, request)

    if (object === undefined) {
      bucket.objects.push({ key, etag, bodyBase64 })
    } else {
      object.etag = etag
      object.bodyBase64 = bodyBase64
    }
  }
}

const routePath = (port: string, method: string) => `${port}.${method}`

const routeModels: ReadonlyMap<string, RouteModel> = new Map([
  [
    emulatorRouteKey(r2EmulatorRouteMethod, routePath(r2EmulatorPresignerPort, 'presignPutObject')),
    presignModel
  ],
  [emulatorRouteKey(r2EmulatorRouteMethod, routePath(r2EmulatorObjectClientPort, 'get')), getModel],
  [emulatorRouteKey(r2EmulatorRouteMethod, routePath(r2EmulatorObjectClientPort, 'put')), putModel]
])

const strict = { onExcessProperty: 'error' } as const

const decodeSeed = Schema.decodeUnknownResult(R2EmulatorSeed, strict)

const decodeFault = Schema.decodeUnknownResult(R2EmulatorFault, strict)

const issueText = (error: Schema.SchemaError): string => error.message

/** Bucket names, and object keys within a bucket, must be unique so fixtures address one object. */
const seedProblem = (seed: R2EmulatorSeed): string | undefined => {
  const names = seed.buckets.map(bucket => bucket.name)

  if (new Set(names).size !== names.length) {
    return 'bucket names must be unique'
  }

  for (const bucket of seed.buckets) {
    const keys = bucket.objects.map(object => object.key)

    if (new Set(keys).size !== keys.length) {
      return `object keys in ${bucket.name} must be unique`
    }
  }

  return undefined
}

/**
 * Create an R2 emulator. Each call has its own buckets, ledger, faults, and fixture use.
 *
 * `call(port, method, request)` answers in this order: a port and method outside the manifest
 * (`unknown-method`), a non-object request or one with an own `__proto__` key (`invalid-request`),
 * a `bodyBase64` that is not canonical base64 of UTF-8 text (`uncheckable-body`), or a credential
 * outside the credential fields (`credential-in-request`) fails closed; otherwise the fixtures
 * whose port, method, and credential-free request match are checked against the buckets, and the
 * first consistent one (preferring one not used since the last reset) is chosen; no match
 * (`no-matching-fixture`) or no consistent match (`state-conflict`) fails closed. Only then does
 * the first active matching fault answer its failure (changing nothing); otherwise the chosen
 * fixture answers and updates the buckets. Every refusal is ledgered with constant text only; a
 * request the checks cannot walk is refused as `uncheckable-request`, so `call` never throws.
 *
 * Throws `R2EmulatorInputInvalid` for an invalid seed.
 */
export const makeR2Emulator = (options: R2EmulatorOptions = {}): R2Emulator => {
  const seedResult = decodeSeed(options.seed ?? r2EmulatorDefaultSeed)

  if (Result.isFailure(seedResult)) {
    throw new R2EmulatorInputInvalid({ input: 'seed', reason: issueText(seedResult.failure) })
  }

  const seed = seedResult.success
  const problem = seedProblem(seed)

  if (problem !== undefined) {
    throw new R2EmulatorInputInvalid({ input: 'seed', reason: problem })
  }

  const bound = new Map(
    bindRouteHandlers(r2EmulatorRoutes, routeModels).map(({ route, handler }) => [
      route.path,
      { route, model: handler }
    ])
  )

  let state = bucketsFrom(seed)
  let entries: Array<R2EmulatorLedgerEntry> = []

  let faults: Array<{
    id: number
    fault: R2EmulatorFault
    remaining: number | undefined
    applied: number
  }> = []

  let nextFaultId = 1
  let nextSeq = 1
  const used = new Set<string>()

  const record = (entry: Omit<R2EmulatorLedgerEntry, 'seq'>) => {
    entries.push({ seq: nextSeq, ...entry })
    nextSeq += 1
  }

  const refuse = (
    entry: Pick<R2EmulatorLedgerEntry, 'port' | 'method' | 'request' | 'evidence'>,
    reason: R2EmulatorNotEmulatedReason
  ): R2EmulatorReply => {
    record({ ...entry, outcome: 'not-emulated', reason })

    return { notEmulated: { reason: notEmulatedText[reason] } }
  }

  const answer = (port: string, method: string, rawRequest: Schema.Json): R2EmulatorReply => {
    const target = bound.get(routePath(port, method))

    if (target === undefined) {
      // Nothing from an unrecognised call is recorded: its port, method, or request may hold
      // anything.
      return refuse(
        {
          port: r2EmulatorUnrecognised,
          method: r2EmulatorUnrecognised,
          request: r2EmulatorRedacted,
          evidence: 'unknown-method'
        },
        'unknown-method'
      )
    }

    const evidence = target.route.evidence

    // Every refusal below records constant text only: no request text reaches the ledger unless
    // the request equals a fixture request (minus credential fields).
    const constant = { port, method, request: r2EmulatorRedacted, evidence }

    if (!isJsonObject(rawRequest) || hasOwnProtoKey(rawRequest)) {
      return refuse(constant, 'invalid-request')
    }

    const request = withoutCredentials(rawRequest)

    // Bytes are checked as the text they decode to; anything else cannot be checked.
    const bodies = bodyValues(request).map(bodyText)
    const decodedBodies = bodies.flatMap(body => (body === undefined ? [] : [body]))

    if (decodedBodies.length !== bodies.length) {
      return refuse(constant, 'uncheckable-body')
    }

    const guarded = guardedValues(rawRequest)

    if (
      [...textsOf(request), ...decodedBodies].some(text => textCarriesCredential(text, guarded))
    ) {
      return refuse(constant, 'credential-in-request')
    }

    const matching = r2EmulatorFixtures.filter(
      fixture =>
        fixture.port === port &&
        fixture.method === method &&
        isJsonObject(fixture.request) &&
        Equal.equals(withoutCredentials(fixture.request), request)
    )

    if (matching.length === 0) {
      return refuse(constant, 'no-matching-fixture')
    }

    const consistent = matching.filter(fixture => target.model.consistent(state, request, fixture))
    const chosen = consistent.find(fixture => !used.has(fixture.id)) ?? consistent[0]

    if (chosen === undefined) {
      return refuse(constant, 'state-conflict')
    }

    // From here on the request equals a fixture request: what is recorded is fixture text, with
    // the body only as its decoded length.
    const bodyBytes = byteLength(stringField(request, bodyField))
    const ledgerRequest = withoutBodies(request)

    const recorded = (entry: Pick<R2EmulatorLedgerEntry, 'outcome' | 'fixtureId' | 'faultId'>) => {
      const base = { port, method, request: ledgerRequest, evidence, ...entry }

      record(bodyBytes === undefined ? base : { ...base, bodyBytes })
    }

    // Faults apply only to a call a fixture would answer: a refused call above leaves every fault
    // untouched. A fault changes no bucket state.
    const fault = faults.find(
      candidate =>
        candidate.fault.port === port &&
        candidate.fault.method === method &&
        (candidate.remaining === undefined || candidate.remaining > 0) &&
        (candidate.fault.match === undefined || containsSubset(request, candidate.fault.match))
    )

    if (fault !== undefined) {
      fault.applied += 1

      if (fault.remaining !== undefined) {
        fault.remaining -= 1
      }

      recorded({ outcome: 'fault', faultId: fault.id })

      return { failure: fault.fault.failure }
    }

    target.model.apply(state, request, chosen)
    used.add(chosen.id)
    recorded({ outcome: 'answered', fixtureId: chosen.id })

    return chosen.failure === undefined
      ? { response: chosen.response }
      : { failure: chosen.failure }
  }

  /**
   * `answer`, never throwing: a request the checks cannot walk (a cyclic or too deeply nested
   * value) is ledgered with constant text and answered not-emulated. Every check runs before any
   * fault is used or any state changes, so a throw leaves both untouched.
   */
  const call = (port: string, method: string, rawRequest: Schema.Json): R2EmulatorReply => {
    try {
      return answer(port, method, rawRequest)
    } catch {
      return refuse(
        {
          port: r2EmulatorUnrecognised,
          method: r2EmulatorUnrecognised,
          request: r2EmulatorRedacted,
          evidence: 'unknown-method'
        },
        'uncheckable-request'
      )
    }
  }

  const faultState = (fault: (typeof faults)[number]): R2EmulatorFaultState => ({
    id: fault.id,
    fault: fault.fault,
    remaining: fault.remaining,
    applied: fault.applied
  })

  return {
    call,
    state: () => snapshotOf(state),
    seed: () => snapshotOf(bucketsFrom(seed)),
    ledger: {
      entries: () => entries.map(entry => ({ ...entry })),
      clear: () => {
        entries = []
      }
    },
    reset: () => {
      state = bucketsFrom(seed)
      entries = []
      faults = []
      used.clear()
    },
    faults: {
      add: input => {
        const decoded = decodeFault(input)

        if (Result.isFailure(decoded)) {
          throw new R2EmulatorInputInvalid({ input: 'fault', reason: issueText(decoded.failure) })
        }

        if (!bound.has(routePath(decoded.success.port, decoded.success.method))) {
          throw new R2EmulatorInputInvalid({
            input: 'fault',
            reason: 'the port and method have no emulated route'
          })
        }

        const added = {
          id: nextFaultId,
          fault: decoded.success,
          remaining: decoded.success.count,
          applied: 0
        }

        nextFaultId += 1
        faults.push(added)

        return faultState(added)
      },
      list: () => faults.map(faultState),
      clear: () => {
        faults = []
      }
    },
    coverage: () => ({
      routes: r2EmulatorRoutes.map(route => ({
        ...route,
        calls: entries.filter(entry => routePath(entry.port, entry.method) === route.path).length
      })),
      notEmulatedCalls: entries.filter(entry => entry.outcome === 'not-emulated').length,
      unusedFixtureIds: r2EmulatorFixtures.flatMap(fixture =>
        used.has(fixture.id) ? [] : [fixture.id]
      )
    })
  }
}
