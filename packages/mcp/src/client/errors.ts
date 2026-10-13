import * as Schema from 'effect/Schema'

export const McpErrorCause = Schema.Literals([
  'disabled',
  'security',
  'transport',
  'protocol',
  'parse',
  'encoding',
  'timeout',
  'validation',
  'tool_error'
])

export type McpErrorCause = typeof McpErrorCause.Type

export class McpError extends Schema.TaggedError<McpError>()('McpError', {
  server: Schema.String,
  message: Schema.String,
  cause: McpErrorCause
}) {}

/**
 * Why an MCP input-required (MRTR) step failed:
 *
 * - `malformed`: the `InputRequiredResult` (or one of its form elicitations) does not decode.
 * - `too_large`: it exceeds the byte bound or carries more than `mcpMaxInputRequests` requests.
 * - `unsupported_request`: it asks for anything but form elicitation (URL mode, sampling, roots),
 *   or for any input when the host did not declare form elicitation.
 * - `invalid_responses`: the host's decisions do not match the paused call's elicitations.
 * - `unsupported_era`: the server negotiated a legacy (pre-`2026-07-28`) era, which has no
 *   input-required results; legacy server-initiated elicitation is not supported.
 */
export const McpInputRequiredErrorReason = Schema.Literals([
  'malformed',
  'too_large',
  'unsupported_request',
  'invalid_responses',
  'unsupported_era'
])

export type McpInputRequiredErrorReason = typeof McpInputRequiredErrorReason.Type

export class McpInputRequiredError extends Schema.TaggedError<McpInputRequiredError>()(
  'McpInputRequiredError',
  {
    server: Schema.String,
    message: Schema.String,
    reason: McpInputRequiredErrorReason
  }
) {}

/**
 * The server refused the request with MCP `-32021` (MissingRequiredClientCapability): it needs a
 * client capability the request did not declare. `requiredCapabilities` lists the missing ones in
 * the `ClientCapabilities` shape (for example `{ elicitation: { form: {} } }`).
 */
export class McpClientCapabilityRequiredError extends Schema.TaggedError<McpClientCapabilityRequiredError>()(
  'McpClientCapabilityRequiredError',
  {
    server: Schema.String,
    message: Schema.String,
    requiredCapabilities: Schema.Record(Schema.String, Schema.Unknown)
  }
) {}
