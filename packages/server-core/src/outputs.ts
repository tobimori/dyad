import { outputSetting } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import { Output, OutputId } from "@dyad/domain";
import {
  OutputError,
  TimedOutput,
  TimedOutputs,
  UrlMember,
  UrlOutput,
  UrlOutputs,
} from "@dyad/plugin";
import type { OutputInfo } from "@dyad/plugin";
import { Context, Data, Deferred, Effect, Layer, PubSub, Stream } from "effect";

/** Port of the HTTP server. URL outputs open stream URLs on it. */
export class StreamPort extends Context.Service<StreamPort, number>()(
  "@dyad/server-core/StreamPort",
) {}

class Found extends Data.Class<{
  readonly id: OutputId;
  readonly info: OutputInfo;
  readonly timed: boolean;
}> {}

class Holder extends Data.Class<{
  /** Runs when another session opens the output */
  readonly taken: Effect.Effect<void>;
  readonly released: Deferred.Deferred<void>;
}> {}

const makeOutputs = Effect.gen(function* () {
  const db = yield* Database;
  const registrations = new Map<string, UrlOutputs | TimedOutputs>();
  const discovered = new Map<string, ReadonlyArray<OutputInfo>>();
  const holders = new Map<OutputId, Holder>();
  const opened = new Map<OutputId, UrlOutput | TimedOutput | UrlMember>();
  // Live streams that URL outputs pull, by the random ID in their URL
  const liveStreams = new Map<string, Effect.Effect<Stream.Stream<Uint8Array>>>();
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

  const infoOf = (id: OutputId) => {
    const { registration, nativeId } = locate(id);
    return discovered.get(registration)?.find((info) => info.id === nativeId);
  };

  /** Whether all outputs are URL outputs of one plugin that groups them itself */
  const isNative = (ids: ReadonlyArray<OutputId>) => {
    const registration = ids[0] === undefined ? undefined : locate(ids[0]).registration;
    const outputs = registration === undefined ? undefined : registrations.get(registration);
    return (
      outputs instanceof UrlOutputs &&
      outputs.join !== undefined &&
      ids.every((id) => locate(id).registration === registration)
    );
  };

  /** Whether the plugin of the outputs can group them now */
  const joinable = (ids: ReadonlyArray<OutputId>) => {
    const group = ids[0] === undefined ? undefined : infoOf(ids[0])?.nativeGroup;
    return (
      group !== undefined && isNative(ids) && ids.every((id) => infoOf(id)?.nativeGroup === group)
    );
  };

  const found = () =>
    [...discovered].flatMap(([registration, infos]) =>
      infos.map(
        (info) =>
          new Found({
            id: OutputId.make(`${registration}:${info.id}`),
            info,
            timed: registrations.get(registration) instanceof TimedOutputs,
          }),
      ),
    );

  // A device on one address, for example a Sonos with UPnP and AirPlay, shows as its URL output.
  // It plays alone over its URL output and in a group over its timed twin.
  const twinOf = (id: OutputId) => {
    const all = found();
    const host = all.find((each) => each.id === id && !each.timed)?.info.host;
    return host === undefined
      ? undefined
      : all.find((each) => each.timed && each.info.host === host)?.id;
  };

  /** Whether the output can play in a timed group, itself or through its timed twin */
  const timedCapable = (id: OutputId) => isTimed(id) || twinOf(id) !== undefined;

  const list = () => {
    const all = found();
    const urlHosts = new Set(all.flatMap((each) => (each.timed ? [] : [each.info.host])));
    return all
      .filter((each) => !each.timed || !urlHosts.has(each.info.host))
      .map(
        ({ id, info, timed }) =>
          new Output({
            id,
            kind: timed ? "timed" : "url",
            name: info.name,
            volume: volumes.get(id) ?? null,
            muted: mutes.get(id) ?? false,
            delayMs: delays.get(id) ?? 0,
            groupable: timed || twinOf(id) !== undefined || info.nativeGroup !== undefined,
          }),
      );
  };

  /** Keeps the outputs of `registration` up to date until the scope closes */
  const follow = Effect.fn("follow")(function* (
    registration: string,
    outputs: UrlOutputs | TimedOutputs,
  ) {
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
  const hold = Effect.fn("hold")(function* (
    id: OutputId,
    holder: { readonly taken: Effect.Effect<void> },
  ) {
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

  /** Opens the URL output for a session until the scope closes */
  const open = Effect.fn("open")(function* (
    id: OutputId,
    holder: { readonly taken: Effect.Effect<void> },
  ) {
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

  /**
   * Makes the URL output play what `coordinator` plays, until the scope closes. The output belongs
   * to the session like after `open`.
   */
  const join = Effect.fn("join")(function* (
    id: OutputId,
    coordinator: OutputId,
    holder: { readonly taken: Effect.Effect<void> },
  ) {
    const { outputs, nativeId } = yield* hold(id, holder);
    if (!(outputs instanceof UrlOutputs) || outputs.join === undefined) return yield* kindError;
    const member = yield* outputs.join(nativeId, locate(coordinator).nativeId);
    opened.set(id, member);
    return member;
  });

  const rememberVolume = (id: OutputId, volume: number) =>
    Effect.sync(() => volumes.set(id, volume)).pipe(Effect.andThen(notify));

  /**
   * Opens the timed output, or the timed twin of a URL output, like `open`. A timed device reports
   * no volume, so the volume that the core set last applies again.
   */
  const openTimed = Effect.fn("openTimed")(function* (
    id: OutputId,
    holder: { readonly taken: Effect.Effect<void> },
  ) {
    const target = isTimed(id) ? id : twinOf(id);
    if (target === undefined) return yield* kindError;
    yield* hold(id, holder);
    const { registration, nativeId } = locate(target);
    const outputs = registrations.get(registration);
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
    // A group member reports no volume
    if (output instanceof UrlMember) {
      return output.setVolume(volume).pipe(Effect.andThen(rememberVolume(id, volume)));
    }
    if (output !== undefined) return output.setVolume(volume);
    return isTimed(id) && has(id) ? rememberVolume(id, volume) : undefined;
  };

  /** Serves the stream at `/live/<id>` until the scope closes. Each request connects again. */
  const addLiveStream = (id: string, connect: Effect.Effect<Stream.Stream<Uint8Array>>) =>
    Effect.acquireRelease(
      Effect.sync(() => liveStreams.set(id, connect)),
      () => Effect.sync(() => liveStreams.delete(id)),
    );

  const setDelay = Effect.fn("setDelay")(function* (id: OutputId, delayMs: number) {
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
    isNative,
    joinable,
    timedCapable,
    list,
    open,
    openTimed,
    join,
    setVolume,
    delayOf: (id: OutputId) => delays.get(id) ?? 0,
    setDelay,
    addLiveStream,
    liveStream: (id: string) => liveStreams.get(id),
    /** Whether a session holds the output */
    isHeld: (id: OutputId) => holders.has(id),
    /** Emits after each change of `list` */
    changes: Stream.fromPubSub(changed),
  };
});

/** The outputs that plugins add */
export class Outputs extends Context.Service<Outputs, Effect.Success<typeof makeOutputs>>()(
  "@dyad/server-core/Outputs",
) {}

export const outputsLayer = Layer.effect(
  Outputs,
  makeOutputs.pipe(orDieOnDatabaseError("loadOutputSettings")),
);
