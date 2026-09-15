import { layerConfig } from '@effect/sql-pg/PgClient'
import { Config, Context, Layer } from 'effect'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { refineCodecs } from 'drizzle-orm/codecs'
import { castToText } from 'drizzle-orm/pg-core/codecs'
import { relations } from './schema'

// Effect PG returns unknown enum/vector OIDs as binary bytes. Select text so
// Drizzle receives enum labels and can apply its existing vector normalizer.
const codecs = refineCodecs(PgDrizzle.effectPgCodecs, {
  enum: { cast: castToText },
  vector: { cast: castToText }
})

// PostgreSQL connection layer (internal)
const PgLive = layerConfig({
  url: Config.Redacted('DATABASE_URL')
})

// Service definition
export class Db extends Context.Service<Db>()('@app/Db', {
  make: PgDrizzle.make({ relations, codecs })
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide(PgDrizzle.DefaultServices),
    Layer.provide(PgLive)
  )
}
