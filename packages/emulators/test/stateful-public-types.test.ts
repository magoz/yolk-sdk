/**
 * Compile coverage of the public Todoist and Telegram fault and ledger types (checked by `tsc`):
 * the type aliases the subpaths exported before they moved onto the shared stateful wrapper still
 * exist and take values of the same shape. The ledger entries take a `status` fault only and no
 * `headers` field. The runtime assertions decode the schema values of the same names.
 */
import { Result } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  TelegramFault,
  TelegramFaultMatch,
  type TelegramCoverage,
  type TelegramFaultState,
  type TelegramLedgerEntry
} from '../src/telegram.ts'
import {
  TodoistFault,
  TodoistFaultMatch,
  type TodoistCoverage,
  type TodoistFaultState,
  type TodoistLedgerEntry
} from '../src/todoist.ts'

const todoistMatch: TodoistFaultMatch = {
  method: 'POST',
  path: '/api/v1/tasks',
  route: '/api/v1/tasks'
}

const todoistFault: TodoistFault = { kind: 'status', status: 429, match: todoistMatch, count: 1 }

const todoistFaultState: TodoistFaultState = {
  id: 1,
  fault: todoistFault,
  remaining: 1,
  applied: 0
}

const todoistEntry: TodoistLedgerEntry = {
  seq: 1,
  method: 'POST',
  path: '/api/v1/tasks',
  route: '/api/v1/tasks',
  query: {},
  body: { content: 'x' },
  status: 429,
  evidence: 'unverified',
  fault: 'status'
}

const todoistCoverage: TodoistCoverage = {
  routes: [],
  unknownRouteRequests: 0,
  notEmulatedRequests: 0
}

const telegramMatch: TelegramFaultMatch = { path: '/bot<redacted>/getChat' }

const telegramFault: TelegramFault = { kind: 'status', status: 503, match: telegramMatch }

const telegramFaultState: TelegramFaultState = {
  id: 1,
  fault: telegramFault,
  remaining: undefined,
  applied: 0
}

const telegramEntry: TelegramLedgerEntry = {
  seq: 1,
  method: '<other>',
  path: '/<unrecognised>',
  query: {},
  status: 400,
  evidence: 'unknown-route',
  notEmulated: 'no emulated Bot API route for this method and path'
}

const telegramCoverage: TelegramCoverage = {
  routes: [],
  unknownRouteRequests: 1,
  notEmulatedRequests: 1
}

// The ledger fault field stays the status fault these emulators take.
const statusFaults: ReadonlyArray<'status' | undefined> = [todoistEntry.fault, telegramEntry.fault]

const truncated: TodoistLedgerEntry = {
  ...todoistEntry,
  // @ts-expect-error -- a status-only emulator records no truncation fault
  fault: 'truncate-after-chunks'
}

const withHeaders: TelegramLedgerEntry = {
  ...telegramEntry,
  // @ts-expect-error -- the entries carry no headers field
  headers: {}
}

describe('public Todoist and Telegram fault and ledger types', () => {
  it('decode the schema values of the same names', () => {
    expect([
      Result.isSuccess(Schema.decodeUnknownResult(TodoistFaultMatch)(todoistMatch)),
      Result.isSuccess(Schema.decodeUnknownResult(TodoistFault)(todoistFaultState.fault)),
      Result.isSuccess(Schema.decodeUnknownResult(TelegramFaultMatch)(telegramMatch)),
      Result.isSuccess(Schema.decodeUnknownResult(TelegramFault)(telegramFaultState.fault))
    ]).toEqual([true, true, true, true])
    expect(statusFaults).toEqual(['status', undefined])
    expect([todoistCoverage, telegramCoverage, truncated, withHeaders]).toHaveLength(4)
  })
})
