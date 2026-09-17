import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { EmptyToolParams, makeInputTool, type ToolModule } from '@yolk-sdk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/** App-owned user payload for the draft composer. Collects a draft only;
 * sending email is out of scope and never performed here. */
export class DraftComposerResponse extends Schema.Class<DraftComposerResponse>(
  'DraftComposerResponse'
)({
  to: NonEmptyTrimmedString,
  subject: NonEmptyTrimmedString,
  body: NonEmptyTrimmedString
}) {}

export const draftComposerToolName = 'compose_draft'

/** Stable app-owned renderer key for the draft composer input request. */
export const draftComposerInputKind = 'draft-composer'

const draftComposerRegistration = makeInputTool({
  name: draftComposerToolName,
  description:
    'Collect an email draft (to, subject, body) from the user. Use when the user needs to review or supply draft fields before continuing. Never sends email.',
  callParameters: EmptyToolParams,
  response: DraftComposerResponse,
  renderer: draftComposerInputKind,
  title: 'Compose draft',
  inputDescription: 'Fill in the draft fields. Nothing is sent.',
  // The loop only formats validated payloads, so the decode below re-projects the
  // app-owned schema instead of narrowing the JSON representation by hand.
  formatContent: input =>
    Option.match(Schema.decodeUnknownOption(DraftComposerResponse)(input.data), {
      onNone: () =>
        `User has provided a draft: ${JSON.stringify(input.data)}. Continue with the user's input in mind.`,
      onSome: draft =>
        `User has composed a draft to ${draft.to} with subject "${draft.subject}": ${draft.body}. Continue with the user's input in mind.`
    })
})

/** Top-level text-only draft composer. Omitted from voice toolsets and from
 * subagents/child workflows, which lack nested HITL resume. */
export const draftComposerToolModule: ToolModule<AgentToolContext> = {
  id: 'draft-composer',
  tools: [
    {
      ...draftComposerRegistration,
      isEnabled: context => Effect.succeed(context.surface === 'text' && context.subagent !== true)
    }
  ]
}
