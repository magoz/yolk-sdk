import { getWritable } from 'workflow'
import { Data, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { AgentError } from '@yolk/protocol'
import { AppLayer } from '@/lib/layers'
import { reportError } from '@/lib/services/telemetry/report-error'
import type { AgentRouteRequest } from '@/lib/agents/route-handler'
import { makeAgentTextResponse } from './text-response'

export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: AgentRouteRequest
}

class AgentWorkflowStepError extends Data.TaggedError('AgentWorkflowStepError')<{
  message: string
  cause?: unknown
}> {}

const textEncoder = new TextEncoder()

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Workflow agent failed'

const toStepError = (error: unknown) =>
  new AgentWorkflowStepError({ message: unknownToMessage(error), cause: error })

const encodeWorkflowError = (error: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(
    AgentError.make({ code: 'unknown', message: unknownToMessage(error), retryable: false })
  ).pipe(Effect.map(line => textEncoder.encode(`${line}\n`)))

const writeChunk = (writer: WritableStreamDefaultWriter<Uint8Array>, chunk: Uint8Array) =>
  Effect.promise(() => writer.write(chunk))

const closeWriter = (writer: WritableStreamDefaultWriter<Uint8Array>) =>
  Effect.promise(() => writer.close())

const writeWorkflowError = (writer: WritableStreamDefaultWriter<Uint8Array>, error: unknown) =>
  encodeWorkflowError(error).pipe(
    Effect.flatMap(chunk => writeChunk(writer, chunk)),
    Effect.tap(() => reportError(toStepError(error), { operation: 'agent.workflow.step' })),
    Effect.catch(() => Effect.void)
  )

const writeResponseBody = (writer: WritableStreamDefaultWriter<Uint8Array>, response: Response) =>
  Effect.gen(function* () {
    const body = response.body

    if (body === null) {
      return
    }

    const reader = body.getReader()
    let done = false

    while (!done) {
      const next = yield* Effect.promise(() => reader.read())
      done = next.done

      if (!next.done) {
        yield* writeChunk(writer, next.value)
      }
    }
  })

export async function runAgentWorkflowStep(input: AgentWorkflowInput) {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  await Effect.runPromise(
    makeAgentTextResponse(input.request, input.userId, '/agent/workflow').pipe(
      Effect.flatMap(response => writeResponseBody(writer, response)),
      Effect.catch(error => writeWorkflowError(writer, error)),
      Effect.ensuring(closeWriter(writer)),
      Effect.provide(AppLayer),
      Effect.scoped
    )
  )
}

export async function runAgentWorkflow(input: AgentWorkflowInput) {
  'use workflow'

  await runAgentWorkflowStep(input)
}
