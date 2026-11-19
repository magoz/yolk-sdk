---
'@yolk-sdk/pool': minor
---

`putCooldown` keeps the newest failure with the cooldown it keeps. When an account already cooling down failed again with a cooldown that ends sooner (a quota error or rejected credentials from a concurrent request, or from the loop's retry after a failed store read), the store kept the longer cooldown with its old `startedAtMs`, so a reading taken between the two failures cleared it and the next request went straight back to the account that had just failed (#301). The kept cooldown now takes the later `startedAtMs` of the two, so only a reading taken after the latest failure can clear it, and it is a `PoolAuthCooldown` when either failure was auth, so no reading clears an auth failure that a longer quota cooldown absorbed (the account then sits out until the later end). `clearCooldown` now removes only a `PoolQuotaCooldown`: two failures in the same millisecond share a start, so a clear observed on the quota cooldown could otherwise remove the auth cooldown it became.

Store contract change: every host `PoolStoreApi` must now merge cooldowns this way in `putCooldown` (keep the later-ending one, with the later `startedAtMs` of the two, as an auth cooldown when either is auth) and refuse to clear an auth cooldown in `clearCooldown`. `makeMemoryPoolStore` does, and `poolStoreContract` checks both; rerun the contract against your store.
