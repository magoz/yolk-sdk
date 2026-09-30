import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  r2SyntheticBase64,
  r2SyntheticBucket,
  r2SyntheticByteLength,
  r2SyntheticMaxBytes,
  r2SyntheticObject
} from './synthetic.ts'

const key = 'yolk-conformance/run-synthetic/create-if-absent.txt'

const first = 'yolk-conformance run-synthetic: first synthetic body, safe to delete'

const second = 'yolk-conformance run-synthetic: second synthetic body, never stored'

const etag = '"c0ffee00c0ffee00c0ffee00c0ffee01"'

const put = (text: string) => ({
  bucket: r2SyntheticBucket,
  key,
  condition: { kind: 'absent' },
  bodyBase64: r2SyntheticBase64(text),
  maxUploadBytes: r2SyntheticMaxBytes
})

/**
 * An absent-only create of a run-scoped key, a second create of the same key (refused with
 * `conflict`), and a read with the first etag answering the first bytes. The object stays in the
 * bucket (the connector cannot delete it). Synthetic placeholders (no `observed`).
 */
export const r2CreateIfAbsentFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.objects.create-if-absent.create.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: put(first),
    response: { etag, size: r2SyntheticByteLength(first) },
    note: 'PUT with If-None-Match: * on a fresh key. Synthetic.'
  },
  {
    id: 'r2.objects.create-if-absent.create-again.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: put(second),
    failure: { kind: 'error', code: 'conflict', message: 'Precondition failed (If-None-Match).' },
    note: 'The same key again: HTTP 412, or a binding put answering null. Synthetic.'
  },
  {
    id: 'r2.objects.create-if-absent.read.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: { bucket: r2SyntheticBucket, key, expectedEtag: etag, maxBytes: r2SyntheticMaxBytes },
    response: r2SyntheticObject(etag, first),
    note: 'The first bytes, unchanged. Synthetic.'
  }
]
