import { Context, Layer } from 'effect'

export type LoopConfigShape = {
  readonly maxTurns: number
  readonly maxRetries: number
  readonly retryBaseDelayMs: number
}

export class LoopConfig extends Context.Service<LoopConfig, LoopConfigShape>()(
  '@yolk/agent-loop/LoopConfig'
) {
  static layer = (config: LoopConfigShape) => Layer.succeed(this, config)
  static defaultLayer = this.layer({ maxTurns: 500, maxRetries: 2, retryBaseDelayMs: 1000 })
}
