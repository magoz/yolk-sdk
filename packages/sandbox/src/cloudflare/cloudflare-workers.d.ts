// The part of workerd's `cloudflare:workers` module `./durable-object.ts` uses, for this package's
// own type check only (not shipped: hosts type `cloudflare:workers` with their own Workers types).
// `@cloudflare/workers-types` declares Web globals that clash with the DOM library the workspace
// type-checks against, so this structural declaration stands in for it. The root `tsconfig.json`
// excludes this file: there, `@yolk-sdk/vercel-workflows` declares the same class, and
// `./durable-object.ts` reads `this.ctx` as `unknown` so either declaration type-checks it.
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: unknown
    protected readonly env: Env
    constructor(ctx: unknown, env: Env)
  }
}
