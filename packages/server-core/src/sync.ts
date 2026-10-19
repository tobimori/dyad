import { orDieOnDatabaseError } from "@dyad/db/node";
import { SyncHint } from "@dyad/domain";
import { Context, Effect, Layer, PubSub, Ref, Schedule, Stream } from "effect";

import { currentChangeSeq } from "./sync-counter.ts";

/** Publishes after each commit that took a `change_seq` */
export class SyncHub extends Context.Service<SyncHub, PubSub.PubSub<void>>()(
  "@dyad/server-core/SyncHub",
) {}

// Writers do not publish: then `insertPlay` would need the hub, and a hint could come before the
// commit. The counter changes only with a commit.
export const syncHubLayer = Layer.effect(
  SyncHub,
  Effect.gen(function* () {
    const hub = yield* PubSub.sliding<void>(1);

    const counter = currentChangeSeq.pipe(orDieOnDatabaseError("watchSync"));
    const last = yield* Ref.make(yield* counter);

    yield* counter.pipe(
      Effect.flatMap((value) =>
        Ref.getAndSet(last, value).pipe(Effect.map((old) => old !== value)),
      ),
      Effect.flatMap((changed) => (changed ? PubSub.publish(hub, undefined) : Effect.void)),
      Effect.repeat(Schedule.spaced("250 millis")),
      Effect.forkScoped,
    );
    return hub;
  }),
);

/** A hint after the subscription, then at most one hint per 250 ms after changes */
export const watchChanges = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(yield* SyncHub);

    return Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)).pipe(
      Stream.map(() => new SyncHint()),
    );
  }),
);
