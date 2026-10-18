import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect";
import type { EmptyRelations } from "drizzle-orm/relations";
import { migrate } from "drizzle-orm/sqlite-core/effect/session";
import type { SQLiteEffectSession } from "drizzle-orm/sqlite-core/effect/session";

import migrations from "./migrations.json" with { type: "json" };

export {
  clientState,
  libraryItem,
  libraryRemoteTrack,
  playEvent,
  playlist,
  playlistEntry,
  recording,
  source,
  sourceKey,
  sourceVariant,
  syncQueue,
  syncScope,
} from "./schema.ts";

/** Runs the client migrations from the bundle, so that a client needs no migrations folder */
export const migrateClientDatabase = <H extends QueryEffectHKTBase>(db: {
  readonly _: { readonly session: SQLiteEffectSession<unknown, H, EmptyRelations> };
}) => migrate(migrations, db._.session);
