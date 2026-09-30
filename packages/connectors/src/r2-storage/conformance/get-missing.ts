import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { r2SyntheticBucket, r2SyntheticMaxBytes } from './synthetic.ts'

/**
 * A read of a run-scoped key nothing wrote: the host fails `not_found`. Synthetic placeholder (no
 * `observed`).
 */
export const r2GetMissingFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.objects.get-missing-not-found.get.synthetic',
    port: 'R2ObjectClient',
    method: 'get',
    request: {
      bucket: r2SyntheticBucket,
      key: 'yolk-conformance/run-synthetic/absent.txt',
      maxBytes: r2SyntheticMaxBytes
    },
    failure: { kind: 'error', code: 'not_found', message: 'No object with that key.' },
    note: 'HTTP 404 NoSuchKey, or a binding get answering null. Synthetic.'
  }
]
