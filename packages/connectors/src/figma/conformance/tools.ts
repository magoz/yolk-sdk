/**
 * The Figma tool listing the synthetic fixtures publish: six tool NAMES the Figma remote MCP
 * server is known to offer (four reads, `use_figma` for edits, `create_new_file` for creation),
 * each with a synthetic placeholder description and input schema and a `readOnlyHint` (unverified:
 * Figma's own annotations and schemas; dynamic discovery owns the real contract, and deployed
 * node-selection parameters differ from Figma's published documentation).
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

const nodeInput: Schema.JsonObject = {
  type: 'object',
  properties: { nodeId: { type: 'string' } },
  required: ['nodeId'],
  additionalProperties: false
}

const tool = (
  name: string,
  inputSchema: Schema.JsonObject,
  readOnlyHint: boolean
): Schema.JsonObject => ({
  name,
  description: 'Synthetic placeholder description.',
  inputSchema,
  annotations: { readOnlyHint }
})

/** The published tool subset, in listing order. */
export const figmaMcpConformanceTools: ReadonlyArray<Schema.JsonObject> = [
  tool('get_design_context', nodeInput, true),
  tool('get_metadata', nodeInput, true),
  tool('get_screenshot', nodeInput, true),
  tool('whoami', { type: 'object', properties: {}, additionalProperties: false }, true),
  tool(
    'use_figma',
    {
      type: 'object',
      properties: { instructions: { type: 'string' } },
      required: ['instructions'],
      additionalProperties: false
    },
    false
  ),
  tool(
    'create_new_file',
    {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    false
  )
]
