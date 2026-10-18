import { Output, OutputId } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { OutputError, UrlOutput } from "@dyad/plugin";
import type { OutputInfo, UrlOutputs } from "@dyad/plugin";
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
  const registrations = new Map<string, UrlOutputs>();
  const discovered = new Map<string, ReadonlyArray<OutputInfo>>();
  const holders = new Map<OutputId, Holder>();
  const opened = new Map<OutputId, UrlOutput>();
  // The last volume that an open output reported
  const volumes = new Map<OutputId, number>();
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

  const list = () =>
    [...discovered].flatMap(([registration, infos]) =>
      infos.map((info) => {
        const id = OutputId.make(`${registration}:${info.id}`);
        return new Output({ id, kind: "url", name: info.name, volume: volumes.get(id) ?? null });
      }),
    );

  /** Keeps the outputs of `registration` up to date until the scope closes */
  const follow = (registration: string, outputs: UrlOutputs) =>
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

  /** Opens the output for the session of `userId` until the scope closes. The last open wins. */
  const open = (
    id: OutputId,
    holder: { readonly userId: UserId; readonly taken: Effect.Effect<void> },
  ) =>
    Effect.gen(function* () {
      const { registration, nativeId } = locate(id);
      const outputs = registrations.get(registration);
      if (outputs === undefined || !has(id)) {
        return yield* new OutputError({ reason: "The output is not available" });
      }

      // The earlier holder closes without a stop, so that its last commands come before ours
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

      const output = yield* outputs.open(nativeId);
      opened.set(id, output);
      return new UrlOutput({
        ...output,
        status: output.status.pipe(
          Stream.tap(({ volume }) =>
            volume === null || volumes.get(id) === volume
              ? Effect.void
              : Effect.sync(() => volumes.set(id, volume)).pipe(Effect.andThen(notify)),
          ),
        ),
      });
    });

  return {
    registrations,
    follow,
    has,
    list,
    open,
    /** The open output, for commands that do not change the session */
    opened: (id: OutputId) => opened.get(id),
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

export const outputsLayer = Layer.effect(Outputs, makeOutputs);
