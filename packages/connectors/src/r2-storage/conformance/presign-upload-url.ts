import type { PortFixture } from '@yolk-sdk/conformance/fixture'
import { r2SyntheticBucket, r2SyntheticEndpoint, r2SyntheticPresignedUrl } from './synthetic.ts'

const key = 'yolk-conformance/run-synthetic/presign.txt'

/**
 * `r2_storage.upload_url` for `/yolk-conformance/run-synthetic/presign.txt`: one credential-free
 * `presignPutObject` call, answered with a path-style SigV4 PUT URL carrying only the synthetic
 * credential placeholders. Synthetic placeholder (no `observed`).
 */
export const r2PresignUploadUrlFixtures: ReadonlyArray<PortFixture> = [
  {
    id: 'r2.presign.put-upload-url.presign.synthetic',
    port: 'R2Presigner',
    method: 'presignPutObject',
    request: {
      endpoint: r2SyntheticEndpoint,
      bucket: r2SyntheticBucket,
      key,
      contentType: 'text/plain'
    },
    response: { uploadUrl: r2SyntheticPresignedUrl(key) },
    note: 'Local SigV4 query signing (15-minute expiry, content-type signed); nothing sent to R2. Synthetic.'
  }
]
