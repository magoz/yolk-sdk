/**
 * Shared synthetic shapes of the R2 fixtures (internal): the practice endpoint and bucket, the
 * seeded object, and object bodies as plain-JSON port values. Synthetic data only (`example.test`
 * hosts, placeholder signatures); never recorded from a live bucket.
 */
import type * as Schema from 'effect/Schema'
import {
  r2BytesToBase64,
  r2ConformanceSyntheticCredential,
  r2ConformanceSyntheticSignature
} from './backend.ts'

export const r2SyntheticEndpoint = 'https://synthetic-account.r2.example.test'

export const r2SyntheticBucket = 'yolk-synthetic-bucket'

export const r2SyntheticObjectKey = 'fixtures/synthetic-object.txt'

/** The trusted 1 MB budget the cases pass, as the port sees it. */
export const r2SyntheticMaxBytes = 1_048_576

export const r2SyntheticSeededText = 'Synthetic conformance object: safe to read.\n'

export const r2SyntheticSeededEtag = '"a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"'

/** A stale, well-formed etag (quoted like the seeded one), as the cases derive it. */
export const r2SyntheticStaleEtag = `"${'0'.repeat(32)}"`

export const r2SyntheticBase64 = (text: string) => r2BytesToBase64(new TextEncoder().encode(text))

export const r2SyntheticByteLength = (text: string) => new TextEncoder().encode(text).byteLength

/** An object as `R2ObjectClient.get` answers it, as plain JSON. */
export const r2SyntheticObject = (etag: string, text: string): Schema.Json => ({
  etag,
  size: r2SyntheticByteLength(text),
  bodyBase64: r2SyntheticBase64(text)
})

/**
 * A presigned PUT URL shaped like an AWS SDK v3 presign for R2 (path-style), carrying only the
 * synthetic credential placeholders.
 */
export const r2SyntheticPresignedUrl = (key: string) => {
  const url = new URL(`${r2SyntheticEndpoint}/${r2SyntheticBucket}/${key}`)

  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD')
  url.searchParams.set('X-Amz-Credential', r2ConformanceSyntheticCredential)
  url.searchParams.set('X-Amz-Date', '20260930T120000Z')
  url.searchParams.set('X-Amz-Expires', '900')
  url.searchParams.set('X-Amz-Signature', r2ConformanceSyntheticSignature)
  url.searchParams.set('X-Amz-SignedHeaders', 'content-type;host')
  url.searchParams.set('x-id', 'PutObject')

  return url.toString()
}
