import { outputSetting } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import { Output, OutputId } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { OutputError, TimedOutput, TimedOutputs, UrlOutput, UrlOutputs } from "@dyad/plugin";
import type { OutputInfo } from "@dyad/plugin";
import { Context, Data, Deferred, Effect, Layer, PubSub, Stream } from "effect";

/** Port of the HTTP server. URL outputs open stream URLs on it. */
export class StreamPort extends Context.Service<StreamPort, number>()(
  "@dyad/server-core/StreamPort",
) {}

class Holder extends Data.Class<{
  readonly userId: UserId;
  /** Runs when another session opens the output */
  readonly taken: Effect.Effect<void>;
  readonly released: Deferred.Deferred<void>;
}> {}

const makeOutputs = Effect.gen(function* () {
  const db = yield* Database;
  const registrations = new Map<string, UrlOutputs | TimedOutputs>();
  const discovered = new Map<string, ReadonlyArray<OutputInfo>>();
  const holders = new Map<OutputId, Holder>();
  const opened = new Map<OutputId, UrlOutput | TimedOutput>();
  // The last volume and mute state that an open URL output reported, or that the core set on a
  // timed output
  const volumes = new Map<OutputId, number>();
  const mutes = new Map<OutputId, boolean>();
  const delays = new Map(
    (yield* db.select().from(outputSetting)).map((row) => [
      OutputId.make(row.outputId),
      row.delayMs,
    ]),
  );
  const changed = yield* PubSub.unbounded<void>();

  const notify = PubSub.publish(changed, undefined);

  const locate = (id: OutputId) => {
    const separator = id.indexOf(":");
    return { registration: id.slice(0, separator), nativeId: id.slice(separator + 1) };
  };

  /** Whether the last discovery of its plugin found the output */
  const has = (id: OutputId) => {
    const { registration, nativeId } = locate(id);
    return discovered.get(registration)?.some((info) => info.id === nativeId) === true;
  };

  /** Whether the output plays PCM at set times, so that it can be in a group */
  const isTimed = (id: OutputId) =>
    registrations.get(locate(id).registration) instanceof TimedOutputs;

  const list = () =>
    [...discovered].flatMap(([registration, infos]) =>
      infos.map((info) => {
        const id = OutputId.make(`${registration}:${info.id}`);
        return new Output({
          id,
          kind: registrations.get(registration) instanceof TimedOutputs ? "timed" : "url",
          name: info.name,
          volume: volumes.get(id) ?? null,
          muted: mutes.get(id) ?? false,
          delayMs: delays.get(id) ?? 0,
        });
      }),
    );

  /** Keeps the outputs of `registration` up to date until the scope closes */
  const follow = (registration: string, outputs: UrlOutputs | TimedOutputs) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => discovered.delete(registration)).pipe(Effect.andThen(notify)),
      );
      yield* outputs.discover.pipe(
        Stream.runForEach((infos) =>
          Effect.sync(() => discovered.set(registration, infos)).pipe(Effect.andThen(notify)),
        ),
        Effect.forkScoped,
      );
    });

  // The last holder wins. The earlier holder closes without a stop, so that its last commands come
  // before ours.
  const hold = (
    id: OutputId,
    holder: { readonly userId: UserId; readonly taken: Effect.Effect<void> },
  ) =>
    Effect.gen(function* () {
      const { registration, nativeId } = locate(id);
      const outputs = registrations.get(registration);
      if (outputs === undefined || !has(id)) {
        return yield* new OutputError({ reason: "The output is not available" });
      }

      const earlier = holders.get(id);
      if (earlier !== undefined) {
        yield* Effect.forkDetach(earlier.taken);
        yield* Deferred.await(earlier.released);
      }

      const released = yield* Deferred.make<void>();
      const entry = new Holder({ ...holder, released });
      holders.set(id, entry);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (holders.get(id) !== entry) return;
          holders.delete(id);
          opened.delete(id);
        }).pipe(Effect.andThen(Deferred.succeed(released, undefined))),
      );
      return { outputs, nativeId };
    });

  const kindError = new OutputError({ reason: "The output is of another kind" });

  /** Opens the URL output for the session of `userId` until the scope closes */
  const open = (
    id: OutputId,
    holder: { readonly userId: UserId; readonly taken: Effect.Effect<void> },
  ) =>
    Effect.gen(function* () {
      const { outputs, nativeId } = yield* hold(id, holder);
      if (!(outputs instanceof UrlOutputs)) return yield* kindError;

      const output = yield* outputs.open(nativeId);
      opened.set(id, output);
      return new UrlOutput({
        ...output,
        status: output.status.pipe(
          Stream.tap(({ volume, muted }) =>
            (volume === null || volumes.get(id) === volume) && (mutes.get(id) ?? false) === muted
              ? Effect.void
              : Effect.sync(() => {
                  if (volume !== null) volumes.set(id, volume);
                  mutes.set(id, muted);
                }).pipe(Effect.andThen(notify)),
          ),
        ),
      });
    });

  const rememberVolume = (id: OutputId, volume: number) =>
    Effect.sync(() => volumes.set(id, volume)).pipe(Effect.andThen(notify));

  /**
   * Opens the timed output like `open`. A timed device reports no volume, so the volume that the
   * core set last applies again.
   */
  const openTimed = (
    id: OutputId,
    holder: { readonly userId: UserId; readonly taken: Effect.Effect<void> },
  ) =>
    Effect.gen(function* () {
      const { outputs, nativeId } = yield* hold(id, holder);
      if (!(outputs instanceof TimedOutputs)) return yield* kindError;

      const output = yield* outputs.open(nativeId);
      const volume = volumes.get(id);
      if (volume !== undefined) yield* output.setVolume(volume);
      const remembering = new TimedOutput({
        ...output,
        setVolume: (next) => output.setVolume(next).pipe(Effect.andThen(rememberVolume(id, next))),
      });
      opened.set(id, remembering);
      return remembering;
    });

  /**
   * Sets the volume of an open output, or of a timed output for its next open. `undefined` when the
   * output cannot take a volume now.
   */
  const setVolume = (id: OutputId, volume: number) => {
    const output = opened.get(id);
    if (output !== undefined) return output.setVolume(volume);
    return isTimed(id) && has(id) ? rememberVolume(id, volume) : undefined;
  };

  const setDelay = (id: OutputId, delayMs: number) =>
    Effect.gen(function* () {
      yield* db
        .insert(outputSetting)
        .values({ outputId: id, delayMs })
        .onConflictDoUpdate({ target: outputSetting.outputId, set: { delayMs } })
        .pipe(orDieOnDatabaseError("setOutputDelay"));
      delays.set(id, delayMs);
      yield* notify;
    });

  return {
    registrations,
    follow,
    has,
    isTimed,
    list,
    open,
    openTimed,
    setVolume,
    delayOf: (id: OutputId) => delays.get(id) ?? 0,
    setDelay,
    /** The user whose session holds the output */
    heldBy: (id: OutputId) => holders.get(id)?.userId,
    /** Emits after each change of `list` */
    changes: Stream.fromPubSub(changed),
  };
});

/** The outputs that plugins add, for the sessions of all users */
export class Outputs extends Context.Service<Outputs, Effect.Success<typeof makeOutputs>>()(
  "@dyad/server-core/Outputs",
) {}

export const outputsLayer = Layer.effect(
  Outputs,
  makeOutputs.pipe(orDieOnDatabaseError("loadOutputSettings")),
);
