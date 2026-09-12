import { Context, Layer } from 'effect'

export type LoopConfigSettings = {
  readonly maxTurns: number
  readonly maxRetries: number
  readonly retryBaseDelayMs: number
  readonly toolConcurrency: number
}

export class LoopConfig extends Context.Service<LoopConfig, LoopConfigSettings>()(
  '@yolk-sdk/agent/loop/LoopConfig'
) {
  static layer = (config: LoopConfigSettings) => Layer.succeed(this, config)
  static defaultLayer = this.layer({
    maxTurns: 500,
    maxRetries: 2,
    retryBaseDelayMs: 2000,
    toolConcurrency: 4
  })
}
