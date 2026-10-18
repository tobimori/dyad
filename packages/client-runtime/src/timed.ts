import { HttpUrl, TimedClientMessage, TimedServerMessage, decodeTimedFrame } from "@dyad/domain";
import type { TimedFrame } from "@dyad/domain";
import { Clock, Data, Deferred, Effect, Option, Redacted, Schedule, Schema, pipe } from "effect";
import { Url } from "effect/http";
import { Socket } from "effect/socket";

import { ClockFilter, clockProbe, pickProbe } from "./clock-filter.ts";
import type { ClockProbe } from "./clock-filter.ts";

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(TimedClientMessage));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(TimedServerMessage));

const burstSize = 8;
// Fast bursts at the start let the filter find the drift sooner
const fastBursts = 10;
// The server sends listen blocks while a visualizer took blocks this recently
const listenIdleUs = 2_000_000;
// About 10 seconds of blocks, for when nothing takes them
const listenBacklog = 100;

const nowUs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1000n));

/** Mono samples at 44.1 kHz whose first frame plays at local time `atUs` */
export class ListenBlock extends Data.Class<{
  readonly atUs: number;
  readonly samples: Float32Array;
}> {}

/**
 * The audio of the session's timed output while it plays elsewhere, for a visualizer. Local time is
 * `Clock.monotonicTimeNanos` in µs.
 */
export class ListenFeed {
  private blocks: Array<ListenBlock> = [];
  private lastTake = Number.NEGATIVE_INFINITY;
  /** Changes at each flush: blocks of the old epoch do not play */
  epoch = 0;

  push(block: ListenBlock) {
    this.blocks.push(block);
    if (this.blocks.length > listenBacklog) this.blocks.shift();
  }

  flush() {
    this.blocks = [];
    this.epoch += 1;
  }

  /** The blocks that arrived since the last call. Taking them keeps the blocks coming. */
  take(nowUs: number) {
    this.lastTake = nowUs;
    const taken = this.blocks;
    this.blocks = [];
    return taken;
  }

  wanted(nowUs: number) {
    return nowUs - this.lastTake < listenIdleUs;
  }
}

/**
 * Keeps a `/timed` socket open until the scope closes, and keeps the clock of the server in sync.
 * Local time is `Clock.monotonicTimeNanos` in µs.
 */
export const connectTimed = (options: {
  readonly serverUrl: string;
  readonly deviceToken: Redacted.Redacted<string>;
  /** The device plays the audio of the groups that it is a member of */
  readonly receiver: boolean;
  /** Stereo blocks of a group that the device is a member of */
  readonly onFrame: (frame: TimedFrame) => void;
  readonly onFlush: () => void;
}) =>
  Effect.gen(function* () {
    const url = yield* Schema.decodeEffect(HttpUrl)(options.serverUrl);
    const endpoint = pipe(
      url,
      Url.setPathname("/timed"),
      Url.setSearch(""),
      Url.setHash(""),
      Url.setProtocol(url.protocol === "https:" ? "wss:" : "ws:"),
    );
    const feed = new ListenFeed();
    // A new connection can reach a restarted server, so each one starts a new filter
    let filter = new ClockFilter();
    let listening = false;
    let writer: Socket.Writer | undefined;
    let answer = Option.none<{
      readonly sent: number;
      readonly probe: Deferred.Deferred<ClockProbe>;
    }>();

    const write = (message: typeof TimedClientMessage.Type) =>
      writer === undefined ? Effect.void : writer.write(encodeMessage(message)).pipe(Effect.ignore);

    const probe = Effect.gen(function* () {
      const sent = yield* nowUs;
      const deferred = yield* Deferred.make<ClockProbe>();
      answer = Option.some({ sent, probe: deferred });
      yield* write(TimedClientMessage.cases.Probe.make({ clientUs: sent }));
      return yield* Deferred.await(deferred).pipe(Effect.timeoutOption("2 seconds"));
    });

    const burst = Effect.gen(function* () {
      const probes: Array<ClockProbe> = [];
      for (let index = 0; index < burstSize; index++) {
        const answered = yield* probe;
        if (Option.isNone(answered)) return;
        probes.push(answered.value);
      }
      const picked = pickProbe(probes);
      if (picked !== undefined) filter.update(picked.measurement, picked.maxError, picked.at);
    });

    const receive = (data: string | Uint8Array) =>
      Effect.gen(function* () {
        if (data instanceof Uint8Array) {
          const frame = decodeTimedFrame(data);
          if (frame === undefined) return;
          if (!frame.listen) return options.onFrame(frame);
          if (filter.synchronized) {
            feed.push(
              new ListenBlock({ atUs: filter.localTime(frame.playAtUs), samples: frame.samples }),
            );
          }
          return;
        }
        const message = decodeMessage(data);
        if (Option.isNone(message)) return;
        if (TimedServerMessage.guards.Flush(message.value)) {
          return message.value.listen ? feed.flush() : options.onFlush();
        }
        const { clientUs, receivedUs, sentUs } = message.value;
        if (Option.isNone(answer) || answer.value.sent !== clientUs) return;
        const pending = answer.value.probe;
        answer = Option.none();
        yield* Deferred.succeed(pending, clockProbe(clientUs, yield* nowUs, receivedUs, sentUs));
      });

    const connection = Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(endpoint.href);
      const reader = yield* socket.reader;
      filter = new ClockFilter();
      writer = yield* socket.writer;
      yield* write(
        TimedClientMessage.cases.Hello.make({
          token: Redacted.value(options.deviceToken),
          receiver: options.receiver,
        }),
      );
      if (listening) yield* write(TimedClientMessage.cases.Listen.make({ on: true }));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (let index = 0; index < fastBursts; index++) {
            yield* burst;
            yield* Effect.sleep("1 second");
          }
          return yield* Effect.forever(burst.pipe(Effect.andThen(Effect.sleep("10 seconds"))));
        }),
      );
      for (;;) {
        for (const data of yield* reader.pull) yield* receive(data);
      }
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          writer = undefined;
        }),
      ),
    );

    // Listen blocks cost bandwidth, so they come only while a visualizer takes them
    const followDemand = Effect.gen(function* () {
      const wanted = feed.wanted(yield* nowUs);
      if (wanted === listening) return;
      listening = wanted;
      if (!wanted) feed.flush();
      yield* write(TimedClientMessage.cases.Listen.make({ on: wanted }));
    });

    const scope = yield* Effect.scope;
    yield* connection.pipe(
      Effect.retry(
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
      ),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.forkIn(scope),
    );
    yield* followDemand.pipe(Effect.repeat(Schedule.spaced("500 millis")), Effect.forkIn(scope));

    return {
      /** Server time of a local time, `undefined` until the first burst */
      serverTime: (localUs: number) =>
        filter.synchronized ? filter.serverTime(localUs) : undefined,
      feed,
    };
  });
