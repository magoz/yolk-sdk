import * as Schema from 'effect/Schema'
import { Content } from './content.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export class ToolCall extends Schema.Class<ToolCall>('ToolCall')({
  id: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  params: Schema.Unknown
}) {}

export class ToolDef extends Schema.Class<ToolDef>('ToolDef')({
  name: NonEmptyTrimmedString,
  description: Schema.String,
  parameters: Schema.Unknown
}) {}

export class ToolResult extends Schema.Class<ToolResult>('ToolResult')({
  toolCallId: NonEmptyTrimmedString,
  content: Content,
  structuredContent: Schema.optional(Schema.Unknown)
}) {}
