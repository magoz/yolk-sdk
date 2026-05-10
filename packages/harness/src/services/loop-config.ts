import { Context, Layer } from 'effect'

export type LoopConfigShape = {
  readonly maxTurns: number
}

export class LoopConfig extends Context.Service<LoopConfig, LoopConfigShape>()(
  '@yolk/harness/LoopConfig'
) {
  static layer = (config: LoopConfigShape) => Layer.succeed(this, config)
  static defaultLayer = this.layer({ maxTurns: 500 })
}
