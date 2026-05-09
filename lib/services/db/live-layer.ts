import { layerConfig } from '@effect/sql-pg/PgClient'
import { Config, Context, Layer } from 'effect'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { relations } from './schema'

// PostgreSQL connection layer (internal)
const PgLive = layerConfig({
  url: Config.redacted('DATABASE_URL')
})

// Service definition
export class Db extends Context.Service<Db>()('@app/Db', {
  make: PgDrizzle.make({ relations })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(PgDrizzle.DefaultServices),
    Layer.provide(PgLive)
  )
}
