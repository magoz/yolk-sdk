export type CacheKeyHeaders = (cacheKey: string) => Readonly<Record<string, string>>

/** Session-affinity headers for `LLMRequest.cacheKey`; none without a key or a vendor mapping. */
export const requestCacheKeyHeaders = (
  cacheKey: string | undefined,
  headers: CacheKeyHeaders | undefined
): Readonly<Record<string, string>> => {
  if (cacheKey === undefined || headers === undefined) {
    return {}
  }

  return headers(cacheKey)
}
