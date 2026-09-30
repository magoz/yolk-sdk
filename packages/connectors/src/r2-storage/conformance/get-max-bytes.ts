import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import {
  r2SyntheticBucket,
  r2SyntheticByteLength,
  r2SyntheticMaxBytes,
  r2SyntheticObject,
  r2SyntheticObjectKey,
  r2SyntheticSeededEtag,
  r2SyntheticSeededText
} from './synthetic.ts'

/**
 * The seeded object read within a 1 MB budget, then with a budget one byte smaller than it: the
 * host fails `response_too_large` instead of answering the bytes. Synthetic placeholders (no
 * `observed`).
 */
export const r2GetMaxBytesFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.objects.get-max-bytes.within-budget.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: r2SyntheticObjectKey,
      maxBytes: r2SyntheticMaxBytes
    },
    response: r2SyntheticObject(r2SyntheticSeededEtag, r2SyntheticSeededText),
    note: 'The seeded object within the budget. Synthetic.'
  },
  {
    id: 'r2.objects.get-max-bytes.over-budget.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: r2SyntheticObjectKey,
      maxBytes: r2SyntheticByteLength(r2SyntheticSeededText) - 1
    },
    failure: {
      kind: 'error',
      code: 'response_too_large',
      message: 'The object is larger than maxBytes; no bytes were returned.'
    },
    note: 'The host stops at maxBytes (Content-Length or streamed count). Synthetic.'
  }
]
