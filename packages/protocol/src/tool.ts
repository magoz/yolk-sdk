import * as Schema from 'effect/Schema'
import { Content } from './content'

export class ToolCall extends Schema.Class<ToolCall>('ToolCall')({
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown
}) {}

export class ToolDef extends Schema.Class<ToolDef>('ToolDef')({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown
}) {}

export class ToolResult extends Schema.Class<ToolResult>('ToolResult')({
  toolCallId: Schema.String,
  content: Content
}) {}
