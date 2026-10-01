/**
 * The R2 conformance fixtures, copied as data (internal; re-exported by `r2.ts`).
 *
 * Emulators never import SDK code: this is a verbatim copy of `r2ConformanceFixtures` from
 * `@yolk-sdk/connectors/r2-storage/conformance` (synthetic `PortFixture`s; none observed live).
 * The presigned URL carries only the canonical synthetic SigV4 placeholders
 * (`syntheticPortCredentialParams` of `@yolk-sdk/conformance`). `test/r2-conformance.test.ts`
 * fails when the two drift apart; update both together.
 */
import type * as Schema from 'effect/Schema'

/** A port failure as a fixture records it (mirrors `PortFailure` in `@yolk-sdk/conformance`). */
export type R2EmulatorFailure = {
  readonly kind: 'expected' | 'error'
  readonly code: string
  readonly message: string
  readonly status?: number
}

type R2EmulatorFixtureFields = {
  readonly id: string
  readonly port: string
  readonly method: string
  readonly request: Schema.Json
  readonly observed?: { readonly account: string; readonly date: string }
  readonly note?: string
}

/**
 * One recorded `R2Presigner` or `R2ObjectClient` call (the plain-JSON shape of a `PortFixture`):
 * exactly one of `response` or `failure`.
 */
export type R2EmulatorFixture =
  | (R2EmulatorFixtureFields & { readonly response: Schema.Json; readonly failure?: never })
  | (R2EmulatorFixtureFields & {
      readonly failure: R2EmulatorFailure
      readonly response?: never
    })

export const r2EmulatorFixtures: ReadonlyArray<R2EmulatorFixture> = [
  {
    id: 'r2.presign.put-upload-url.presign.synthetic',
    port: 'R2Presigner',
    method: 'presignPutObject',
    request: {
      endpoint: 'https://synthetic-account.r2.example.test',
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/presign.txt',
      contentType: 'text/plain'
    },
    response: {
      uploadUrl:
        'https://synthetic-account.r2.example.test/yolk-synthetic-bucket/yolk-conformance/run-synthetic/presign.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=yolk-synthetic-access-key-id%2F20260930%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260930T120000Z&X-Amz-Expires=900&X-Amz-Signature=yolk-synthetic-signature&X-Amz-SignedHeaders=content-type%3Bhost&x-id=PutObject'
    },
    note: 'Local SigV4 query signing (15-minute expiry, content-type signed); nothing sent to R2. Synthetic.'
  },
  {
    id: 'r2.objects.get-max-bytes.within-budget.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'fixtures/synthetic-object.txt',
      maxBytes: 1048576
    },
    response: {
      etag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
      size: 44,
      bodyBase64: 'U3ludGhldGljIGNvbmZvcm1hbmNlIG9iamVjdDogc2FmZSB0byByZWFkLgo='
    },
    note: 'The seeded object within the budget. Synthetic.'
  },
  {
    id: 'r2.objects.get-max-bytes.over-budget.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'fixtures/synthetic-object.txt',
      maxBytes: 43
    },
    failure: {
      kind: 'error',
      code: 'response_too_large',
      message: 'The object is larger than maxBytes; no bytes were returned.'
    },
    note: 'The host stops at maxBytes (Content-Length or streamed count). Synthetic.'
  },
  {
    id: 'r2.objects.get-expected-etag.plain.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'fixtures/synthetic-object.txt',
      maxBytes: 1048576
    },
    response: {
      etag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
      size: 44,
      bodyBase64: 'U3ludGhldGljIGNvbmZvcm1hbmNlIG9iamVjdDogc2FmZSB0byByZWFkLgo='
    },
    note: 'A plain read that learns the etag. Synthetic.'
  },
  {
    id: 'r2.objects.get-expected-etag.current.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'fixtures/synthetic-object.txt',
      expectedEtag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
      maxBytes: 1048576
    },
    response: {
      etag: '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"',
      size: 44,
      bodyBase64: 'U3ludGhldGljIGNvbmZvcm1hbmNlIG9iamVjdDogc2FmZSB0byByZWFkLgo='
    },
    note: 'If-Match with the current etag. Synthetic.'
  },
  {
    id: 'r2.objects.get-expected-etag.stale.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'fixtures/synthetic-object.txt',
      expectedEtag: '"00000000000000000000000000000000"',
      maxBytes: 1048576
    },
    failure: {
      kind: 'error',
      code: 'conflict',
      message: 'Precondition failed (If-Match).'
    },
    note: 'If-Match with a stale etag: HTTP 412 or a binding onlyIf without body. Synthetic.'
  },
  {
    id: 'r2.objects.get-missing-not-found.get.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/absent.txt',
      maxBytes: 1048576
    },
    failure: {
      kind: 'error',
      code: 'not_found',
      message: 'No object with that key.'
    },
    note: 'HTTP 404 NoSuchKey, or a binding get answering null. Synthetic.'
  },
  {
    id: 'r2.objects.create-if-absent.create.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/create-if-absent.txt',
      condition: {
        kind: 'absent'
      },
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiBmaXJzdCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU=',
      maxUploadBytes: 1048576
    },
    response: {
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee01"',
      size: 68
    },
    note: 'PUT with If-None-Match: * on a fresh key. Synthetic.'
  },
  {
    id: 'r2.objects.create-if-absent.create-again.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/create-if-absent.txt',
      condition: {
        kind: 'absent'
      },
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiBzZWNvbmQgc3ludGhldGljIGJvZHksIG5ldmVyIHN0b3JlZA==',
      maxUploadBytes: 1048576
    },
    failure: {
      kind: 'error',
      code: 'conflict',
      message: 'Precondition failed (If-None-Match).'
    },
    note: 'The same key again: HTTP 412, or a binding put answering null. Synthetic.'
  },
  {
    id: 'r2.objects.create-if-absent.read.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/create-if-absent.txt',
      expectedEtag: '"c0ffee00c0ffee00c0ffee00c0ffee01"',
      maxBytes: 1048576
    },
    response: {
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee01"',
      size: 68,
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiBmaXJzdCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU='
    },
    note: 'The first bytes, unchanged. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.create.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/update-if-match.txt',
      condition: {
        kind: 'absent'
      },
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiBvcmlnaW5hbCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU=',
      maxUploadBytes: 1048576
    },
    response: {
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee02"',
      size: 71
    },
    note: 'PUT with If-None-Match: * on a fresh key. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.stale.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/update-if-match.txt',
      condition: {
        kind: 'etag',
        etag: '"00000000000000000000000000000000"'
      },
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiByZXBsYWNlbWVudCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU=',
      maxUploadBytes: 1048576
    },
    failure: {
      kind: 'error',
      code: 'conflict',
      message: 'Precondition failed (If-Match).'
    },
    note: 'PUT with a stale If-Match: HTTP 412, or a binding put answering null. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.current.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/update-if-match.txt',
      condition: {
        kind: 'etag',
        etag: '"c0ffee00c0ffee00c0ffee00c0ffee02"'
      },
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiByZXBsYWNlbWVudCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU=',
      maxUploadBytes: 1048576
    },
    response: {
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee03"',
      size: 74
    },
    note: 'PUT with the current If-Match: a new MD5 etag. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.read.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: 'yolk-synthetic-bucket',
      key: 'yolk-conformance/run-synthetic/update-if-match.txt',
      expectedEtag: '"c0ffee00c0ffee00c0ffee00c0ffee03"',
      maxBytes: 1048576
    },
    response: {
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee03"',
      size: 74,
      bodyBase64:
        'eW9say1jb25mb3JtYW5jZSBydW4tc3ludGhldGljOiByZXBsYWNlbWVudCBzeW50aGV0aWMgYm9keSwgc2FmZSB0byBkZWxldGU='
    },
    note: 'The replacement bytes under the new etag. Synthetic.'
  }
]
