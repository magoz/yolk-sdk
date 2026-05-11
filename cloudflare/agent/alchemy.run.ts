import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import ApiLive, { Api } from './src/api.ts'

export default Alchemy.Stack(
  'YolkAgentWorker',
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState()
  },
  Effect.gen(function* () {
    const api = yield* Api

    return {
      url: api.url.as<string>()
    }
  }).pipe(Effect.provide(ApiLive))
)
