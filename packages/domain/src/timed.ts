import { Data, Schema } from "effect";

/** Text messages of a client on `/timed`. `Hello` comes first. */
export const TimedClientMessage = Schema.TaggedUnion({
  /** With `receiver`, the device plays the audio of the groups that it is a member of */
  Hello: { token: Schema.String.check(Schema.isMaxLength(1024)), receiver: Schema.Boolean },
  /** Local time in µs. It comes back in the answer. */
  Probe: { clientUs: Schema.Number },
  /** Mono blocks of the timed output that the session plays on, for a visualizer */
  Listen: { on: Schema.Boolean },
});

/** Server time is `Clock.monotonicTimeNanos` of the server in µs */
export const TimedServerMessage = Schema.TaggedUnion({
  Probe: { clientUs: Schema.Number, receivedUs: Schema.Number, sentUs: Schema.Number },
  /** Drops the blocks that did not play yet */
  Flush: { listen: Schema.Boolean },
});

/** 44.1 kHz PCM: interleaved stereo for a receiver, mono for a listener */
export class TimedFrame extends Data.Class<{
  readonly listen: boolean;
  /** Server time of the first frame */
  readonly playAtUs: number;
  readonly samples: Float32Array;
}> {}

const headerBytes = 16;

/** Binary message: a flag byte, `playAtUs` as float64 at byte 8, then int16 samples */
export const encodeTimedFrame = (frame: TimedFrame) => {
  const bytes = new Uint8Array(headerBytes + frame.samples.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, frame.listen ? 1 : 0);
  view.setFloat64(8, frame.playAtUs, true);
  for (const [index, sample] of frame.samples.entries()) {
    view.setInt16(
      headerBytes + index * 2,
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      true,
    );
  }
  return bytes;
};

/** `undefined` for a message that is too short */
export const decodeTimedFrame = (bytes: Uint8Array) => {
  if (bytes.length < headerBytes) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array((bytes.length - headerBytes) >> 1);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(headerBytes + index * 2, true) / 32767;
  }
  return new TimedFrame({
    listen: view.getUint8(0) === 1,
    playAtUs: view.getFloat64(8, true),
    samples,
  });
};
