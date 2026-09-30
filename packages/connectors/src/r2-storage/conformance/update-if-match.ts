import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  r2SyntheticBase64,
  r2SyntheticBucket,
  r2SyntheticByteLength,
  r2SyntheticMaxBytes,
  r2SyntheticObject,
  r2SyntheticStaleEtag
} from './synthetic.ts'

const key = 'yolk-conformance/run-synthetic/update-if-match.txt'

const original = 'yolk-conformance run-synthetic: original synthetic body, safe to delete'

const replacement = 'yolk-conformance run-synthetic: replacement synthetic body, safe to delete'

const createdEtag = '"c0ffee00c0ffee00c0ffee00c0ffee02"'

const updatedEtag = '"c0ffee00c0ffee00c0ffee00c0ffee03"'

const put = (text: string, condition: Record<string, string>) => ({
  bucket: r2SyntheticBucket,
  key,
  condition,
  bodyBase64: r2SyntheticBase64(text),
  maxUploadBytes: r2SyntheticMaxBytes
})

/**
 * An absent-only create of a run-scoped key, an update with a stale etag (refused with
 * `conflict`), an update with the created etag (a new etag), and a read with the new etag
 * answering the replacement bytes. The object stays in the bucket (the connector cannot delete
 * it). Synthetic placeholders (no `observed`).
 */
export const r2UpdateIfMatchFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.objects.update-if-match.create.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: put(original, { kind: 'absent' }),
    response: { etag: createdEtag, size: r2SyntheticByteLength(original) },
    note: 'PUT with If-None-Match: * on a fresh key. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.stale.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: put(replacement, { kind: 'etag', etag: r2SyntheticStaleEtag }),
    failure: { kind: 'error', code: 'conflict', message: 'Precondition failed (If-Match).' },
    note: 'PUT with a stale If-Match: HTTP 412, or a binding put answering null. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.current.synthetic',
    port: 'R2ObjectClient',
    method: 'put',
    request: put(replacement, { kind: 'etag', etag: createdEtag }),
    response: { etag: updatedEtag, size: r2SyntheticByteLength(replacement) },
    note: 'PUT with the current If-Match: a new MD5 etag. Synthetic.'
  },
  {
    id: 'r2.objects.update-if-match.read.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key,
      expectedEtag: updatedEtag,
      maxBytes: r2SyntheticMaxBytes
    },
    response: r2SyntheticObject(updatedEtag, replacement),
    note: 'The replacement bytes under the new etag. Synthetic.'
  }
]
