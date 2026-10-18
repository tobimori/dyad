// Port of `SendspinTimeFilter` from sendspin-js 5.0.0, Copyright Sendspin Protocol Authors,
// Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

import { Data } from "effect";

// A residual larger than this times `maxError` makes the filter forget faster
const forgettingCutoff = 2;

/**
 * Kalman filter of the offset and the drift between the local clock and the server clock, from
 * NTP-style probes. All times are in µs.
 */
export class ClockFilter {
  private lastUpdate = 0;
  private count = 0;
  private offset = 0;
  private drift = 0;
  private offsetCovariance = Number.POSITIVE_INFINITY;
  private offsetDriftCovariance = 0;
  private driftCovariance = 0;
  private useDrift = false;
  private readonly offsetProcessVariance: number;
  private readonly driftProcessVariance: number;
  private readonly forgetVarianceFactor: number;
  private readonly driftSignificanceSquared: number;

  // The parameters of sendspin-js 5.0.0
  constructor(
    offsetProcessStdDev = 0,
    forgetFactor = 1.1,
    driftSignificance = 2,
    driftStdDev = 1e-12,
  ) {
    this.offsetProcessVariance = offsetProcessStdDev ** 2;
    this.driftProcessVariance = driftStdDev ** 2;
    this.forgetVarianceFactor = forgetFactor ** 2;
    this.driftSignificanceSquared = driftSignificance ** 2;
  }

  get synchronized() {
    return this.count >= 1 && Number.isFinite(this.offsetCovariance);
  }

  /**
   * `measurement` is `((t2 - t1) + (t3 - t4)) / 2`, `maxError` half the round trip, `at` the local
   * time of the answer
   */
  update(measurement: number, maxError: number, at: number) {
    if (at <= this.lastUpdate) return;
    const dt = at - this.lastUpdate;
    this.lastUpdate = at;
    const variance = maxError * maxError;

    if (this.count <= 0) {
      this.count = 1;
      this.offset = measurement;
      this.offsetCovariance = variance;
      this.drift = 0;
      this.useDrift = false;
      return;
    }
    if (this.count === 1) {
      this.count = 2;
      this.drift = (measurement - this.offset) / dt;
      this.offset = measurement;
      this.driftCovariance = (this.offsetCovariance + variance) / (dt * dt);
      this.offsetCovariance = variance;
      this.useDrift = false;
      return;
    }

    const predicted = this.offset + this.drift * dt;
    let driftCovariance = this.driftCovariance + dt * this.driftProcessVariance;
    let offsetDriftCovariance = this.offsetDriftCovariance + this.driftCovariance * dt;
    let offsetCovariance =
      this.offsetCovariance +
      2 * this.offsetDriftCovariance * dt +
      this.driftCovariance * dt * dt +
      dt * this.offsetProcessVariance;

    const residual = measurement - predicted;
    if (this.count < 100) this.count += 1;
    else if (Math.abs(residual) > maxError * forgettingCutoff) {
      driftCovariance *= this.forgetVarianceFactor;
      offsetDriftCovariance *= this.forgetVarianceFactor;
      offsetCovariance *= this.forgetVarianceFactor;
    }

    const uncertainty = 1 / (offsetCovariance + variance);
    const offsetGain = offsetCovariance * uncertainty;
    const driftGain = offsetDriftCovariance * uncertainty;
    this.offset = predicted + offsetGain * residual;
    this.drift += driftGain * residual;
    this.driftCovariance = driftCovariance - driftGain * offsetDriftCovariance;
    this.offsetDriftCovariance = offsetDriftCovariance - driftGain * offsetCovariance;
    this.offsetCovariance = offsetCovariance - offsetGain * offsetCovariance;
    this.useDrift = this.drift * this.drift > this.driftSignificanceSquared * this.driftCovariance;
  }

  serverTime(local: number) {
    const drift = this.useDrift ? this.drift : 0;
    return local + this.offset + drift * (local - this.lastUpdate);
  }

  localTime(server: number) {
    const drift = this.useDrift ? this.drift : 0;
    return (server - this.offset + drift * this.lastUpdate) / (1 + drift);
  }
}

/** One answered probe */
export class ClockProbe extends Data.Class<{
  readonly measurement: number;
  readonly maxError: number;
  readonly at: number;
  readonly roundTrip: number;
}> {}

/** `sent` and `received` are local times, the others server times */
export const clockProbe = (
  sent: number,
  received: number,
  serverReceived: number,
  serverSent: number,
) => {
  const roundTrip = Math.max(0, received - sent - (serverSent - serverReceived));
  return new ClockProbe({
    measurement: (serverReceived - sent + (serverSent - received)) / 2,
    maxError: Math.max(1000, roundTrip / 2),
    at: received,
    roundTrip,
  });
};

/** The median of the 3 probes of a burst with the shortest round trip, as sendspin-js 5.0.0 */
export const pickProbe = (burst: ReadonlyArray<ClockProbe>) => {
  const fastest = burst.toSorted((a, b) => a.roundTrip - b.roundTrip).slice(0, 3);
  return fastest.toSorted((a, b) => a.measurement - b.measurement)[fastest.length >> 1];
};
