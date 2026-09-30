import type { R2ConformanceSeeds } from './cases.ts'

/**
 * Seeds of the synthetic practice bucket the committed R2 fixtures describe. Replaying the
 * fixtures needs these exact seeds in `R2ConformanceConfig`; a live run supplies the practice
 * bucket's own values (through a host implementation of `R2Presigner` and `R2ObjectClient`).
 */
export const r2ConformanceFixtureSeeds: R2ConformanceSeeds = {
  endpoint: 'https://synthetic-account.r2.example.test',
  bucket: 'yolk-synthetic-bucket',
  objectKey: 'fixtures/synthetic-object.txt',
  runId: 'run-synthetic'
}
