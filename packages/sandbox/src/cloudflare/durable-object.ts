import { DurableObject } from 'cloudflare:workers'
import { Predicate } from 'effect'
import {
  isCloudflareContainer,
  isCloudflareSandboxStorage,
  makeCloudflareSandboxEngine,
  type CloudflareSandboxEngine
} from './engine.ts'
import type {
  CloudflareSandboxReadFileInput,
  CloudflareSandboxReadFileOutput,
  CloudflareSandboxReply,
  CloudflareSandboxRunInput,
  CloudflareSandboxRunOutput,
  CloudflareSandboxStatus,
  CloudflareSandboxWriteFileInput
} from './protocol.ts'

/**
 * The Durable Object behind `@yolk-sdk/sandbox/cloudflare`: one sandbox container per object
 * (named by `makeSandboxName(sandboxSessionId)`). Re-export it from the Worker entry, declare it
 * as a SQLite class, and bind it to a container application with the `durable_object` scheduling
 * policy; one class can carry several images (keys of `ctx.container.images`). The object is
 * engine-only: image, resources, env, internet access and lifecycle arrive with every call from
 * the layer's config.
 *
 * Subclass it to act on each new container, e.g. to route its outbound HTTP through a Worker with
 * `this.ctx.container.interceptAllOutboundHttp(...)` in `containerStarted`.
 */
export class CloudflareSandbox<Env = unknown> extends DurableObject<Env> {
  private engineInstance: CloudflareSandboxEngine | undefined

  private get engine(): CloudflareSandboxEngine {
    if (this.engineInstance !== undefined) return this.engineInstance

    const ctx: unknown = this.ctx
    const storage = Predicate.hasProperty(ctx, 'storage') ? ctx.storage : undefined
    const container = Predicate.hasProperty(ctx, 'container') ? ctx.container : undefined

    if (!isCloudflareSandboxStorage(storage)) {
      throw new Error('CloudflareSandbox needs Durable Object storage')
    }

    this.engineInstance = makeCloudflareSandboxEngine({
      container: isCloudflareContainer(container) ? container : undefined,
      storage,
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
      fetch: url => fetch(url),
      containerStarted: () => this.containerStarted()
    })

    return this.engineInstance
  }

  /** Runs after each container start, before the workspace is prepared. No-op by default. */
  protected async containerStarted(): Promise<void> {}

  async run(
    input: CloudflareSandboxRunInput
  ): Promise<CloudflareSandboxReply<CloudflareSandboxRunOutput>> {
    return this.engine.run(input)
  }

  async writeFile(input: CloudflareSandboxWriteFileInput): Promise<CloudflareSandboxReply<null>> {
    return this.engine.writeFile(input)
  }

  async readFile(
    input: CloudflareSandboxReadFileInput
  ): Promise<CloudflareSandboxReply<CloudflareSandboxReadFileOutput>> {
    return this.engine.readFile(input)
  }

  async status(): Promise<CloudflareSandboxStatus> {
    return this.engine.status()
  }

  async destroy(): Promise<void> {
    return this.engine.destroy()
  }

  async alarm(): Promise<void> {
    return this.engine.alarm()
  }
}
