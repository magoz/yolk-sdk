// `cloudflare:workers` for the package's Vitest (aliased in `vitest.config.ts`): what the
// Cloudflare runtime imports from it, with an `env` tests fill with fake bindings.

export abstract class DurableObject<Env = unknown> {
  protected readonly ctx: unknown
  protected readonly env: Env

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export const env = {}
