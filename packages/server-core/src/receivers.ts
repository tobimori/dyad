import { OutputId, TimedFrame, TimedServerMessage, encodeTimedFrame } from "@dyad/domain";
import type { DeviceId } from "@dyad/domain";
import { OutputError, TimedOutput } from "@dyad/plugin";
import { Context, Data, Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";

export const deviceOutput = (deviceId: DeviceId) => OutputId.make(`device:${deviceId}`);

// The client plays a block about 150 ms after it gets it; the rest covers stalls of its UI thread
const receiverLeadMs = 500;

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(TimedServerMessage));

/** One `/timed` connection of a device */
export class TimedClient extends Data.Class<{
  readonly deviceId: DeviceId;
  readonly receiver: boolean;
  readonly send: (data: string | Uint8Array) => Effect.Effect<void>;
  readonly closed: Deferred.Deferred<void>;
}> {}

const makeReceivers = Effect.gen(function* () {
  const clients = new Set<TimedClient>();
  const listeners = new Set<TimedClient>();
  const changed = yield* PubSub.unbounded<void>();

  const receiverOf = (outputId: OutputId) =>
    [...clients].findLast(
      (client) => client.receiver && deviceOutput(client.deviceId) === outputId,
    );

  const flush = (listen: boolean) => encodeMessage(TimedServerMessage.cases.Flush.make({ listen }));

  /** Until the scope closes */
  const add = (client: TimedClient) =>
    Effect.acquireRelease(
      Effect.sync(() => clients.add(client)).pipe(
        Effect.andThen(client.receiver ? PubSub.publish(changed, undefined) : Effect.void),
      ),
      () =>
        Effect.gen(function* () {
          clients.delete(client);
          listeners.delete(client);
          yield* Deferred.succeed(client.closed, undefined);
          if (client.receiver) yield* PubSub.publish(changed, undefined);
        }),
    );

  /** Plays the audio of a group on the device of `outputId` */
  const open = Effect.fnUntraced(function* (outputId: OutputId) {
    const client = receiverOf(outputId);
    if (client === undefined) {
      return yield* new OutputError({ reason: "The device does not play groups" });
    }
    return new TimedOutput({
      leadMs: receiverLeadMs,
      write: (playAtUs, pcm) =>
        client.send(encodeTimedFrame(new TimedFrame({ listen: false, playAtUs, samples: pcm }))),
      flush: client.send(flush(false)),
      // The device keeps its own volume, like when it plays alone
      setVolume: () => Effect.void,
      setMedia: () => Effect.void,
      closed: Deferred.await(client.closed).pipe(
        Effect.andThen(new OutputError({ reason: "The device disconnected" })),
      ),
    });
  });

  /** The listeners get the block as mono */
  const feed = (playAtUs: number, pcm: Float32Array) =>
    Effect.suspend(() => {
      if (listeners.size === 0) return Effect.void;
      const mono = new Float32Array(pcm.length >> 1);
      for (let index = 0; index < mono.length; index++) {
        mono[index] = ((pcm[2 * index] ?? 0) + (pcm[2 * index + 1] ?? 0)) / 2;
      }
      const bytes = encodeTimedFrame(new TimedFrame({ listen: true, playAtUs, samples: mono }));
      return Effect.forEach(listeners, (client) => client.send(bytes), { discard: true });
    });

  const flushListeners = Effect.suspend(() =>
    Effect.forEach(listeners, (client) => client.send(flush(true)), { discard: true }),
  );

  return {
    add,
    open,
    feed,
    flushListeners,
    listen: (client: TimedClient, on: boolean) =>
      Effect.sync(() => (on ? listeners.add(client) : listeners.delete(client))),
    /** Whether the device plays the audio of groups */
    has: (outputId: OutputId) => receiverOf(outputId) !== undefined,
    /** Emits when a receiver connects or disconnects */
    changes: Stream.fromPubSub(changed),
  };
});

/** Dyad clients that play the audio of groups, or show it in a visualizer */
export class Receivers extends Context.Service<Receivers, Effect.Success<typeof makeReceivers>>()(
  "@dyad/server-core/Receivers",
) {}

export const receiversLayer = Layer.effect(Receivers, makeReceivers);
