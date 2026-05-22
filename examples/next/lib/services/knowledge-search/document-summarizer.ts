import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import { isTransientError, retryPolicy } from '@/lib/services/retry'
import { KnowledgeSummarizationError } from '@yolk-sdk/knowledge/errors'
import { KnowledgeSummarizer } from '@yolk-sdk/knowledge/summarization'
import { AppKnowledgeSummarizerError } from './errors'

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-4.1-mini'
const maxSummaryCharacters = 2_000
const maxDocumentCharacters = 80_000

export const SummarizeKnowledgeDocumentInputSchema = Schema.Struct({
  content: Schema.String,
  sourceTitle: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})

export const KnowledgeDocumentSummarySchema = Schema.Struct({
  title: Schema.String,
  summary: Schema.String
})

const OpenAiChatCompletionResponseSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.NullOr(Schema.String)
      })
    })
  )
})

export type SummarizeKnowledgeDocumentInput = Schema.Schema.Type<typeof SummarizeKnowledgeDocumentInputSchema>
export type KnowledgeDocumentSummary = Schema.Schema.Type<typeof KnowledgeDocumentSummarySchema>

type SummarizerConfig = {
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
}

class KnowledgeDocumentSummarizerConfig extends Context.Service<
  KnowledgeDocumentSummarizerConfig,
  SummarizerConfig
>()('@app/KnowledgeDocumentSummarizerConfig') {}

const optionString = (option: Option.Option<string>) =>
  Option.isSome(option) && option.value.length > 0 ? option.value : undefined

const KnowledgeDocumentSummarizerConfigLayer = Layer.effect(
  KnowledgeDocumentSummarizerConfig,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted('OPENAI_API_KEY')
    const model = optionString(yield* Config.option(Config.string('KNOWLEDGE_SEARCH_SUMMARIZATION_MODEL')))

    return { apiKey, model: model ?? DEFAULT_MODEL }
  }).pipe(
    Effect.mapError(() => new AppKnowledgeSummarizerError({ message: 'OPENAI_API_KEY not found' }))
  )
)

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const truncateContent = (content: string) =>
  content.length <= maxDocumentCharacters ? content : content.slice(0, maxDocumentCharacters)

const buildPrompt = (input: SummarizeKnowledgeDocumentInput) =>
  [
    'Summarize a document for a knowledge search system.',
    'Create a concise, descriptive title and a two to three paragraph summary.',
    'Prefer the actual subject over the filename. Be specific. Avoid vague marketing language.',
    '',
    '<source>',
    `title: ${input.sourceTitle ?? 'unknown'}`,
    `metadata: ${String(input.metadata?.title ?? '')}`,
    '</source>',
    '',
    '<document>',
    truncateContent(input.content),
    '</document>'
  ].join('\n')

const jsonSchema = {
  name: 'knowledge_search_document_summary',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' }
    },
    required: ['title', 'summary']
  }
}

const requestBody = (input: SummarizeKnowledgeDocumentInput, model: string) => ({
  model,
  temperature: 0.2,
  response_format: { type: 'json_schema', json_schema: jsonSchema },
  messages: [
    {
      role: 'system',
      content: 'You write document summaries. Return only JSON matching the requested schema.'
    },
    { role: 'user', content: buildPrompt(input) }
  ]
})

const isOkStatus = (status: number) => status >= 200 && status < 300

const toRequestError = (error: HttpClientError.HttpClientError) =>
  new AppKnowledgeSummarizerError({
    message: `OpenAI summarization request failed: ${error.message}`,
    isTransient: true,
    cause: error
  })

const readErrorBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(
      error => new AppKnowledgeSummarizerError({ message: `Could not read OpenAI error body: ${error.message}` })
    )
  )

const failOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const body = yield* readErrorBody(response)
    return yield* Effect.fail(
      new AppKnowledgeSummarizerError({
        message: `OpenAI summarization failed: ${response.status} ${body}`,
        isTransient: response.status === 429 || response.status >= 500 ? true : undefined
      })
    )
  })

const parseOpenAiResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.mapError(
      error => new AppKnowledgeSummarizerError({ message: `Could not parse OpenAI summarization JSON: ${error.message}` })
    ),
    Effect.flatMap(value =>
      Schema.decodeUnknownEffect(OpenAiChatCompletionResponseSchema)(value).pipe(
        Effect.mapError(
          error => new AppKnowledgeSummarizerError({ message: `Invalid OpenAI summarization response: ${error.message}` })
        )
      )
    )
  )

const decodeSummary = (content: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(KnowledgeDocumentSummarySchema))(content).pipe(
    Effect.mapError(
      error => new AppKnowledgeSummarizerError({ message: `Invalid generated document summary: ${error.message}` })
    ),
    Effect.map(summary => ({
      title: summary.title.trim(),
      summary: summary.summary.trim().slice(0, maxSummaryCharacters)
    })),
    Effect.flatMap(summary =>
      summary.title.length === 0 || summary.summary.length === 0
        ? Effect.fail(new AppKnowledgeSummarizerError({ message: 'Generated document summary was empty' }))
        : Effect.succeed(summary)
    )
  )

const firstChoiceContent = (response: typeof OpenAiChatCompletionResponseSchema.Type) =>
  response.choices[0]?.message.content

export const OpenAiKnowledgeDocumentSummarizerLayer = Layer.effect(
  KnowledgeSummarizer,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const config = yield* KnowledgeDocumentSummarizerConfig

    const summarize = (input: SummarizeKnowledgeDocumentInput) =>
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(OPENAI_CHAT_COMPLETIONS_URL).pipe(
          HttpClientRequest.setHeaders({
            accept: 'application/json',
            authorization: `Bearer ${Redacted.value(config.apiKey)}`,
            'content-type': 'application/json'
          }),
          HttpClientRequest.bodyJson(requestBody(input, config.model)),
          Effect.mapError(
            error => new AppKnowledgeSummarizerError({ message: `Could not encode summarization request: ${error.message}` })
          )
        )
        const response = yield* client.execute(request).pipe(Effect.mapError(toRequestError))

        if (!isOkStatus(response.status)) {
          return yield* failOpenAiResponse(response)
        }

        const parsed = yield* parseOpenAiResponse(response)
        const content = firstChoiceContent(parsed)
        if (content === null || content === undefined) {
          return yield* Effect.fail(new AppKnowledgeSummarizerError({ message: 'OpenAI summarization returned no content' }))
        }

        yield* Effect.annotateCurrentSpan({
          model: config.model,
          'document.content_length': input.content.length
        })

        return yield* decodeSummary(content)
      }).pipe(
        Effect.withSpan('knowledge_search.document.summarize'),
        Effect.retry({ while: isTransientError, schedule: retryPolicy }),
        Effect.mapError(error =>
          new KnowledgeSummarizationError({
            message: error instanceof AppKnowledgeSummarizerError ? error.message : unknownToMessage(error),
            cause: error
          })
        )
      )

    return { summarize }
  })
).pipe(Layer.provide(KnowledgeDocumentSummarizerConfigLayer), Layer.provide(FetchHttpClient.layer))
