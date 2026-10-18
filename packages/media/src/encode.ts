import { Effect, Stream } from "effect";
import { avRescaleQ } from "node-av";
import { Decoder, Encoder, FilterAPI } from "node-av/api";
import {
  FF_ENCODER_AAC,
  FF_ENCODER_FLAC,
  FF_ENCODER_LIBMP3LAME,
  FF_ENCODER_LIBOPUS,
} from "node-av/constants";

import {
  MediaError,
  bitDepthOf,
  muxStream,
  openAudio,
  packetsFrom,
  startTimestamp,
  writePackets,
} from "./node.ts";
import type { MediaStream } from "./node.ts";

// The native AAC encoder, not `libfdk_aac`, whose license does not combine with the AGPL
const encoders = {
  flac: FF_ENCODER_FLAC,
  aac: FF_ENCODER_AAC,
  opus: FF_ENCODER_LIBOPUS,
  mp3: FF_ENCODER_LIBMP3LAME,
};

// Fragmented MP4 like `remuxAudio`, because the output cannot seek back to the header
const muxerOptions = (container: string) =>
  container === "mp4"
    ? { movflags: "delay_moov+default_base_moof", frag_duration: "1000000" }
    : undefined;

/**
 * Decodes any audio and encodes all of it as `codec` in `container`. FLAC keeps the bit depth of
 * the source unless `bitDepth` is 16. Lossy encoders convert to a sample rate that they take.
 */
export const encodeAudio = (
  media: string | MediaStream,
  output: {
    readonly container: string;
    readonly codec: keyof typeof encoders;
    /** In bit/s, for lossy codecs */
    readonly bitrate: number | null;
    readonly bitDepth: 16 | null;
  },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream, name, partial } = yield* openAudio(media);
      const fail = (cause: unknown) => new MediaError({ input: name, reason: String(cause) });
      // Drops the encoder priming of the source, like `encodeFlac`
      const start = startTimestamp(stream, 0, partial);
      const startSample = avRescaleQ(start, stream.timeBase, {
        num: 1,
        den: stream.codecpar.sampleRate,
      });
      const deep = output.bitDepth === null && (bitDepthOf(stream.codecpar) ?? 16) > 16;
      const filters =
        output.codec === "flac"
          ? `atrim=start_pts=${startSample},aformat=sample_fmts=${deep ? "s32" : "s16"}`
          : `atrim=start_pts=${startSample}`;

      const decoder = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => Decoder.create(stream), catch: fail }),
        (decoder) => Effect.sync(() => decoder.close()),
      );
      const filter = yield* Effect.acquireRelease(
        Effect.sync(() => FilterAPI.create(filters)),
        (filter) => Effect.sync(() => filter.close()),
      );
      const encoder = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            Encoder.create(encoders[output.codec], {
              decoder,
              autoResample: true,
              // 0 lets the encoder choose, as FLAC does
              context: { bitRate: output.bitrate ?? 0 },
            }),
          catch: fail,
        }),
        (encoder) => Effect.sync(() => encoder.close()),
      );
      const packets = encoder.packets(
        filter.frames(
          decoder.frames(Stream.toAsyncIterable(packetsFrom(name, input, stream, start))),
        ),
      );
      const options = muxerOptions(output.container);
      return yield* muxStream(
        name,
        options === undefined
          ? { format: output.container }
          : { format: output.container, options },
        (muxer) => writePackets(muxer, muxer.addStream(stream, { encoder }), packets),
      );
    }),
  );
