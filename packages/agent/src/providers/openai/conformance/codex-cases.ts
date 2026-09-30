/**
 * OpenAI Codex (ChatGPT subscription) Responses conformance cases for
 * `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the public Codex provider (`makeOpenAiCodexProviderLayer`: Bearer OAuth,
 * `originator`, the default `https://chatgpt.com/backend-api/codex/responses` endpoint, reasoning
 * `{ effort: 'low', summary: 'auto' }` on every request, no output limit, EOF-completion
 * compatibility) from `OpenAiCodexConformanceConfig`, sends one request through `LLMProvider`,
 * and asserts one wire claim from the events it sees (and, for the error and terminal-event
 * cases, from the raw body read at the case's own `HttpClient` boundary). Cases need only
 * `HttpClient.HttpClient` and the config service, so the same case runs against replayed fixtures
 * (`ReplayHttpClient`), an emulator, or a host's live `HttpClient`. All four are `read` cases;
 * none is observed live yet (`observed` absent = unverified).
 */
import { Context, Effect } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import type { ConformanceCase, ConformanceMismatch } from '@yolk-sdk/conformance/case'
import type { LLMProviderError } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { openAiCodexResponsesUrl } from '../codex.ts'
import { makeOpenAiCodexProviderLayer } from '../codex-provider.ts'
import { openAiCodexErrorEnvelopeFixture } from './codex-error-envelope.ts'
import { openAiCodexFunctionCallArgumentsFixture } from './codex-function-call-arguments.ts'
import { openAiCodexPlainTextFixture } from './codex-plain-text.ts'
import { openAiCodexTerminalEventFixture } from './codex-terminal-event.ts'
import {
  makeResponsesConformanceCases,
  type ResponsesConformanceModels
} from './responses-cases-internal.ts'

/** The ChatGPT Codex Responses endpoint the cases (and the provider's default) call. */
export const openAiCodexConformanceResponsesUrl = openAiCodexResponsesUrl

/** Model ids per case. `invalid` must NOT exist on the Codex endpoint. */
export type OpenAiCodexConformanceModels = ResponsesConformanceModels

/** Model ids used by the committed fixtures and the live probe defaults. */
export const openAiCodexConformanceDefaultModels: OpenAiCodexConformanceModels = {
  plainText: 'gpt-5.4',
  toolCall: 'gpt-5.4',
  invalid: 'yolk-conformance-model-does-not-exist'
}

export type OpenAiCodexConformanceSettings = {
  /**
   * ChatGPT subscription OAuth access token, sent as `Authorization: Bearer` (with
   * `ChatGPT-Account-Id` when `accountId` is set). Any value works under replay or an emulator.
   */
  readonly token: OAuthAccessToken
  readonly models: OpenAiCodexConformanceModels
}

/** Host-supplied settings for the Codex Responses conformance cases. */
export class OpenAiCodexConformanceConfig extends Context.Service<
  OpenAiCodexConformanceConfig,
  OpenAiCodexConformanceSettings
>()('@yolk-sdk/agent/providers/openai/conformance/OpenAiCodexConformanceConfig') {}

/** What every Codex conformance case requires from the host. */
export type OpenAiCodexConformanceRequirements =
  | HttpClient.HttpClient
  | OpenAiCodexConformanceConfig

export type OpenAiCodexConformanceCase = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  OpenAiCodexConformanceRequirements
>

const codexCases = makeResponsesConformanceCases({
  idPrefix: 'openai.codex',
  providerName: 'OpenAI Codex',
  endpointLabel: 'The ChatGPT Codex Responses endpoint',
  settings: Effect.service(OpenAiCodexConformanceConfig),
  models: settings => settings.models,
  providerLayer: settings => makeOpenAiCodexProviderLayer({ token: settings.token }),
  fixtures: {
    plainText: openAiCodexPlainTextFixture.id,
    functionCallArguments: openAiCodexFunctionCallArgumentsFixture.id,
    errorEnvelope: openAiCodexErrorEnvelopeFixture.id,
    terminalEvent: openAiCodexTerminalEventFixture.id
  },
  requestDocs:
    'The Codex provider always sends `reasoning: { effort, summary: "auto" }`, `store: false`, and `stream: true`, and never an output limit, so a reasoning summary item may stream before the message.',
  terminalDocs:
    'The Codex provider keeps EOF-completion compatibility: a stream that ends without `response.completed` still completes with Done (without usage), so this case reads the body to prove the endpoint sends the terminal event.'
})

export const openAiCodexPlainTextCase: OpenAiCodexConformanceCase = codexCases.plainText

export const openAiCodexFunctionCallArgumentsCase: OpenAiCodexConformanceCase =
  codexCases.functionCallArguments

export const openAiCodexErrorEnvelopeCase: OpenAiCodexConformanceCase = codexCases.errorEnvelope

export const openAiCodexTerminalEventCase: OpenAiCodexConformanceCase = codexCases.terminalEvent

/** Every Codex Responses conformance case, in fixture order. */
export const openAiCodexConformanceCases: ReadonlyArray<OpenAiCodexConformanceCase> = [
  openAiCodexPlainTextCase,
  openAiCodexFunctionCallArgumentsCase,
  openAiCodexErrorEnvelopeCase,
  openAiCodexTerminalEventCase
]
