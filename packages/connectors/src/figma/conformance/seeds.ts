/**
 * Seeds of the Figma MCP conformance target. Their shape is the `McpConformanceSeeds` of
 * `@yolk-sdk/mcp/conformance` (this package never imports `@yolk-sdk/mcp`).
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'

/** The structural `McpConformanceSeeds` of a Figma run. */
export type FigmaMcpConformanceSeeds = {
  readonly readTool?: { readonly name: string; readonly arguments: Schema.JsonObject }
  readonly invalidArguments?: Schema.JsonObject
  readonly expectedTools?: ReadonlyArray<string>
  readonly notReadOnly?: ReadonlyArray<string>
  readonly absentToolName?: string
}

/**
 * The published tool subset the listing must contain, in listing order (unverified: no live
 * listing has been recorded).
 */
export const figmaMcpConformanceExpectedTools: ReadonlyArray<string> = [
  'get_design_context',
  'get_metadata',
  'get_screenshot',
  'whoami',
  'use_figma',
  'create_new_file'
]

/**
 * The published tools that write (`use_figma` edits a design, `create_new_file` creates one): the
 * listing must never mark them read-only.
 */
export const figmaMcpConformanceNotReadOnly: ReadonlyArray<string> = [
  'use_figma',
  'create_new_file'
]

/** The read call of the committed fixtures: the metadata of one synthetic node. */
export const figmaMcpConformanceReadCall = {
  name: 'get_metadata',
  arguments: { nodeId: '0:1' }
} satisfies { readonly name: string; readonly arguments: Schema.JsonObject }

/** Arguments `get_metadata` rejects with a tool error: a node id that is not a string. */
export const figmaMcpConformanceInvalidArguments: Schema.JsonObject = { nodeId: 1 }

/**
 * Seeds for a live run: the listing claims only. A live run calls no tool unless a person names
 * one, so these name no `readTool`.
 */
export const figmaMcpConformanceLiveSeeds: FigmaMcpConformanceSeeds = {
  expectedTools: figmaMcpConformanceExpectedTools,
  notReadOnly: figmaMcpConformanceNotReadOnly
}

/** The seeds the committed fixtures replay with (the live seeds plus the synthetic read call). */
export const figmaMcpConformanceFixtureSeeds: FigmaMcpConformanceSeeds = {
  ...figmaMcpConformanceLiveSeeds,
  readTool: figmaMcpConformanceReadCall,
  invalidArguments: figmaMcpConformanceInvalidArguments
}
