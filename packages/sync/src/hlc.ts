import type { ReplicaId } from "@dyad/domain";
import { Clock, Context, Data, Effect, Layer, Ref, Schema } from "effect";

// Fixed widths make string order the same as clock order
const wallTimeDigits = 15;
const counterDigits = 4;
const maxCounter = 36 ** counterDigits - 1;

/**
 * Hybrid logical clock value: `<wall ms, 15 digits>-<counter, 4 base-36 digits>-<replica_id>`.
 * Values sort as strings. The replica ID makes values from different replicas unique.
 */
export const HybridLogicalClock = Schema.String.check(
  Schema.isPattern(/^\d{15}-[0-9a-z]{4}-[0-9a-f-]{36}$/),
).pipe(Schema.brand("HybridLogicalClock"));
export type HybridLogicalClock = typeof HybridLogicalClock.Type;

class ClockTime extends Data.Class<{ readonly wallTime: number; readonly counter: number }> {}

const origin = new ClockTime({ wallTime: 0, counter: 0 });

const encode = (time: ClockTime, replicaId: ReplicaId) => {
  const wallTime = String(time.wallTime).padStart(wallTimeDigits, "0");
  const counter = time.counter.toString(36).padStart(counterDigits, "0");

  return HybridLogicalClock.make(`${wallTime}-${counter}-${replicaId}`);
};

const decode = (hlc: HybridLogicalClock) => {
  const counterStart = wallTimeDigits + 1;

  return new ClockTime({
    wallTime: Number(hlc.slice(0, wallTimeDigits)),
    counter: Number.parseInt(hlc.slice(counterStart, counterStart + counterDigits), 36),
  });
};

const tick = (last: ClockTime, now: number, remote: ClockTime) => {
  const wallTime = Math.max(now, last.wallTime, remote.wallTime);
  const lastCounter = wallTime === last.wallTime ? last.counter + 1 : 0;
  const remoteCounter = wallTime === remote.wallTime ? remote.counter + 1 : 0;
  const counter = Math.max(lastCounter, remoteCounter);

  // A wider counter would break the string order, so the clock moves 1 ms ahead instead
  if (counter > maxCounter) {
    return new ClockTime({ wallTime: wallTime + 1, counter: 0 });
  }

  return new ClockTime({ wallTime, counter });
};

/** Hybrid logical clock of this replica */
export class HlcClock extends Context.Service<
  HlcClock,
  {
    /** Value for a local event. It is greater than all earlier values, also when the wall clock goes back. */
    readonly next: Effect.Effect<HybridLogicalClock>;
    /** Moves the clock past a value from another replica, and returns the value for the receive event */
    readonly receive: (remote: HybridLogicalClock) => Effect.Effect<HybridLogicalClock>;
  }
>()("@dyad/sync/HlcClock") {}

export const hlcClockLayer = (replicaId: ReplicaId) =>
  Layer.effect(
    HlcClock,
    Effect.gen(function* () {
      const last = yield* Ref.make(origin);

      const advance = (remote: ClockTime) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const time = yield* Ref.modify(last, (previous) => {
            const value = tick(previous, now, remote);
            return [value, value];
          });

          return encode(time, replicaId);
        });

      // A local event has no remote value. `origin` is not greater than any clock value.
      return {
        next: advance(origin),
        receive: (remote) => advance(decode(remote)),
      };
    }),
  );
