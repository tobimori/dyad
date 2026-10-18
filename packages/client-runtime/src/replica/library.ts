import { artist, libraryItem, rating, recording } from "@dyad/db/client";
import { LibraryItemRow, LibraryItemSet, RatingRow, RatingSet, UserId } from "@dyad/domain";
import type { HybridLogicalClock, LibraryEntityType, SyncChange } from "@dyad/domain";
import { libraryItemId, ratingId } from "@dyad/sync";
import { and, eq, inArray, or } from "drizzle-orm";
import { Clock, Crypto, Effect } from "effect";

import { ClientDatabase } from "./database.ts";

// A merge makes two saved versions one entry, so an edit of the entry applies to all of them
const groupOf = (entityType: LibraryEntityType, entityIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    if (entityType === "release") return [...entityIds];

    const table = entityType === "recording" ? recording : artist;
    const found = yield* db
      .select({ id: table.id, mergedIntoId: table.mergedIntoId })
      .from(table)
      .where(inArray(table.id, [...entityIds]));
    const roots = [...new Set([...entityIds, ...found.map((row) => row.mergedIntoId ?? row.id)])];
    const members = yield* db
      .select({ id: table.id })
      .from(table)
      .where(or(inArray(table.id, roots), inArray(table.mergedIntoId, roots)));
    return [...new Set([...roots, ...members.map((row) => row.id)])];
  }).pipe(Effect.orDie);

const rowsOf = (entityType: LibraryEntityType, entityIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const group = yield* groupOf(entityType, entityIds);
    const items = yield* db
      .select()
      .from(libraryItem)
      .where(
        and(
          eq(libraryItem.entityType, entityType),
          inArray(libraryItem.entityId, group),
          eq(libraryItem.deleted, false),
        ),
      );
    const ratings = yield* db
      .select()
      .from(rating)
      .where(
        and(
          eq(rating.entityType, entityType),
          inArray(rating.entityId, group),
          eq(rating.favorite, true),
        ),
      );
    return { items, ratings };
  }).pipe(Effect.orDie);

const saveChange = (
  userId: UserId,
  target: {
    readonly entityType: LibraryEntityType;
    readonly entityId: string;
    readonly sourceId?: string | null;
    readonly ref?: string | null;
  },
  hlc: HybridLogicalClock,
) =>
  Effect.gen(function* () {
    const fields = {
      userId,
      entityType: target.entityType,
      entityId: target.entityId,
      origin: "user",
    };
    return new LibraryItemSet({
      kind: "library_item.set",
      schemaVersion: 1,
      row: new LibraryItemRow({
        table: "library_item",
        id: yield* libraryItemId(fields),
        ...fields,
        addedAt: yield* Clock.currentTimeMillis,
        hlc,
        deleted: false,
      }),
      sourceId: target.sourceId ?? null,
      ref: target.ref ?? null,
    });
  });

const ratingChange = (
  userId: UserId,
  target: { readonly entityType: LibraryEntityType; readonly entityId: string },
  favorite: boolean,
  hlc: HybridLogicalClock,
) =>
  Effect.gen(function* () {
    const fields = { userId, entityType: target.entityType, entityId: target.entityId };
    return new RatingSet({
      kind: "rating.set",
      schemaVersion: 1,
      row: new RatingRow({
        table: "rating",
        id: yield* ratingId(fields),
        ...fields,
        favorite,
        hlc,
      }),
    });
  });

/**
 * The library and favorite edits, as in streaming apps: a favorite is also in the library, a
 * removal from the library also removes the favorite, and a removed favorite stays in the library.
 * Each edit is one mutation. `sourceId` and `ref` let the server add a search result, an album or
 * an artist to the catalog.
 */
export const libraryEdits = <E>(
  mutate: <A>(
    build: (
      next: Effect.Effect<HybridLogicalClock>,
    ) => Effect.Effect<
      readonly [A, ReadonlyArray<SyncChange>],
      never,
      ClientDatabase | Crypto.Crypto
    >,
  ) => Effect.Effect<A>,
  owner: Effect.Effect<UserId, E>,
) => {
  const edit = (
    build: (
      userId: UserId,
      next: Effect.Effect<HybridLogicalClock>,
    ) => Effect.Effect<ReadonlyArray<SyncChange>, never, ClientDatabase | Crypto.Crypto>,
  ) =>
    Effect.gen(function* () {
      const userId = yield* owner;
      return yield* mutate((next) =>
        Effect.map(build(userId, next), (changes) => [undefined, changes] as const),
      );
    });

  return {
    /** Does nothing when a member of the entity's merge group is in the library */
    save: (target: {
      readonly entityType: LibraryEntityType;
      readonly entityId: string;
      readonly sourceId?: string | null;
      readonly ref?: string | null;
    }) =>
      edit((userId, next) =>
        Effect.gen(function* () {
          const { items } = yield* rowsOf(target.entityType, [target.entityId]);
          return items.length > 0 ? [] : [yield* saveChange(userId, target, yield* next)];
        }),
      ),
    /**
     * Removes the entities and the members of their merge groups from the library, from all
     * origins. The server removes an imported item on the provider when the provider can.
     */
    remove: (entityType: LibraryEntityType, entityIds: ReadonlyArray<string>) =>
      edit((userId, next) =>
        Effect.gen(function* () {
          const { items, ratings } = yield* rowsOf(entityType, entityIds);
          const removals = yield* Effect.forEach(items, (item) =>
            Effect.map(
              next,
              (hlc) =>
                new LibraryItemSet({
                  kind: "library_item.set",
                  schemaVersion: 1,
                  row: new LibraryItemRow({
                    table: "library_item",
                    id: item.id,
                    userId: UserId.make(item.userId),
                    entityType: item.entityType,
                    entityId: item.entityId,
                    origin: item.origin,
                    addedAt: item.addedAt,
                    hlc,
                    deleted: true,
                  }),
                  sourceId: null,
                  ref: null,
                }),
            ),
          );
          const unfavorites = yield* Effect.forEach(ratings, (row) =>
            Effect.flatMap(next, (hlc) => ratingChange(userId, row, false, hlc)),
          );
          return [...removals, ...unfavorites];
        }),
      ),
    /** Loves the entity and adds it to the library when it is not there */
    favorite: (target: {
      readonly entityType: LibraryEntityType;
      readonly entityId: string;
      readonly sourceId?: string | null;
      readonly ref?: string | null;
    }) =>
      edit((userId, next) =>
        Effect.gen(function* () {
          const { items, ratings } = yield* rowsOf(target.entityType, [target.entityId]);
          const save = items.length > 0 ? [] : [yield* saveChange(userId, target, yield* next)];
          const love =
            ratings.length > 0 ? [] : [yield* ratingChange(userId, target, true, yield* next)];
          return [...save, ...love];
        }),
      ),
    /** The entities stay in the library */
    unfavorite: (entityType: LibraryEntityType, entityIds: ReadonlyArray<string>) =>
      edit((userId, next) =>
        Effect.gen(function* () {
          const { ratings } = yield* rowsOf(entityType, entityIds);
          return yield* Effect.forEach(ratings, (row) =>
            Effect.flatMap(next, (hlc) => ratingChange(userId, row, false, hlc)),
          );
        }),
      ),
  };
};
