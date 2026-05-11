import * as Cloudflare from 'alchemy/Cloudflare'

export class Api extends Cloudflare.Worker<Api>()(
  'Api',
  {
    main: './src/api-runtime.ts',
    observability: { enabled: true }
  }
) {}

export default Api
