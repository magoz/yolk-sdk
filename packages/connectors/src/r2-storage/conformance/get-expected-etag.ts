import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  r2SyntheticBucket,
  r2SyntheticMaxBytes,
  r2SyntheticObject,
  r2SyntheticObjectKey,
  r2SyntheticSeededEtag,
  r2SyntheticSeededText,
  r2SyntheticStaleEtag
} from './synthetic.ts'

const object = r2SyntheticObject(r2SyntheticSeededEtag, r2SyntheticSeededText)

/**
 * The seeded object read plainly, then with its current etag, then with a stale etag: the host
 * fails `conflict`. Synthetic placeholders (no `observed`).
 */
export const r2GetExpectedEtagFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.objects.get-expected-etag.plain.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: r2SyntheticObjectKey,
      maxBytes: r2SyntheticMaxBytes
    },
    response: object,
    note: 'A plain read that learns the etag. Synthetic.'
  },
  {
    id: 'r2.objects.get-expected-etag.current.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: r2SyntheticObjectKey,
      expectedEtag: r2SyntheticSeededEtag,
      maxBytes: r2SyntheticMaxBytes
    },
    response: object,
    note: 'If-Match with the current etag. Synthetic.'
  },
  {
    id: 'r2.objects.get-expected-etag.stale.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: r2SyntheticObjectKey,
      expectedEtag: r2SyntheticStaleEtag,
      maxBytes: r2SyntheticMaxBytes
    },
    failure: { kind: 'error', code: 'conflict', message: 'Precondition failed (If-Match).' },
    note: 'If-Match with a stale etag: HTTP 412 or a binding onlyIf without body. Synthetic.'
  }
]
