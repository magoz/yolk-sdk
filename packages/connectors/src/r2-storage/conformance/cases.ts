/**
 * Cloudflare R2 conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * The R2 connector never talks to R2 itself: `r2_storage.upload_url` asks the host `R2Presigner`
 * port for a presigned PUT URL, and the host-only `getR2Object` / `createR2Object` /
 * `updateR2Object` go through the host `R2ObjectClient` port. Each case runs that REAL connector
 * code over those ports plus the connector `CredentialResolver` and the host-supplied
 * `R2ConformanceConfig` seeds, and checks one port claim the connector relies on (the port contract
 * in `R2ObjectClientApi`, or what a presigned PUT URL must carry). Port calls are observed by
 * wrapping the ports the host provides. The same cases run against replayed `PortFixture`s (through
 * `makeR2ReplayBackend` and `r2PortsLayerFromBackend`), any structural backend, or, by hand, a host
 * implementation of both ports connected to a practice bucket. None is observed live yet (`observed`
 * absent = unverified); sub-claims no live run has settled are marked "(unverified: ...)" in their
 * `wire`.
 *
 * Irreversible writes. The connector has NO delete for R2 objects, so an object a case writes
 * cannot be removed through it: both write cases are `write-irreversible` and run only when a
 * person names their exact id. They write only keys under `yolk-conformance/<runId>/` (the `runId`
 * seed is a per-invocation `run-<hex>`; fixtures replay with `run-synthetic`), never a seeded key.
 * Each put, the decoding of its answer, and its classification run uninterruptibly together.
 * Port failures carry no HTTP status (the connector keeps only the code), so a put is classified
 * through `classifyWriteExit` as follows: a failure before the port was called (the connector
 * refused the input) and a port `conflict` (the condition failed: HTTP 412, or a binding `null`)
 * are definitive, nothing was written; any other port failure is ambiguous: the object may have been
 * written anyway, and the case fails with `R2ConformanceActionFailed` (`writeOutcome: 'unknown'`)
 * naming the exact bucket and key to check by hand, also through the `ConformanceCleanupReporter`
 * when the case is being interrupted. There is nothing to clean up and no leftover lookup
 * (`R2ObjectClient` cannot list keys): look under `yolk-conformance/` in the practice bucket.
 */
import { Cause, Context, Data, Effect, Exit, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { classifyWriteExit, failReporting } from '../../conformance/cleanup-reporter.ts'
import { makeCredentialBinding, type CredentialResolver } from '../../credential.ts'
import type { ConnectorError } from '../../error.ts'
import {
  ConnectorFileTransferError,
  type ConnectorFileTransferBudget
} from '../../file-transfer.ts'
import { makeIntegration, type ConnectorIntegration } from '../../integration.ts'
import { ActionResult } from '../../result.ts'
import {
  R2ObjectClient,
  createR2Object,
  getR2Object,
  updateR2Object,
  type R2ObjectClientApi,
  type R2ObjectMetadata
} from '../files.ts'
import {
  R2Presigner,
  R2UploadUrlInput,
  r2AccessKeyIdSlotId,
  r2SecretAccessKeySlotId,
  r2StorageConnectorId,
  r2StorageUploadUrlAction
} from '../index.ts'
import { r2CreateIfAbsentFixtures } from './create-if-absent.ts'
import { r2GetExpectedEtagFixtures } from './get-expected-etag.ts'
import { r2GetMaxBytesFixtures } from './get-max-bytes.ts'
import { r2GetMissingFixtures } from './get-missing.ts'
import { r2PresignUploadUrlFixtures } from './presign-upload-url.ts'
import { r2UpdateIfMatchFixtures } from './update-if-match.ts'

/** An https endpoint origin (no path, query, or credentials). */
const Endpoint = Schema.String.check(
  Schema.isPattern(/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u)
)

/** An R2 bucket name, as `getR2Object` accepts it. */
const Bucket = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u))

/** An object key whose segments never start with a dot (no `.`/`..` segments). */
const ObjectKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u),
  Schema.isMaxLength(200)
)

/**
 * A run id: `run-` then lower-case letters, digits, and inner hyphens, at most 40 characters, the
 * same shape as the other connector conformance run ids.
 */
const RunId = Schema.String.check(
  Schema.isPattern(/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(40)
)

/**
 * Host-supplied seeds for the practice bucket. Cases never hard-code account data. A case whose
 * required seed is missing fails with a `precondition:` `ConformanceMismatch` before any port call.
 */
export const R2ConformanceSeeds = Schema.Struct({
  /** The S3-compatible endpoint origin (integration config `endpoint`). */
  endpoint: Schema.optionalKey(Endpoint),
  /** The practice bucket (integration config `bucket`). */
  bucket: Schema.optionalKey(Bucket),
  /** An existing object of 2 bytes to 1 MB in the bucket, read by the get cases. */
  objectKey: Schema.optionalKey(ObjectKey),
  /**
   * Invocation-unique segment of every key a case presigns, reads as absent, or writes
   * (`yolk-conformance/<runId>/...`). Replay uses the fixed synthetic id of the fixtures. No R2
   * runner ships, so a host running the cases live must generate a fresh `run-<hex>` for every
   * invocation (never from a flag, never reused): a reused id makes the absent-only create answer
   * `conflict`, so the write cases fail without writing.
   */
  runId: Schema.optionalKey(RunId)
})

export type R2ConformanceSeeds = typeof R2ConformanceSeeds.Type

export type R2ConformanceSeedKey = keyof R2ConformanceSeeds

/** Host-supplied seeds for the R2 conformance cases. */
export class R2ConformanceConfig extends Context.Service<R2ConformanceConfig, R2ConformanceSeeds>()(
  '@yolk-sdk/connectors/r2-storage/conformance/R2ConformanceConfig'
) {}

/**
 * Credential references the cases bind to the `r2-storage.access_key_id` and
 * `r2-storage.secret_access_key` slots. A host `CredentialResolver` resolves them to the practice
 * bucket's R2 API token pair.
 */
export const r2ConformanceCredentialRefs = {
  accessKeyId: 'r2-storage.conformance.access_key_id',
  secretAccessKey: 'r2-storage.conformance.secret_access_key'
} as const

/** Synthetic `publicUrl` config the presign case sets (the connector only joins it with the key). */
export const r2ConformancePublicUrl = 'https://files.example.test'

/** The integration an R2 conformance case invokes the connector with. */
export const r2ConformanceIntegration = (endpoint: string, bucket: string): ConnectorIntegration =>
  makeIntegration({
    connectorId: r2StorageConnectorId,
    config: { endpoint, bucket, publicUrl: r2ConformancePublicUrl },
    credentialBindings: [
      makeCredentialBinding({
        slotId: r2AccessKeyIdSlotId,
        credentialRef: r2ConformanceCredentialRefs.accessKeyId
      }),
      makeCredentialBinding({
        slotId: r2SecretAccessKeySlotId,
        credentialRef: r2ConformanceCredentialRefs.secretAccessKey
      })
    ]
  })

/** First segment of every key a case writes: `yolk-conformance/<runId>/...`. */
export const r2ConformanceMarker = 'yolk-conformance'

/**
 * A connector action or helper failed where the case needed success. `code` is the
 * `ConnectorError` cause or the port's `ConnectorFileTransferError` code.
 *
 * `writeOutcome: 'unknown'` marks an ambiguous put (any port failure other than `conflict`): the
 * object may have been written anyway, so the message names the exact bucket and key to check by
 * hand. The connector cannot delete R2 objects.
 */
export class R2ConformanceActionFailed extends Data.TaggedError('R2ConformanceActionFailed')<{
  readonly actionId: string
  readonly code: string
  readonly writeOutcome?: 'unknown'
  readonly target?: string
}> {
  override get message(): string {
    const advice =
      this.writeOutcome === 'unknown'
        ? `; write outcome unknown: ${this.target ?? 'the object'} may have been written; check it by hand (the connector cannot delete it)`
        : ''

    return `${this.actionId} failed: ${this.code}${advice}`
  }
}

export type R2ConformanceError = ConformanceMismatch | ConnectorError | R2ConformanceActionFailed

/** What every R2 conformance case requires from the host. */
export type R2ConformanceRequirements =
  | R2Presigner
  | R2ObjectClient
  | CredentialResolver
  | R2ConformanceConfig

export type R2ConformanceCase = ConformanceCase<R2ConformanceError, R2ConformanceRequirements>

const requireSeed = <K extends R2ConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* R2ConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* new ConformanceMismatch({
        message: `precondition: R2ConformanceConfig.${key} is not configured`
      })
    }

    return value
  })

const bucketIntegration = Effect.gen(function* () {
  const endpoint = yield* requireSeed('endpoint')
  const bucket = yield* requireSeed('bucket')

  return { bucket, integration: r2ConformanceIntegration(endpoint, bucket) }
})

/** A key under the run namespace: `yolk-conformance/<runId>/<name>`. */
const runKey = (name: string) =>
  Effect.map(requireSeed('runId'), runId => `${r2ConformanceMarker}/${runId}/${name}`)

/** Trusted conformance transfer limits (1 MB). */
const budgetOf = (maxBytes: number): ConnectorFileTransferBudget => ({
  maxBytes,
  maxMetadataBytes: 65_536,
  maxErrorBodyBytes: 65_536
})

const oneMegabyte = 1_048_576

/** One observed `R2ObjectClient` call: its request (without integration or bytes) and outcome. */
export type R2ObservedCall = {
  readonly method: 'get' | 'put'
  readonly key: string
  readonly maxBytes?: number
  readonly expectedEtag?: string
  readonly condition?: string
  /** `success`, or the port failure code. */
  readonly outcome: string
}

const conditionText = (condition: Parameters<R2ObjectClientApi['put']>[0]['condition']) =>
  condition.kind === 'absent' ? 'absent' : `etag ${condition.etag}`

/** The port failure code of an exit (`defect` for anything but a transfer error). */
const failureCode = <A>(exit: Exit.Exit<A, ConnectorFileTransferError>): string => {
  if (Exit.isSuccess(exit)) {
    return 'success'
  }

  const error = Cause.findErrorOption(exit.cause)

  return Option.isSome(error) && error.value instanceof ConnectorFileTransferError
    ? error.value.code
    : 'defect'
}

/**
 * The host's `R2ObjectClient`, observed: every call and its outcome are recorded, unchanged, and
 * every put is counted in `started` BEFORE it is delegated, so a host `put` that throws or dies
 * when invoked still counts as a call that reached the port.
 */
const observingObjects = (
  calls: Ref.Ref<ReadonlyArray<R2ObservedCall>>,
  started: Ref.Ref<number>
) =>
  Effect.map(R2ObjectClient, objects =>
    R2ObjectClient.of({
      get: request =>
        objects.get(request).pipe(
          Effect.onExit(exit => {
            const call: R2ObservedCall =
              request.expectedEtag === undefined
                ? {
                    method: 'get',
                    key: request.key,
                    maxBytes: request.maxBytes,
                    outcome: failureCode(exit)
                  }
                : {
                    method: 'get',
                    key: request.key,
                    maxBytes: request.maxBytes,
                    expectedEtag: request.expectedEtag,
                    outcome: failureCode(exit)
                  }

            return Ref.update(calls, list => [...list, call])
          })
        ),
      put: request =>
        Ref.update(started, count => count + 1).pipe(
          Effect.andThen(Effect.suspend(() => objects.put(request))),
          Effect.onExit(exit =>
            Ref.update(calls, (list): ReadonlyArray<R2ObservedCall> => [
              ...list,
              {
                method: 'put',
                key: request.key,
                condition: conditionText(request.condition),
                outcome: failureCode(exit)
              }
            ])
          )
        )
    })
  )

/**
 * Run `effect` over the observed object client; answer its exit, the calls it made, and how many
 * puts reached the port.
 */
const observedObjects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<R2ObservedCall>>([])
    const started = yield* Ref.make(0)
    const objects = yield* observingObjects(calls, started)
    const exit = yield* Effect.exit(effect.pipe(Effect.provideService(R2ObjectClient, objects)))

    return { exit, calls: yield* Ref.get(calls), putsStarted: yield* Ref.get(started) }
  })

const getObject = (
  input: { readonly key: string; readonly expectedEtag?: string },
  maxBytes = oneMegabyte
) =>
  Effect.gen(function* () {
    const { bucket, integration } = yield* bucketIntegration

    return yield* observedObjects(
      getR2Object(integration, { bucket, ...input }, budgetOf(maxBytes))
    )
  })

/** A get that must succeed: its file, and the observed port calls. */
const readObject = (input: { readonly key: string; readonly expectedEtag?: string }) =>
  Effect.gen(function* () {
    const { exit, calls } = yield* getObject(input)

    if (Exit.isFailure(exit)) {
      return yield* new R2ConformanceActionFailed({
        actionId: 'getR2Object',
        code: failureCode(exit)
      })
    }

    return { file: exit.value, calls }
  })

/** True when `left` and `right` hold exactly the same bytes (no text decoding). */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

// Read cases.

/** Longest presigned-URL expiry SigV4 allows, in seconds (7 days). */
const sigV4MaxExpirySeconds = 604_800

/**
 * A presign call as the case observes it. Credentials are never kept: only whether both were
 * passed, and whether the answered URL's `X-Amz-Credential` names the access key id passed.
 */
type ObservedPresign = {
  readonly endpoint: string
  readonly bucket: string
  readonly key: string
  readonly contentType: string
  readonly credentials: boolean
  readonly signedWithPassedKey: boolean
}

const parsedUrl = (text: string): URL | undefined => {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

export const r2PresignUploadUrlCase: R2ConformanceCase = defineConformanceCase({
  id: 'r2.presign.put-upload-url',
  title: 'The presigner answers a SigV4 PUT URL for the bucket and key, within the SigV4 expiry',
  safety: 'read',
  docs: "`r2_storage.upload_url` reads integration config `endpoint`, `bucket`, and optional `publicUrl`, resolves the `r2-storage.access_key_id` and `r2-storage.secret_access_key` credentials, strips leading slashes from `filename` to form the object key, and calls the host `R2Presigner.presignPutObject` once with `{ endpoint, accessKeyId, secretAccessKey, bucket, key, contentType }`; it returns the port's `uploadUrl` unchanged, the `key`, and `publicUrl` joined with the key. It reads nothing inside the URL, and the port takes no expiry: the host chooses it.",
  wire: "For `filename` `/yolk-conformance/<runId>/presign.txt` and `contentType` `text/plain`, the connector calls `presignPutObject` once with the configured endpoint and bucket, the key without its leading slash, `text/plain`, and both credentials (observed at the `R2Presigner` port: the port has only this PUT method, and a query-signed URL does not name its HTTP method, which only a PUT through it would prove). The host answers an `https` `uploadUrl` for that bucket and key on the endpoint's host (path-style `/<bucket>/<key>`, or the bucket as a subdomain; unverified: which style an R2 host signs) carrying `X-Amz-Algorithm=AWS4-HMAC-SHA256`, an `X-Amz-Credential` that starts with the access key id the connector passed (so a host signing with its own or another tenant's keys fails; the case keeps no credential, only that comparison), `X-Amz-Signature`, and `X-Amz-Expires` from 1 to 604800 seconds (the SigV4 maximum), with `X-Amz-SignedHeaders` listing `host` and `content-type` (unverified: that the host signs the content type, so an upload with another type is refused). The connector returns that URL unchanged with the key and `publicUrl` joined with it. Presigning is local signing: nothing is sent to R2.",
  fixtures: r2PresignUploadUrlFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const endpoint = yield* requireSeed('endpoint')
    const { bucket, integration } = yield* bucketIntegration
    const key = yield* runKey('presign.txt')
    const presigner = yield* R2Presigner
    const calls = yield* Ref.make<ReadonlyArray<ObservedPresign>>([])
    const answers = yield* Ref.make<ReadonlyArray<string>>([])

    // The host's own presigner, observed. No credential is kept: after the host answers, only
    // whether its URL's `X-Amz-Credential` names the access key id the connector passed.
    const observing = R2Presigner.of({
      presignPutObject: input =>
        presigner.presignPutObject(input).pipe(
          Effect.tap(output =>
            Ref.update(calls, list => [
              ...list,
              {
                endpoint: input.endpoint,
                bucket: input.bucket,
                key: input.key,
                contentType: input.contentType,
                credentials: input.accessKeyId.length > 0 && input.secretAccessKey.length > 0,
                signedWithPassedKey: (
                  parsedUrl(output.uploadUrl)?.searchParams.get('X-Amz-Credential') ?? ''
                ).startsWith(`${input.accessKeyId}/`)
              }
            ])
          ),
          Effect.tap(output => Ref.update(answers, list => [...list, output.uploadUrl]))
        )
    })

    const result = yield* r2StorageUploadUrlAction
      .executeTyped({
        integration,
        input: R2UploadUrlInput.make({ filename: `/${key}`, contentType: 'text/plain' })
      })
      .pipe(Effect.provideService(R2Presigner, observing))

    if (!Predicate.isTagged(result, 'Success')) {
      return yield* new R2ConformanceActionFailed({
        actionId: r2StorageUploadUrlAction.id,
        code: result.error.code
      })
    }

    const [call, ...more] = yield* Ref.get(calls)

    yield* expectEqual(
      call === undefined || more.length > 0
        ? null
        : [call.endpoint, call.bucket, call.key, call.contentType, call.credentials],
      [endpoint, bucket, key, 'text/plain', true],
      'expected one presignPutObject call with the configured endpoint and bucket, the key without its leading slash, the content type, and both credentials'
    )
    yield* expectConformance(
      call?.signedWithPassedKey === true,
      'expected the uploadUrl X-Amz-Credential to name the access key id the connector passed'
    )

    const [answer] = yield* Ref.get(answers)

    yield* expectEqual(
      [result.value.uploadUrl === answer, result.value.key, result.value.publicUrl ?? null],
      [true, key, `${r2ConformancePublicUrl}/${key}`],
      'expected upload_url to return the port uploadUrl unchanged, the key, and publicUrl joined with it'
    )

    const url = parsedUrl(result.value.uploadUrl)
    const endpointHost = new URL(endpoint).host

    yield* expectConformance(
      url !== undefined &&
        url.protocol === 'https:' &&
        ((url.host === endpointHost && url.pathname === `/${bucket}/${key}`) ||
          (url.host === `${bucket}.${endpointHost}` && url.pathname === `/${key}`)),
      "expected uploadUrl to address the bucket and key over https on the endpoint's host"
    )

    const param = (name: string) => url?.searchParams.get(name) ?? ''

    yield* expectConformance(
      param('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
        param('X-Amz-Credential').length > 0 &&
        param('X-Amz-Signature').length > 0,
      'expected uploadUrl to carry X-Amz-Algorithm AWS4-HMAC-SHA256, X-Amz-Credential, and X-Amz-Signature'
    )

    const expires = Number(param('X-Amz-Expires'))

    yield* expectConformance(
      /^[0-9]+$/.test(param('X-Amz-Expires')) && expires >= 1 && expires <= sigV4MaxExpirySeconds,
      'expected X-Amz-Expires from 1 to 604800 seconds'
    )

    const signed = param('X-Amz-SignedHeaders').split(';')

    yield* expectConformance(
      signed.includes('host') && signed.includes('content-type'),
      'expected X-Amz-SignedHeaders to list host and content-type'
    )
  })
})

/** The seeded object's `get` calls: `[maxBytes, outcome]` per call. */
const budgetCalls = (calls: ReadonlyArray<R2ObservedCall>) =>
  calls.map(call => [call.maxBytes ?? null, call.outcome])

export const r2GetMaxBytesCase: R2ConformanceCase = defineConformanceCase({
  id: 'r2.objects.get-max-bytes',
  title: 'A get over its byte budget fails at the port instead of answering the bytes',
  safety: 'read',
  docs: '`getR2Object` validates the budget, bucket, key, and optional `expectedEtag`, then calls the host `R2ObjectClient.get` once with `{ bucket, key, maxBytes }` (`maxBytes` from the trusted budget); the port contract makes the host enforce the actual streamed bytes. The connector then requires `{ etag, size }`, at most `maxBytes` bytes (else `response_too_large`), and exactly `size` bytes (else `invalid_metadata`).',
  wire: 'For the seeded `objectKey` (an object of 2 bytes to 1 MB), `getR2Object` with a 1 MB budget calls `get` with `maxBytes: 1048576`, and the host answers exactly `size` bytes; with a budget one byte smaller than that size, the connector calls `get` with that `maxBytes` and the host port itself fails `response_too_large` (observed at the `R2ObjectClient` port; unverified: that code, since the port contract only says hosts enforce the actual streamed bytes) instead of answering the bytes, so the connector never buffers an object over its budget.',
  fixtures: r2GetMaxBytesFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const key = yield* requireSeed('objectKey')
    const { file, calls } = yield* readObject({ key })

    yield* expectConformance(
      file.byteLength >= 2,
      'precondition: objectKey must name an object of 2 bytes to 1 MB'
    )
    yield* expectEqual(
      [file.byteLength, budgetCalls(calls)],
      [file.size, [[oneMegabyte, 'success']]],
      'expected one get with maxBytes 1048576 answering exactly size bytes'
    )

    const smaller = file.size - 1
    const over = yield* getObject({ key }, smaller)

    yield* expectEqual(
      budgetCalls(over.calls),
      [[smaller, 'response_too_large']],
      'expected the port get with maxBytes below the object size to fail response_too_large'
    )
  })
})

/** A well-formed etag no object answers (quoted like `like`, synthetic). */
const staleEtagLike = (like: string) =>
  like.startsWith('"') ? `"${'0'.repeat(32)}"` : '0'.repeat(32)

export const r2GetExpectedEtagCase: R2ConformanceCase = defineConformanceCase({
  id: 'r2.objects.get-expected-etag',
  title: 'A get with a stale expectedEtag fails conflict at the port, never an answer',
  safety: 'read',
  docs: '`getR2Object` passes an optional `expectedEtag` to `R2ObjectClient.get` unchanged (quotes preserved) and requires the answered `etag` to equal it (else `invalid_metadata`); the port contract says a failed condition fails `conflict`, never an empty success.',
  wire: 'For the seeded `objectKey`, `getR2Object` with `expectedEtag` set to the etag a plain get answered calls `get` with it and answers exactly the same bytes (length and every byte, never compared as text); with a different, well-formed etag the host port itself fails `conflict` (observed at the `R2ObjectClient` port) rather than answering the object or an empty body, as for HTTP `If-Match` answering 412 or a binding `onlyIf` answering no body.',
  fixtures: r2GetExpectedEtagFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const key = yield* requireSeed('objectKey')
    const plain = yield* readObject({ key })
    const etag = plain.file.etag
    const matching = yield* readObject({ key, expectedEtag: etag })

    yield* expectEqual(
      [
        matching.calls.map(call => [call.expectedEtag ?? null, call.outcome]),
        sameBytes(matching.file.bytes, plain.file.bytes)
      ],
      [[[etag, 'success']], true],
      'expected a get with the current etag to pass it to the port and answer the same bytes'
    )

    const stale = staleEtagLike(etag)

    yield* expectConformance(stale !== etag, 'precondition: objectKey answered the synthetic etag')

    const refused = yield* getObject({ key, expectedEtag: stale })

    yield* expectEqual(
      refused.calls.map(call => [call.expectedEtag ?? null, call.outcome]),
      [[stale, 'conflict']],
      'expected the port get with a stale expectedEtag to fail conflict'
    )
  })
})

export const r2GetMissingCase: R2ConformanceCase = defineConformanceCase({
  id: 'r2.objects.get-missing-not-found',
  title: 'A get of a missing key fails not_found at the port, never an empty success',
  safety: 'read',
  docs: '`getR2Object` passes the port failure code through unchanged; the port contract says a missing object fails `not_found`, not an empty success.',
  wire: '`getR2Object` of a key under the run namespace that nothing wrote (`yolk-conformance/<runId>/absent.txt`) calls `get` once, and the host port fails `not_found` (observed at the `R2ObjectClient` port), so the connector fails `not_found` too.',
  fixtures: r2GetMissingFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const key = yield* runKey('absent.txt')
    const { exit, calls } = yield* getObject({ key })

    yield* expectEqual(
      [calls.map(call => call.outcome), failureCode(exit)],
      [['not_found'], 'not_found'],
      'expected the port get of a missing key to fail not_found'
    )
  })
})

// Irreversible write cases.

/**
 * A put's exit as the connector action result `classifyWriteExit` reads. Port failures carry no
 * HTTP status (the connector keeps only the code), so this supplies the status each outcome
 * stands for:
 *
 * - no put reached the port: the connector refused the input, nothing was written (400);
 * - the port answered `conflict`: the condition failed, nothing was written (412);
 * - any other port failure: no status, so it stays ambiguous (the object may have been written).
 */
const portPutAsResult = (
  exit: Exit.Exit<R2ObjectMetadata, ConnectorFileTransferError>,
  portCalled: boolean
): ActionResult<R2ObjectMetadata> => {
  if (Exit.isSuccess(exit)) {
    return ActionResult.success(exit.value)
  }

  const code = failureCode(exit)

  if (!portCalled) {
    return ActionResult.failure({ code, message: 'refused before the port', status: 400 })
  }

  if (code === 'conflict') {
    return ActionResult.failure({ code, message: 'condition failed', status: 412 })
  }

  return ActionResult.failure({ code, message: 'port failure' })
}

/** The put classification (see `portPutAsResult`) and its failure, when not a success. */
const classifyPut = (
  actionId: string,
  target: string,
  exit: Exit.Exit<R2ObjectMetadata, ConnectorFileTransferError>,
  portCalled: boolean
) => {
  const asAction: Exit.Exit<ActionResult<R2ObjectMetadata>, ConnectorError> = Exit.succeed(
    portPutAsResult(exit, portCalled)
  )

  const outcome = classifyWriteExit(asAction)

  switch (outcome.kind) {
    case 'success':
      return { kind: 'success', value: outcome.value } as const
    case 'rejected':
      return {
        kind: 'rejected',
        error: new R2ConformanceActionFailed({ actionId, code: outcome.failure.code })
      } as const
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        error: new R2ConformanceActionFailed({
          actionId,
          code: outcome.failure.code,
          writeOutcome: 'unknown',
          target
        })
      } as const
  }
}

/**
 * One masked put: the helper call, its decoding, and its classification run uninterruptibly.
 * Answers the classified outcome; an ambiguous one is also handed to the
 * `ConformanceCleanupReporter` when the case is being interrupted, then fails.
 */
const maskedPut = (
  actionId: string,
  key: string,
  put: Effect.Effect<R2ObjectMetadata, ConnectorFileTransferError, R2ObjectClient>
) =>
  Effect.gen(function* () {
    const { bucket } = yield* bucketIntegration

    return yield* Effect.uninterruptibleMask(unmask =>
      Effect.gen(function* () {
        const { exit, calls, putsStarted } = yield* observedObjects(put)

        const classified = classifyPut(
          actionId,
          `object ${key} in bucket ${bucket}`,
          exit,
          putsStarted > 0
        )

        if (classified.kind === 'ambiguous') {
          return yield* failReporting(unmask, classified.error)
        }

        return { classified, calls }
      })
    )
  })

type MaskedPut = {
  readonly classified: ReturnType<typeof classifyPut>
  readonly calls: ReadonlyArray<R2ObservedCall>
}

/** A put that must succeed. */
const expectWritten = (
  outcome: MaskedPut
): Effect.Effect<R2ObjectMetadata, R2ConformanceActionFailed> =>
  outcome.classified.kind === 'success'
    ? Effect.succeed(outcome.classified.value)
    : Effect.fail(outcome.classified.error)

const encoded = (text: string) => new TextEncoder().encode(text)

const createCaseId = 'r2.objects.create-if-absent'

export const r2CreateIfAbsentCase: R2ConformanceCase = defineConformanceCase({
  id: createCaseId,
  title: 'A create is absent-only: a second create of the same key fails conflict',
  safety: 'write-irreversible',
  docs: '`createR2Object` validates the bytes against the budget and the 100,000,000-byte single-PUT cap, then calls the host `R2ObjectClient.put` once with `condition: { kind: "absent" }` (the port contract: an atomic `If-None-Match: *`, never HEAD-then-PUT), and requires `{ etag, size }` with `size` equal to the bytes sent. The connector has no delete for R2 objects.',
  wire: 'For a fresh key `yolk-conformance/<runId>/create-if-absent.txt`, `createR2Object` calls `put` with `condition: absent` and the host answers `{ etag, size }` for the bytes; a second `createR2Object` of the same key with other bytes fails at the host port with `conflict` (observed at the `R2ObjectClient` port) instead of overwriting, and `getR2Object` with the first etag answers the first bytes. The object stays in the bucket (the connector cannot delete it): this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: r2CreateIfAbsentFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const { bucket, integration } = yield* bucketIntegration
    const key = yield* runKey('create-if-absent.txt')
    const runId = yield* requireSeed('runId')
    const first = `${r2ConformanceMarker} ${runId}: first synthetic body, safe to delete`
    const second = `${r2ConformanceMarker} ${runId}: second synthetic body, never stored`

    const created = yield* maskedPut(
      'createR2Object',
      key,
      createR2Object(integration, { bucket, key, bytes: encoded(first) }, budgetOf(oneMegabyte))
    )

    const metadata = yield* expectWritten(created)

    yield* expectEqual(
      [created.calls.map(call => call.condition ?? null), metadata.size],
      [['absent'], encoded(first).byteLength],
      'expected the create to put with condition absent and answer the byte count'
    )

    const again = yield* maskedPut(
      'createR2Object',
      key,
      createR2Object(integration, { bucket, key, bytes: encoded(second) }, budgetOf(oneMegabyte))
    )

    yield* expectEqual(
      again.calls.map(call => [call.condition ?? null, call.outcome]),
      [['absent', 'conflict']],
      'expected a second create of the same key to fail conflict at the port'
    )

    const read = yield* readObject({ key, expectedEtag: metadata.etag })

    yield* expectConformance(
      sameBytes(read.file.bytes, encoded(first)),
      'expected the object to keep the first bytes after the refused second create'
    )
  })
})

const updateCaseId = 'r2.objects.update-if-match'

export const r2UpdateIfMatchCase: R2ConformanceCase = defineConformanceCase({
  id: updateCaseId,
  title: 'An update is If-Match: a stale etag fails conflict, the current one replaces the bytes',
  safety: 'write-irreversible',
  docs: '`updateR2Object` requires `expectedEtag` and calls the host `R2ObjectClient.put` once with `condition: { kind: "etag", etag }` (the port contract: an atomic concrete `If-Match`, never an unconditional fallback), then requires `{ etag, size }` with `size` equal to the bytes sent. The connector has no delete for R2 objects.',
  wire: 'For a fresh key `yolk-conformance/<runId>/update-if-match.txt`, created absent-only: `updateR2Object` with a different, well-formed `expectedEtag` calls `put` with that etag condition and fails at the host port with `conflict` (observed at the `R2ObjectClient` port; nothing written); `updateR2Object` with the created etag answers a new etag (unverified: that R2 answers a different ETag when the content changes, as the MD5 ETag of a single PUT does); and `getR2Object` with the new etag answers the updated bytes. The object stays in the bucket (the connector cannot delete it): this case is write-irreversible and runs only when requested by its exact id.',
  fixtures: r2UpdateIfMatchFixtures.map(fixture => fixture.id),
  run: Effect.gen(function* () {
    const { bucket, integration } = yield* bucketIntegration
    const key = yield* runKey('update-if-match.txt')
    const runId = yield* requireSeed('runId')
    const original = `${r2ConformanceMarker} ${runId}: original synthetic body, safe to delete`
    const replacement = `${r2ConformanceMarker} ${runId}: replacement synthetic body, safe to delete`

    const created = yield* maskedPut(
      'createR2Object',
      key,
      createR2Object(integration, { bucket, key, bytes: encoded(original) }, budgetOf(oneMegabyte))
    ).pipe(Effect.flatMap(expectWritten))

    const stale = staleEtagLike(created.etag)

    yield* expectConformance(
      stale !== created.etag,
      'precondition: the create answered the synthetic etag'
    )

    const refused = yield* maskedPut(
      'updateR2Object',
      key,
      updateR2Object(
        integration,
        { bucket, key, bytes: encoded(replacement), expectedEtag: stale },
        budgetOf(oneMegabyte)
      )
    )

    yield* expectEqual(
      refused.calls.map(call => [call.condition ?? null, call.outcome]),
      [[`etag ${stale}`, 'conflict']],
      'expected an update with a stale etag to fail conflict at the port'
    )

    const updated = yield* maskedPut(
      'updateR2Object',
      key,
      updateR2Object(
        integration,
        { bucket, key, bytes: encoded(replacement), expectedEtag: created.etag },
        budgetOf(oneMegabyte)
      )
    ).pipe(Effect.flatMap(expectWritten))

    yield* expectConformance(
      updated.etag !== created.etag,
      'expected an update with the current etag to answer a new etag'
    )

    const read = yield* readObject({ key, expectedEtag: updated.etag })

    yield* expectConformance(
      sameBytes(read.file.bytes, encoded(replacement)),
      'expected a get with the new etag to answer the updated bytes'
    )
  })
})

/** Every R2 conformance case, in fixture order. */
export const r2ConformanceCases: ReadonlyArray<R2ConformanceCase> = [
  r2PresignUploadUrlCase,
  r2GetMaxBytesCase,
  r2GetExpectedEtagCase,
  r2GetMissingCase,
  r2CreateIfAbsentCase,
  r2UpdateIfMatchCase
]
