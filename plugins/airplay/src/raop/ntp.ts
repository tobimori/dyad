import { Clock, Context, Effect, Layer, Schema } from "effect";

/** NTP time in 32.32 fixed point: seconds since 1900 in the high 32 bits, the fraction below */
export const NtpTime = Schema.BigInt.pipe(Schema.brand("NtpTime"));
export type NtpTime = typeof NtpTime.Type;

const nanosPerSecond = 1_000_000_000n;
const unixEpochNanos = 2_208_988_800n * nanosPerSecond;

const fromNanos = (nanos: bigint) =>
  NtpTime.make(
    ((nanos / nanosPerSecond) << 32n) | (((nanos % nanosPerSecond) << 32n) / nanosPerSecond),
  );

/** Adds `frames` at `sampleRate`, rounded down to the 2^-32 s step */
export const addFrames = (time: NtpTime, frames: number, sampleRate: number) =>
  NtpTime.make(time + (BigInt(frames) << 32n) / BigInt(sampleRate));

export const addMillis = (time: NtpTime, millis: number) =>
  NtpTime.make(time + BigInt(Math.round((millis / 1000) * 2 ** 32)));

/** `to - from` in milliseconds */
export const millisBetween = (from: NtpTime, to: NtpTime) => (Number(to - from) / 2 ** 32) * 1000;

/**
 * The clock that receivers follow. It runs at the rate of the monotonic clock. Receivers that play
 * in sync must share one.
 */
export class NtpClock extends Context.Service<NtpClock, { readonly now: Effect.Effect<NtpTime> }>()(
  "@dyad/airplay/NtpClock",
) {}

export const ntpClockLayer = Layer.effect(
  NtpClock,
  Effect.gen(function* () {
    // Wall time sets only the origin, so that a wall clock step cannot move audio
    const wall = yield* Clock.currentTimeNanos;
    const monotonic = yield* Clock.monotonicTimeNanos;
    const origin = unixEpochNanos + wall - monotonic;

    return { now: Effect.map(Clock.monotonicTimeNanos, (nanos) => fromNanos(origin + nanos)) };
  }),
);
