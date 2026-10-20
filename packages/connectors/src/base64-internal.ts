// Count trailing '=' with one backward scan: an unanchored /=+$/ retries from every position
// of a long '=' run and is quadratic on untrusted multi-megabyte input.
export const splitBase64Padding = (value: string) => {
  let end = value.length

  while (end > 0 && value.charCodeAt(end - 1) === 61) end -= 1

  return { unpadded: value.slice(0, end), padding: value.length - end }
}

/**
 * The bytes of an `atob` binary string, copied into one preallocated array:
 * `Uint8Array.from(binary, mapFn)` first collects every character into a list, which costs tens
 * of bytes per decoded byte (~0.7 GB for 20 MiB).
 */
export const binaryStringToBytes = (binary: string) => {
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

  return bytes
}
