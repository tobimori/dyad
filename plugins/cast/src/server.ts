import { AudioFormat } from "@dyad/domain";
import { OutputError, OutputInfo, Plugin, UrlOutput, UrlOutputs, UrlStatus } from "@dyad/plugin";
import { Effect, Equal, Stream } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { HttpClient } from "effect/http";

import { TrackMetadata } from "./target.ts";
import type { TargetError, UpnpDevice } from "./target.ts";
import { localAddressTo } from "./upnp/gena.ts";
import { sonosGroups } from "./upnp/sonos.ts";
import { searchSchedule, upnpDevices } from "./upnp/ssdp.ts";
import { openUpnp } from "./upnp/upnp.ts";

const flac = new AudioFormat({ container: "flac", codec: "flac" });

// The formats that the Dyad server streams, by the MIME types that renderers list for them
const formatsByMimeType = [
  [["audio/flac", "audio/x-flac"], flac],
  [["audio/mpeg", "audio/mp3"], new AudioFormat({ container: "mp3", codec: "mp3" })],
  [["audio/aac", "audio/x-aac"], new AudioFormat({ container: "adts", codec: "aac" })],
  [["audio/mp4", "audio/x-m4a"], new AudioFormat({ container: "mp4", codec: "aac" })],
  [["audio/ogg"], new AudioFormat({ container: "ogg", codec: "vorbis" })],
] as const;

// Sonos 97.2 lists them, but plays them only with a `Content-Length`, which a converted stream lacks
const sonosNeedsLength = new Set(["mp4", "ogg"]);

const formatsOf = (device: UpnpDevice) => {
  const listed = device.capabilities.mimeTypes;
  // The server can always transcode to FLAC
  const [first = flac, ...rest] = formatsByMimeType.flatMap(([types, format]) => {
    const lists = listed.length === 0 || types.some((type) => listed.includes(type));
    const plays = device.kind !== "sonos" || !sonosNeedsLength.has(format.container);
    return lists && plays ? [format] : [];
  });
  return [first, ...rest] satisfies NonEmptyReadonlyArray<AudioFormat>;
};

const outputError = (error: TargetError) => new OutputError({ reason: error.reason });

// A Sonos group plays as one output through its coordinator, named like in the Sonos app
const outputInfos = (devices: ReadonlyArray<UpnpDevice>) =>
  Effect.gen(function* () {
    const sonos = devices.find((device) => device.kind === "sonos");
    const groups =
      sonos === undefined ? [] : yield* sonosGroups(sonos).pipe(Effect.orElseSucceed(() => []));

    return devices.flatMap((device) => {
      if (device.kind !== "sonos" || groups.length === 0) {
        return [new OutputInfo({ id: device.id, name: device.name })];
      }
      const group = groups.find((candidate) => candidate.coordinatorId === device.id);
      if (group === undefined) return [];
      return [
        new OutputInfo({ id: device.id, name: [device.name, ...group.otherRooms].join(" + ") }),
      ];
    });
  });

const sameInfos = (left: ReadonlyArray<OutputInfo>, right: ReadonlyArray<OutputInfo>) =>
  left.length === right.length && left.every((info, index) => Equal.equals(info, right[index]));

const openOutput = (device: UpnpDevice) =>
  Effect.gen(function* () {
    const target = yield* openUpnp(device).pipe(Effect.mapError(outputError));
    const localAddress = yield* localAddressTo(device.host).pipe(
      Effect.mapError((error) => new OutputError({ reason: error.message })),
    );

    return new UrlOutput({
      formats: formatsOf(device),
      localAddress,
      load: (media) =>
        target
          .load(
            media.url,
            new TrackMetadata({
              mimeType: media.contentType,
              title: media.title ?? "",
              artist: media.artist,
              album: media.album,
              artworkUrl: media.artworkUrl,
              durationMs: media.durationMs,
            }),
            0,
          )
          .pipe(Effect.mapError(outputError)),
      play: target.play.pipe(Effect.mapError(outputError)),
      pause: target.pause.pipe(Effect.mapError(outputError)),
      stop: target.stop.pipe(Effect.mapError(outputError)),
      setVolume: (volume) => target.setVolume(volume).pipe(Effect.mapError(outputError)),
      status: target.state.pipe(
        Stream.map(
          (state) =>
            new UrlStatus({
              state: state.status === "idle" ? "stopped" : state.status,
              url: state.url,
              positionMs: state.positionMs,
              volume: state.volume,
            }),
        ),
        // A failed poll repeats the last state, which would report an old position again
        Stream.changes,
        Stream.mapError(outputError),
      ),
    });
  });

/** UPnP MediaRenderers and Sonos rooms on the local network as outputs */
export const castPlugin = new Plugin({
  id: "dyad.cast",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const devices = new Map<string, UpnpDevice>();

      // The Sonos groups change in the Sonos app, so they are read again from time to time
      const discover = Stream.merge(
        upnpDevices.pipe(Stream.tap((device) => Effect.sync(() => devices.set(device.id, device)))),
        Stream.tick("30 seconds"),
      ).pipe(
        Stream.mapEffect(() => outputInfos([...devices.values()])),
        Stream.changesWith(sameInfos),
        Stream.tapError((error) => Effect.logWarning("UPnP discovery failed", String(error))),
        Stream.retry(searchSchedule),
        // The schedule has no end
        Stream.orDie,
        Stream.provideContext(services),
      );

      yield* context.outputs.add(
        "upnp",
        new UrlOutputs({
          discover,
          open: (id) => {
            const device = devices.get(id);
            return device === undefined
              ? Effect.fail(new OutputError({ reason: "The device was not discovered" }))
              : openOutput(device).pipe(Effect.provideContext(services));
          },
        }),
      );
    }),
});
