import * as Schema from 'effect/Schema'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const EpochMs = Schema.Finite

/** A host-chosen account id, unique within the accounts a store serves. */
export const PoolAccountId = NonEmptyTrimmedString

/**
 * The account currently serving one route of a pool. A route is a lowercased model id, so every
 * reasoning effort of a model shares one pin.
 */
export class PoolPin extends Schema.Class<PoolPin>('PoolPin')({
  poolId: NonEmptyTrimmedString,
  route: NonEmptyTrimmedString,
  accountId: PoolAccountId,
  pinnedAtMs: EpochMs
}) {}

/** The account's subscription quota is exhausted until `untilMs` (a provider quota reset). */
export class PoolQuotaCooldown extends Schema.TaggedClass<PoolQuotaCooldown>()(
  'PoolQuotaCooldown',
  {
    accountId: PoolAccountId,
    startedAtMs: EpochMs,
    untilMs: EpochMs
  }
) {}

/** The provider rejected the account's credentials; it sits out until `untilMs`. */
export class PoolAuthCooldown extends Schema.TaggedClass<PoolAuthCooldown>()('PoolAuthCooldown', {
  accountId: PoolAccountId,
  startedAtMs: EpochMs,
  untilMs: EpochMs
}) {}

/**
 * Why an account sits out. One cooldown per account: writing keeps the one that ends later (on a
 * tie, the one that started later; see `PoolStoreApi.putCooldown`), and a reading can clear only a
 * quota cooldown it postdates.
 */
export const PoolCooldown = Schema.Union([PoolQuotaCooldown, PoolAuthCooldown])

export type PoolCooldown = typeof PoolCooldown.Type

/** A pool store operation failed. The pool degrades to stateless fill-first routing on reads. */
export class PoolStoreError extends Schema.TaggedError<PoolStoreError>()('PoolStoreError', {
  operation: Schema.Literals([
    'load',
    'movePin',
    'putCooldown',
    'clearCooldown',
    'putReading',
    'state'
  ]),
  message: Schema.String
}) {}

/** `makePool` rejected its configuration. */
export class PoolConfigError extends Schema.TaggedError<PoolConfigError>()('PoolConfigError', {
  reason: Schema.Literals([
    'invalid_pool_id',
    'no_accounts',
    'invalid_account_id',
    'duplicate_account_id',
    'invalid_priority',
    'invalid_max_age',
    'invalid_reserve_percent'
  ]),
  message: Schema.String
}) {}

/** A reading or lookup named an account the pool was not configured with. */
export class PoolUnknownAccountError extends Schema.TaggedError<PoolUnknownAccountError>()(
  'PoolUnknownAccountError',
  {
    poolId: Schema.String,
    accountId: Schema.String
  }
) {}
