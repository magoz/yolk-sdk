// The part of workerd's `cloudflare:workers` module `./cloudflare.ts` uses, for this package's own
// type check only (not shipped: hosts type `cloudflare:workers` with their own Workers types).
// `@cloudflare/workers-types` declares Web globals that clash with the DOM library the workspace
// type-checks against, so this structural declaration stands in for it.
declare module 'cloudflare:workers' {
  export abstract class RpcTarget {
    constructor()
  }
}
