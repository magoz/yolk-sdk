/**
 * xAI Grok (subscription, CLI proxy) Responses conformance cases for
 * `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the public Grok provider (`makeXAiGrokProviderLayer`: Bearer OAuth plus
 * `X-XAI-Token-Auth`, `x-grok-model-override`, and the host-owned `x-grok-client-version`, the
 * default `https://cli-chat-proxy.grok.com/v1/responses` endpoint, the host output limit as
 * `max_output_tokens`, and a required terminal event) from `XAiGrokConformanceConfig`, sends one
 * request through `LLMProvider`, and asserts one wire claim from the events it sees (and, for the
 * error and terminal-event cases, from the raw body read at the case's own `HttpClient`
 * boundary). The cases share their shape with the Codex Responses cases
 * (`providers/openai/conformance`), which run the same private Responses parser. Cases need only
 * `HttpClient.HttpClient` and the config service, so the same case runs against replayed fixtures
 * (`ReplayHttpClient`), an emulator, or a host's live `HttpClient`. All four are `read` cases;
 * none is observed live yet (`observed` absent = unverified).
 */
import { Context, Effect } from 'effect'
import type { HttpClient } from 'effect/http'
import type { ConformanceCase, ConformanceMismatch } from '@yolk-sdk/conformance/case'
import type { LLMProviderError } from '@yolk-sdk/agent/loop'
import type { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import {
  makeResponsesConformanceCases,
  type ResponsesConformanceModels
} from '../../openai/conformance/responses-cases-internal.ts'
import { xAiGrokResponsesUrl } from '../grok.ts'
import { makeXAiGrokProviderLayer } from '../grok-provider.ts'
import { xAiGrokErrorEnvelopeFixture } from './error-envelope.ts'
import { xAiGrokFunctionCallArgumentsFixture } from './function-call-arguments.ts'
import { xAiGrokPlainTextFixture } from './plain-text.ts'
import { xAiGrokTerminalEventFixture } from './terminal-event.ts'

/** The Grok CLI proxy Responses endpoint the cases (and the provider's default) call. */
export const xAiGrokConformanceResponsesUrl = xAiGrokResponsesUrl

/** Model ids per case. `invalid` must NOT exist on the Grok CLI proxy. */
export type XAiGrokConformanceModels = ResponsesConformanceModels

/** Model ids used by the committed fixtures and the live probe defaults. */
export const xAiGrokConformanceDefaultModels: XAiGrokConformanceModels = {
  plainText: 'grok-build',
  toolCall: 'grok-build',
  invalid: 'yolk-conformance-model-does-not-exist'
}

export type XAiGrokConformanceSettings = {
  /**
   * Grok subscription OAuth access token (provider `xai-grok`, unexpired), sent as
   * `Authorization: Bearer`. Any value works under replay or an emulator.
   */
  readonly token: OAuthAccessToken
  /**
   * Truthful host client version sent as `x-grok-client-version` (the proxy version-gates
   * requests with HTTP 426). Never impersonate an official Grok client version.
   */
  readonly clientVersion: string
  /** Sent as `max_output_tokens`. */
  readonly maxOutputTokens: number
  readonly models: XAiGrokConformanceModels
}

/** Host-supplied settings for the Grok Responses conformance cases. */
export class XAiGrokConformanceConfig extends Context.Service<
  XAiGrokConformanceConfig,
  XAiGrokConformanceSettings
>()('@yolk-sdk/agent/providers/xai/conformance/XAiGrokConformanceConfig') {}

/** What every Grok conformance case requires from the host. */
export type XAiGrokConformanceRequirements = HttpClient.HttpClient | XAiGrokConformanceConfig

export type XAiGrokConformanceCase = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  XAiGrokConformanceRequirements
>

const grokCases = makeResponsesConformanceCases({
  idPrefix: 'xai.grok',
  providerName: 'xAI Grok subscription',
  endpointLabel: 'The xAI Grok CLI proxy Responses endpoint',
  settings: Effect.service(XAiGrokConformanceConfig),
  models: settings => settings.models,
  providerLayer: settings =>
    makeXAiGrokProviderLayer({
      token: settings.token,
      clientVersion: settings.clientVersion,
      maxOutputTokens: settings.maxOutputTokens
    }),
  fixtures: {
    plainText: xAiGrokPlainTextFixture.id,
    functionCallArguments: xAiGrokFunctionCallArgumentsFixture.id,
    errorEnvelope: xAiGrokErrorEnvelopeFixture.id,
    terminalEvent: xAiGrokTerminalEventFixture.id
  },
  requestDocs:
    'The Grok provider sends `store: false`, `stream: true`, and the host output limit as `max_output_tokens`, and sends `reasoning` only when a reasoning effort is set (never in these cases).',
  terminalDocs:
    'The Grok provider requires the terminal event: a stream that ends without `response.completed` fails with a non-retryable `invalid_response` (`incomplete_stream`) and never emits Done.'
})

export const xAiGrokPlainTextCase: XAiGrokConformanceCase = grokCases.plainText

export const xAiGrokFunctionCallArgumentsCase: XAiGrokConformanceCase =
  grokCases.functionCallArguments

export const xAiGrokErrorEnvelopeCase: XAiGrokConformanceCase = grokCases.errorEnvelope

export const xAiGrokTerminalEventCase: XAiGrokConformanceCase = grokCases.terminalEvent

/** Every Grok Responses conformance case, in fixture order. */
export const xAiGrokConformanceCases: ReadonlyArray<XAiGrokConformanceCase> = [
  xAiGrokPlainTextCase,
  xAiGrokFunctionCallArgumentsCase,
  xAiGrokErrorEnvelopeCase,
  xAiGrokTerminalEventCase
]
