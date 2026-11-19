// `cloudflare:workers` for the package's Vitest (aliased in `vitest.config.ts`).

export abstract class DurableObject<Env = unknown> {
  protected readonly ctx: unknown
  protected readonly env: Env

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
