import { Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { expectTypeOf } from 'vitest'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import {
  DrainToken,
  HitlDecision,
  Inbox,
  ParkGeneration,
  PauseDecision,
  type InboxApi,
  type HitlAdmission
} from '../src/inbox.ts'

const HitlAdmissionFromWire = Schema.Struct({
  itemId: Schema.String,
  requestId: Schema.String,
  generation: ParkGeneration
})

describe('harness branded tokens', () => {
  it('keeps DrainToken and ParkGeneration nominally incompatible', () => {
    const token = DrainToken.make('d1')
    const generation = ParkGeneration.make('1')

    // Brands keep their string wire representation.
    const wire: string = token
    expect(wire).toBe('d1')
    expect(generation).toBe('1')

    const backToToken: DrainToken = token
    expect(backToToken).toBe('d1')

    // @ts-expect-error - DrainToken is not a ParkGeneration
    const mismatchGeneration: ParkGeneration = token
    // @ts-expect-error - ParkGeneration is not a DrainToken
    const mismatchToken: DrainToken = generation
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const tokenFromString: DrainToken = 'd1'
    // @ts-expect-error - unbranded strings require minting through the canonical schema
    const generationFromString: ParkGeneration = '1'

    expect([mismatchGeneration, mismatchToken, tokenFromString, generationFromString]).toHaveLength(
      4
    )
  })

  it('requires branded tokens at inbox contracts (checked by pnpm tsc)', () => {
    expectTypeOf<Parameters<InboxApi['takePromotable']>[2]>().toEqualTypeOf<DrainToken>()
    expectTypeOf<Parameters<InboxApi['park']>[2]>().toEqualTypeOf<DrainToken>()
    expectTypeOf<Parameters<InboxApi['endDrain']>[1]>().toEqualTypeOf<DrainToken>()
    expectTypeOf<Parameters<InboxApi['clearPark']>[1]>().toEqualTypeOf<ParkGeneration>()
    expectTypeOf<HitlAdmission['generation']>().toEqualTypeOf<ParkGeneration>()
    expectTypeOf<string>().not.toExtend<DrainToken>()
    expectTypeOf<string>().not.toExtend<ParkGeneration>()
  })

  it.effect('roundtrips token brands through their encoded string form', () =>
    Effect.gen(function* () {
      const token = yield* Schema.decodeUnknownEffect(DrainToken)('d7')
      expect(yield* Schema.encodeEffect(DrainToken)(token)).toBe('d7')

      const generation = yield* Schema.decodeUnknownEffect(ParkGeneration)('3')
      expect(yield* Schema.encodeEffect(ParkGeneration)(generation)).toBe('3')

      // These are nominal identities, not format/freshness proofs. Keep all string
      // inputs compatible; the inbox decides whether a token is live below.
      for (const raw of ['', ' ', 'foreign-token']) {
        expect(yield* Schema.decodeUnknownEffect(DrainToken)(raw)).toBe(raw)
        expect(yield* Schema.decodeUnknownEffect(ParkGeneration)(raw)).toBe(raw)
      }

      for (const raw of [null, 42, {}]) {
        expect(
          Result.isFailure(yield* Schema.decodeUnknownEffect(DrainToken)(raw).pipe(Effect.result))
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(ParkGeneration)(raw).pipe(Effect.result)
          )
        ).toBe(true)
      }

      // Token brands stay wire-compatible plain strings: unknown shapes still fail,
      // while stale/ownership decisions stay logic-level checks below.
      const missing = yield* Schema.decodeUnknownEffect(HitlAdmissionFromWire)({
        itemId: 'item_1',
        requestId: 'req_1'
      }).pipe(Effect.result)

      expect(Result.isFailure(missing)).toBe(true)

      const admission = yield* Schema.decodeUnknownEffect(HitlAdmissionFromWire)({
        itemId: 'item_1',
        requestId: 'req_1',
        generation: '9'
      })

      expect(admission.generation).toBe('9')

      const wire: string = admission.generation
      expect(wire).toBe('9')
    })
  )

  it.effect('keeps stale-generation and wrong-token checks at the logic level', () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      yield* inbox.enqueue({ id: 'item_1', runId: 'run_1', delivery: 'input', kind: 'input' })
      expect(yield* inbox.wakeIfUnblocked('run_1', 'input', Effect.void)).toBe(true)
      const begun = yield* inbox.beginDrain('run_1', 'input')
      expect(Predicate.isTagged(begun, 'Run')).toBe(true)

      if (!Predicate.isTagged(begun, 'Run')) return

      // Forged tokens are representable but never authorized: the live drain token
      // still owns the dequeue, and a foreign endDrain is a no-op.
      expect(
        yield* inbox.takePromotable('run_1', 'input', DrainToken.make('d-forged'))
      ).toBeUndefined()
      expect(yield* inbox.pending('run_1')).toHaveLength(1)
      yield* inbox.endDrain('run_1', DrainToken.make('d-forged'), true)
      expect((yield* inbox.takePromotable('run_1', 'input', begun.drainToken))?.id).toBe('item_1')

      const parked = yield* inbox.park('run_1', ['req_1'], begun.drainToken)
      expect(Predicate.isTagged(parked, 'Parked')).toBe(true)

      if (!Predicate.isTagged(parked, 'Parked')) return

      // A well-formed but stale generation decodes yet is rejected by freshness logic.
      const staleAdmission = yield* Schema.decodeUnknownEffect(HitlAdmissionFromWire)({
        itemId: 'item_1',
        requestId: 'req_1',
        generation: 'stale'
      })

      expect(yield* inbox.acceptHitl('run_1', staleAdmission, Effect.void)).toEqual(
        HitlDecision.Stale()
      )
      expect(yield* inbox.clearPark('run_1', ParkGeneration.make('stale'))).toBe(false)
      expect(
        yield* inbox.acceptHitl(
          'run_1',
          { itemId: 'item_1', requestId: 'req_1', generation: parked.generation },
          Effect.void
        )
      ).toEqual(HitlDecision.Ready())
      expect(PauseDecision.$is('Parked')(parked)).toBe(true)
    }).pipe(Effect.provide(makeInMemoryHarnessLayer()))
  )

  it.effect('isolates drain tokens across runs', () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox
      yield* inbox.enqueue({ id: 'item_1', runId: 'run_1', delivery: 'input', kind: 'input' })
      yield* inbox.enqueue({ id: 'other_1', runId: 'run_2', delivery: 'input', kind: 'input' })
      expect(yield* inbox.wakeIfUnblocked('run_1', 'input', Effect.void)).toBe(true)
      expect(yield* inbox.wakeIfUnblocked('run_2', 'input', Effect.void)).toBe(true)
      const first = yield* inbox.beginDrain('run_1', 'input')
      const second = yield* inbox.beginDrain('run_2', 'input')
      expect(Predicate.isTagged(first, 'Run')).toBe(true)
      expect(Predicate.isTagged(second, 'Run')).toBe(true)

      if (!Predicate.isTagged(first, 'Run') || !Predicate.isTagged(second, 'Run')) return
      expect(first.drainToken).not.toBe(second.drainToken)
      expect(yield* inbox.takePromotable('run_1', 'input', second.drainToken)).toBeUndefined()
      expect((yield* inbox.takePromotable('run_1', 'input', first.drainToken))?.id).toBe('item_1')
    }).pipe(Effect.provide(makeInMemoryHarnessLayer()))
  )
})
