/**
 * The MCP header value encoding the pinned SDK applies to `mcp-name` and `Mcp-Param-*` headers
 * (`encodeMcpParamValue` in `@modelcontextprotocol/client` 2.0.0, not exported there): a value that
 * is already a safe plain-ASCII field value passes through unchanged; anything else (an empty
 * value, a byte outside 0x20 to 0x7E other than tab, leading or trailing whitespace, or a value
 * already shaped like the sentinel) becomes `=?base64?<base64 of UTF-8>?=`.
 *
 * @experimental
 */

const sentinelPrefix = '=?base64?'

const sentinelSuffix = '?='

const needsBase64 = (value: string): boolean =>
  value.length === 0 ||
  (value.startsWith(sentinelPrefix) && value.endsWith(sentinelSuffix)) ||
  value !== value.trim() ||
  Array.from(value).some(character => {
    const code = character.codePointAt(0) ?? 0

    return code !== 9 && (code < 32 || code > 126)
  })

const utf8ToBase64 = (value: string): string =>
  btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCodePoint(byte)).join(''))

/** The header value the SDK sends for `value` (see the module doc). */
export const encodeMcpParamValue = (value: string): string =>
  needsBase64(value) ? `${sentinelPrefix}${utf8ToBase64(value)}${sentinelSuffix}` : value
