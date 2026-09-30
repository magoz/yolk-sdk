/**
 * Subscription-usage recordings the `/anthropic`, `/codex`, and `/xai` usage routes answer from.
 *
 * Copied as data from the committed (synthetic, unverified) conformance fixtures; never imported.
 * `test/fixture-recordings.test.ts` fails when a fixture changes and this copy does not. Internal;
 * not a package export.
 */
import type { FixtureRecording } from './fixture-route.ts'

export const anthropicClaudeUsageRecording: FixtureRecording = {
  fixtureId: 'anthropic.claude.usage.snapshot.synthetic',
  caseId: 'anthropic.claude.usage.snapshot',
  request: {
    method: 'GET',
    path: '/api/oauth/usage',
    query: '',
    headers: {
      accept: 'application/json'
    }
  },
  response: {
    status: 200,
    headers: {
      'content-type': 'application/json'
    },
    streamed: false,
    chunks: [
      '{"five_hour":{"utilization":18,"resets_at":"2026-10-01T05:00:00.000Z"},"seven_day":{"utilization":42,"resets_at":"2026-10-06T00:00:00.000Z"}}'
    ]
  }
}

export const codexUsageRecording: FixtureRecording = {
  fixtureId: 'openai.codex.usage.snapshot.synthetic',
  caseId: 'openai.codex.usage.snapshot',
  request: {
    method: 'GET',
    path: '/backend-api/wham/usage',
    query: '',
    headers: {
      accept: 'application/json'
    }
  },
  response: {
    status: 200,
    headers: {
      'content-type': 'application/json'
    },
    streamed: false,
    chunks: [
      '{"rate_limit":{"primary_window":{"used_percent":23,"limit_window_seconds":18000,"reset_after_seconds":7200,"reset_at":1790007200},"secondary_window":{"used_percent":51,"limit_window_seconds":604800,"reset_after_seconds":259200,"reset_at":1790259200}}}'
    ]
  }
}

export const xAiGrokUsageRecording: FixtureRecording = {
  fixtureId: 'xai.grok.usage.snapshot.synthetic',
  caseId: 'xai.grok.usage.snapshot',
  request: {
    method: 'GET',
    path: '/v1/billing',
    query: '?format=credits',
    headers: {
      accept: 'application/json'
    }
  },
  response: {
    status: 200,
    headers: {
      'content-type': 'application/json'
    },
    streamed: false,
    chunks: [
      '{"config":{"creditUsagePercent":37.5,"currentPeriod":{"type":"monthly","start":"2026-09-01T00:00:00.000Z","end":"2026-10-01T00:00:00.000Z"}}}'
    ]
  }
}
