/**
 * HTTP rules shared by the emulators (internal): which statuses and headers a fault or scripted
 * error may answer with.
 *
 * Every emulated response carries a body and emulators never redirect, so 1xx, 204, 205, and
 * every 3xx (including 304) are rejected when the fault or turn is added, as are invalid header
 * names or values, a `location` header, and the framing headers the server sets itself.
 *
 * Runtime-portable (no Node builtins): the emulators are plain Web fetch handlers.
 */
import * as Schema from 'effect/Schema'

/** Why a status cannot answer an emulated request, or `undefined` when it can. */
const emulatorStatusProblem = (status: number): string | undefined =>
  status >= 300 && status <= 399
    ? 'emulators never redirect: 3xx statuses are not allowed'
    : status === 204 || status === 205
      ? 'a 204 or 205 response cannot carry a body'
      : undefined

/** Statuses a fault or scripted error may answer with: 200-599 without 204, 205, and 3xx. */
export const EmulatorResponseStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 200, maximum: 599 }),
  Schema.makeFilter(emulatorStatusProblem)
)

// RFC 9110 token characters for header names.
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Visible ASCII, space, tab, and obs-text: what both web `Headers` and Node's HTTP server accept.
const headerValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/

const framingHeaders: ReadonlySet<string> = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade'
])

/** Why a header record cannot be sent by an emulator, or `undefined` when it can. */
const emulatorHeaderRecordProblem = (
  headers: Readonly<Record<string, string>>
): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (!headerNamePattern.test(name)) {
      return `header name ${JSON.stringify(name)} is not a valid HTTP token`
    }

    if (name.toLowerCase() === 'location') {
      return 'emulators never redirect: a location header is not allowed'
    }

    // The server frames the body itself; a hand-set framing header would corrupt the response.
    if (framingHeaders.has(name.toLowerCase())) {
      return `header ${name} is set by the server and cannot be scripted`
    }

    if (!headerValuePattern.test(value)) {
      return `header ${name} has a value with control or non-Latin-1 characters`
    }
  }

  return undefined
}

/** Response headers for a fault or scripted error: valid names and values, and no `location`. */
export const EmulatorHeaderRecord = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(emulatorHeaderRecordProblem)
)
