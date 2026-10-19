import { AudioFormat } from "@dyad/domain";
import {
  OutputError,
  OutputInfo,
  Plugin,
  UrlMember,
  UrlOutput,
  UrlOutputs,
  UrlStatus,
} from "@dyad/plugin";
import type { UrlMedia } from "@dyad/plugin";
import { Data, Deferred, Effect, Equal, Stream } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { HttpClient } from "effect/http";

import { TrackMetadata } from "./target.ts";
import type { TargetError, UpnpDevice } from "./target.ts";
import { localAddressTo } from "./upnp/gena.ts";
import { sonosGroups, sonosJoin, sonosLeave, sonosRoomVolume } from "./upnp/sonos.ts";
import type { SonosGroup } from "./upnp/sonos.ts";
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

// The Sonos rooms that the plugin lists are of one household
const sonosHousehold = "sonos";

// A room that Dyad added to the group of `coordinatorId`
class Joined extends Data.Class<{
  readonly coordinatorId: string;
  readonly left: Deferred.Deferred<void>;
}> {
  // The topology showed the room in the group
  seen = false;
}

// A Sonos group plays as one output through its coordinator, named like in the Sonos app. A room
// that Dyad added to a group keeps its own output.
const outputInfos = (
  devices: ReadonlyArray<UpnpDevice>,
  groups: ReadonlyArray<SonosGroup>,
  joined: ReadonlyMap<string, Joined>,
) =>
  devices.flatMap((device) => {
    if (device.kind !== "sonos" || groups.length === 0) {
      return [new OutputInfo({ id: device.id, name: device.name, host: device.host })];
    }
    const room = (name: string) =>
      new OutputInfo({ id: device.id, name, host: device.host, nativeGroup: sonosHousehold });
    if (joined.has(device.id)) return [room(device.name)];
    const group = groups.find((candidate) => candidate.coordinatorId === device.id);
    if (group === undefined) return [];
    const others = group.otherRooms.filter((other) => !joined.has(other.id));
    return [room([device.name, ...others.map((other) => other.name)].join(" + "))];
  });

// Another controller moved a room that Dyad added to a group
const leftRooms = (groups: ReadonlyArray<SonosGroup>, joined: Map<string, Joined>) =>
  Effect.forEach(
    [...joined],
    ([id, record]) => {
      const group = groups.find((candidate) => candidate.otherRooms.some((room) => room.id === id));
      if (group?.coordinatorId === record.coordinatorId) {
        record.seen = true;
        return Effect.void;
      }
      if (!record.seen) return Effect.void;
      joined.delete(id);
      return Deferred.succeed(record.left, undefined);
    },
    { discard: true },
  );

const sameInfos = (left: ReadonlyArray<OutputInfo>, right: ReadonlyArray<OutputInfo>) =>
  left.length === right.length && left.every((info, index) => Equal.equals(info, right[index]));

const openOutput = Effect.fn(function* (device: UpnpDevice) {
  const target = yield* openUpnp(device).pipe(Effect.mapError(outputError));
  const localAddress = yield* localAddressTo(device.host).pipe(
    Effect.mapError((error) => new OutputError({ reason: error.message })),
  );

  const metadataOf = (media: UrlMedia) =>
    new TrackMetadata({
      mimeType: media.contentType,
      title: media.title ?? "",
      artist: media.artist,
      album: media.album,
      artworkUrl: media.artworkUrl,
      durationMs: media.durationMs,
    });

  return new UrlOutput({
    formats: formatsOf(device),
    localAddress,
    load: (media) =>
      target.load(media.url, metadataOf(media), 0).pipe(Effect.mapError(outputError)),
    // Gapless playback is tested only with the Sonos queue
    ...(device.kind === "sonos" && {
      loadNext: (media: UrlMedia | null) =>
        (media === null ? target.clearNext : target.next(media.url, metadataOf(media))).pipe(
          Effect.mapError(outputError),
        ),
    }),
    live: device.kind === "sonos",
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
            muted: state.muted,
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
      const joined = new Map<string, Joined>();

      // The Sonos groups change in the Sonos app, so they are read again from time to time
      const discover = Stream.merge(
        upnpDevices.pipe(Stream.tap((device) => Effect.sync(() => devices.set(device.id, device)))),
        Stream.tick("30 seconds"),
      ).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const listed = [...devices.values()];
            const sonos = listed.find((device) => device.kind === "sonos");
            const groups =
              sonos === undefined
                ? []
                : yield* sonosGroups(sonos).pipe(Effect.orElseSucceed(() => []));
            yield* leftRooms(groups, joined);
            return outputInfos(listed, groups, joined);
          }),
        ),
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
          // The room leaves the group when the scope closes, unless another controller moved it
          join: (id, coordinatorId) =>
            Effect.gen(function* () {
              const member = devices.get(id);
              const coordinator = devices.get(coordinatorId);
              if (member === undefined || coordinator === undefined) {
                return yield* new OutputError({ reason: "The device was not discovered" });
              }
              const record = new Joined({ coordinatorId, left: yield* Deferred.make<void>() });
              joined.set(id, record);
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (joined.get(id) !== record) return;
                  joined.delete(id);
                  yield* sonosLeave(member).pipe(
                    Effect.timeout("3 seconds"),
                    Effect.catch((error) =>
                      Effect.logWarning("Cannot take a Sonos room out of its group", String(error)),
                    ),
                  );
                }).pipe(Effect.provideContext(services)),
              );
              yield* sonosJoin(member, coordinator).pipe(
                Effect.mapError(outputError),
                Effect.provideContext(services),
              );
              return new UrlMember({
                setVolume: (volume) =>
                  sonosRoomVolume(member, volume).pipe(
                    Effect.mapError(outputError),
                    Effect.provideContext(services),
                  ),
                left: Deferred.await(record.left),
              });
            }),
        }),
      );
    }),
});
