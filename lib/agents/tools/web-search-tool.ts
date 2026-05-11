import { Config, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ToolError } from '@yolk/agent-loop'
import { ToolDef, ToolResult, type ToolCall } from '@yolk/protocol'
import type { ToolModule, ToolRegistration } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'

const webSearchToolName = 'web_search'
const defaultNumResults = 8
const maxNumResults = 20
const defaultContextMaxCharacters = 10_000
const maxContextMaxCharacters = 50_000
const searchTimeoutMs = 25_000

const WebSearchProvider = Schema.Literals(['exa', 'parallel'])
const WebSearchType = Schema.Literals(['auto', 'fast', 'deep'])
const WebSearchLiveCrawl = Schema.Literals(['fallback', 'preferred'])
const WebSearchParams = Schema.Struct({
  query: Schema.String,
  numResults: Schema.optional(Schema.Number),
  type: Schema.optional(WebSearchType),
  livecrawl: Schema.optional(WebSearchLiveCrawl),
  contextMaxCharacters: Schema.optional(Schema.Number)
})

type WebSearchProvider = typeof WebSearchProvider.Type
type WebSearchType = typeof WebSearchType.Type
type WebSearchLiveCrawl = typeof WebSearchLiveCrawl.Type
type WebSearchParams = typeof WebSearchParams.Type

type NormalizedWebSearchParams = {
  readonly query: string
  readonly numResults: number
  readonly type: WebSearchType
  readonly livecrawl: WebSearchLiveCrawl
  readonly contextMaxCharacters: number
}

export type McpWebSearchRequest = {
  readonly provider: WebSearchProvider
  readonly url: string
  readonly tool: string
  readonly arguments: unknown
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export type WebSearchDependencies = {
  readonly request: (input: McpWebSearchRequest) => Effect.Effect<string, ToolError>
}

type WebSearchConfig = {
  readonly providerOverride: WebSearchProvider | undefined
  readonly exaApiKey: string | undefined
  readonly parallelApiKey: string | undefined
}

const McpToolCallRequest = Schema.Struct({
  jsonrpc: Schema.String,
  id: Schema.Number,
  method: Schema.String,
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Unknown
  })
})

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String
      })
    )
  })
})

const decodeMcpResult = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const webSearchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'Web search query.'
    },
    numResults: {
      type: 'number',
      description: 'Number of results to return. Defaults to 8; capped at 20.'
    },
    type: {
      type: 'string',
      enum: ['auto', 'fast', 'deep'],
      description: 'Search depth when supported. Defaults to auto.'
    },
    livecrawl: {
      type: 'string',
      enum: ['fallback', 'preferred'],
      description: 'Live crawl mode when supported. Defaults to fallback.'
    },
    contextMaxCharacters: {
      type: 'number',
      description:
        'Maximum LLM-ready context characters when supported. Defaults to 10000; capped at 50000.'
    }
  },
  required: ['query']
}

const webSearchToolDef = ToolDef.make({
  name: webSearchToolName,
  description: [
    'Search the web for current information using a hosted search provider.',
    'Use this when the user asks for recent information, current facts, or discovery across multiple websites.',
    'Use web_fetch instead when the user gives a specific URL.'
  ].join(' '),
  parameters: webSearchParameters
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: webSearchToolName,
    message,
    cause
  })

const decodeWebSearchParams = (params: unknown) =>
  Schema.decodeUnknownEffect(WebSearchParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid web search arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

const normalizePositiveInteger = (input: {
  readonly value: number | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly name: string
}) => {
  const value = input.value ?? input.defaultValue

  if (!Number.isInteger(value) || value <= 0) {
    return Effect.fail(makeToolError(`${input.name} must be a positive integer`, 'validation'))
  }

  return Effect.succeed(Math.min(value, input.maxValue))
}

const normalizeWebSearchParams = (params: WebSearchParams) =>
  Effect.gen(function* () {
    const query = params.query.trim()
    if (query.length === 0) {
      return yield* Effect.fail(makeToolError('query must not be empty', 'validation'))
    }

    const numResults = yield* normalizePositiveInteger({
      value: params.numResults,
      defaultValue: defaultNumResults,
      maxValue: maxNumResults,
      name: 'numResults'
    })
    const contextMaxCharacters = yield* normalizePositiveInteger({
      value: params.contextMaxCharacters,
      defaultValue: defaultContextMaxCharacters,
      maxValue: maxContextMaxCharacters,
      name: 'contextMaxCharacters'
    })

    return {
      query,
      numResults,
      type: params.type ?? 'auto',
      livecrawl: params.livecrawl ?? 'fallback',
      contextMaxCharacters
    }
  })

const optionString = (option: Option.Option<string>) =>
  Option.isSome(option) && option.value.length > 0 ? option.value : undefined

const providerOverrideFromString = (provider: string | undefined): WebSearchProvider | undefined =>
  provider === 'exa' || provider === 'parallel' ? provider : undefined

const loadWebSearchConfig: Effect.Effect<WebSearchConfig, ToolError> = Effect.gen(function* () {
  const providerOption = yield* Config.option(Config.string('YOLK_WEBSEARCH_PROVIDER'))
  const exaApiKeyOption = yield* Config.option(Config.string('EXA_API_KEY'))
  const parallelApiKeyOption = yield* Config.option(Config.string('PARALLEL_API_KEY'))
  const provider = optionString(providerOption)
  const exaApiKey = optionString(exaApiKeyOption)
  const parallelApiKey = optionString(parallelApiKeyOption)

  return {
    providerOverride: providerOverrideFromString(provider),
    exaApiKey,
    parallelApiKey
  }
}).pipe(
  Effect.mapError(error =>
    makeToolError(`Invalid web search environment: ${unknownToMessage(error)}`, 'validation')
  )
)

const queryChecksum = (query: string) =>
  Array.from(query).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0)

export const selectWebSearchProvider = (
  query: string,
  override: WebSearchProvider | undefined = undefined
) => override ?? (queryChecksum(query) % 2 === 0 ? 'exa' : 'parallel')

const alternateProvider = (provider: WebSearchProvider): WebSearchProvider =>
  provider === 'exa' ? 'parallel' : 'exa'

const exaUrl = (config: WebSearchConfig) =>
  config.exaApiKey === undefined
    ? 'https://mcp.exa.ai/mcp'
    : `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(config.exaApiKey)}`

const parallelHeaders = (config: WebSearchConfig) => {
  const headers = { 'user-agent': 'YolkAgent/0.1 (+https://yolk.ai)' }

  return config.parallelApiKey === undefined
    ? headers
    : { ...headers, authorization: `Bearer ${config.parallelApiKey}` }
}

const exaArguments = (params: NormalizedWebSearchParams) => ({
  query: params.query,
  type: params.type,
  numResults: params.numResults,
  livecrawl: params.livecrawl,
  contextMaxCharacters: params.contextMaxCharacters
})

const parallelArguments = (params: NormalizedWebSearchParams) => ({
  objective: params.query,
  search_queries: [params.query]
})

const mcpRequestForProvider = (
  provider: WebSearchProvider,
  params: NormalizedWebSearchParams,
  config: WebSearchConfig
): McpWebSearchRequest =>
  provider === 'parallel'
    ? {
        provider,
        url: 'https://search.parallel.ai/mcp',
        tool: 'web_search',
        arguments: parallelArguments(params),
        headers: parallelHeaders(config),
        timeoutMs: searchTimeoutMs
      }
    : {
        provider,
        url: exaUrl(config),
        tool: 'web_search_exa',
        arguments: exaArguments(params),
        headers: {},
        timeoutMs: searchTimeoutMs
      }

const requestMcpWebSearch = (input: McpWebSearchRequest) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = yield* HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.accept('application/json, text/event-stream'),
      HttpClientRequest.setHeaders(input.headers),
      HttpClientRequest.schemaBodyJson(McpToolCallRequest)({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: input.tool,
          arguments: input.arguments
        }
      }),
      Effect.mapError(error =>
        makeToolError(`Could not encode search request: ${unknownToMessage(error)}`, 'execution')
      )
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.mapError(error =>
          makeToolError(`Search request failed: ${unknownToMessage(error)}`, 'execution')
        ),
        Effect.timeoutOrElse({
          duration: input.timeoutMs,
          orElse: () => Effect.fail(makeToolError('Search request timed out', 'timeout'))
        })
      )

    return yield* response.text.pipe(
      Effect.mapError(error =>
        makeToolError(`Could not read search response: ${unknownToMessage(error)}`, 'execution')
      )
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))

const liveWebSearchDependencies: WebSearchDependencies = {
  request: requestMcpWebSearch
}

const parseMcpPayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith('{')) {
      return undefined
    }

    const data = yield* decodeMcpResult(trimmed).pipe(
      Effect.mapError(error =>
        makeToolError(`Invalid search response: ${unknownToMessage(error)}`, 'execution')
      )
    )

    return data.result.content.find(item => item.text.trim().length > 0)?.text
  })

export const parseMcpWebSearchResponse = (body: string) =>
  Effect.gen(function* () {
    const direct = yield* parseMcpPayload(body)
    if (direct !== undefined) {
      return direct
    }

    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        const parsed = yield* parseMcpPayload(line.substring('data: '.length))
        if (parsed !== undefined) {
          return parsed
        }
      }
    }

    return undefined
  })

const callSearchProvider = (
  deps: WebSearchDependencies,
  provider: WebSearchProvider,
  params: NormalizedWebSearchParams,
  config: WebSearchConfig
) =>
  Effect.gen(function* () {
    const response = yield* deps.request(mcpRequestForProvider(provider, params, config))
    const output = yield* parseMcpWebSearchResponse(response)

    return {
      provider,
      output: output ?? 'No search results found. Try a different query.'
    }
  })

const shouldFallback = (error: ToolError) =>
  error.cause === 'execution' || error.cause === 'timeout'

const runSearchWithFallback = (
  deps: WebSearchDependencies,
  provider: WebSearchProvider,
  params: NormalizedWebSearchParams,
  override: WebSearchProvider | undefined,
  config: WebSearchConfig
) =>
  callSearchProvider(deps, provider, params, config).pipe(
    Effect.catchTag('ToolError', error =>
      override === undefined && shouldFallback(error)
        ? callSearchProvider(deps, alternateProvider(provider), params, config)
        : Effect.fail(error)
    )
  )

const formatToolOutput = (input: {
  readonly provider: WebSearchProvider
  readonly query: string
  readonly output: string
}) => [`Provider: ${input.provider}`, `Query: ${input.query}`, '', input.output].join('\n')

export const searchWeb = (
  params: WebSearchParams,
  deps: WebSearchDependencies = liveWebSearchDependencies
) =>
  Effect.gen(function* () {
    const normalized = yield* normalizeWebSearchParams(params)
    const config = yield* loadWebSearchConfig
    const override = config.providerOverride
    const provider = selectWebSearchProvider(normalized.query, override)
    const result = yield* runSearchWithFallback(deps, provider, normalized, override, config)

    return formatToolOutput({
      provider: result.provider,
      query: normalized.query,
      output: result.output
    })
  })

export const executeWebSearchTool = (
  call: ToolCall,
  deps: WebSearchDependencies = liveWebSearchDependencies
) => {
  if (call.name !== webSearchToolName) {
    return Effect.fail(
      new ToolError({
        tool: call.name,
        message: `Tool is not configured: ${call.name}`,
        cause: 'permission'
      })
    )
  }

  return Effect.gen(function* () {
    const params = yield* decodeWebSearchParams(call.params)
    const content = yield* searchWeb(params, deps)

    return ToolResult.make({ toolCallId: call.id, content })
  })
}

export const webSearchToolRegistration: ToolRegistration<AgentToolContext> = {
  def: webSearchToolDef,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text' || context.surface === 'voice'),
  execute: ({ call }) => executeWebSearchTool(call)
}

export const webSearchToolModule: ToolModule<AgentToolContext> = {
  id: 'web-search',
  tools: [webSearchToolRegistration]
}
