import { Clock, Deferred, Effect, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import type { HttpClient } from "effect/http";

import { subscribeEvents } from "./gena.ts";
import { findService, soap, soapCommand } from "./soap.ts";
import { sonosCoordinator } from "./sonos.ts";
import {
  CommandFailed,
  idleState,
  TargetState,
  TargetUnreachable,
  UnsupportedFormat,
  UrlTarget,
  type TargetError,
  type TrackMetadata,
  type UpnpDevice,
} from "../target.ts";
import { escapeXml } from "./xml.ts";

const TransportInfo = Schema.Struct({
  CurrentTransportState: Schema.String,
  CurrentTransportStatus: Schema.String,
});

const PositionInfo = Schema.Struct({
  TrackDuration: Schema.String,
  TrackURI: Schema.String,
  RelTime: Schema.String,
});

const Volume = Schema.Struct({ CurrentVolume: Schema.FiniteFromString });
const Mute = Schema.Struct({ CurrentMute: Schema.String });

const isTrue = (value: string) => /^(1|true|yes)$/i.test(value);

// A device that does not answer the poll for this long is lost
const unreachableAfterMs = 15_000;

// Spellings that some renderers list instead of the type that the Dyad server sends
const mimeAliases = new Map([
  ["audio/flac", ["audio/flac", "audio/x-flac"]],
  ["audio/mpeg", ["audio/mpeg", "audio/mp3", "audio/x-mpeg"]],
  ["audio/mp4", ["audio/mp4", "audio/x-m4a", "audio/m4a"]],
  ["audio/aac", ["audio/aac", "audio/x-aac", "audio/aacp"]],
]);

/** `H:MM:SS`, the time format of AVTransport */
const formatTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
};

/** Reads `H+:MM:SS[.F+]`. Renderers send `NOT_IMPLEMENTED` or an empty string when they do not know. */
const parseTime = (time: string) => {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(\.\d+)?$/.exec(time.trim());
  if (match === null) return null;

  const [, hours, minutes, seconds, fraction] = match;
  return (
    (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction ?? 0)) * 1000
  );
};

const errorOf = (transportStatus: string) => (transportStatus === "OK" ? null : transportStatus);

// Rygel 45.2 sends the track URI with the `&amp;` of the DIDL-Lite metadata
const urlOf = (trackUri: string) => (trackUri === "" ? null : trackUri.replaceAll("&amp;", "&"));

const statusOf = (transportState: string) => {
  if (transportState === "PLAYING") return "playing";
  if (transportState === "PAUSED_PLAYBACK") return "paused";
  if (transportState === "TRANSITIONING") return "buffering";
  return "idle";
};

const didl = (url: string, metadata: TrackMetadata, mimeType: string) => {
  const optional = (element: string, value: string | null) =>
    value === null ? "" : `<${element}>${escapeXml(value)}</${element}>`;
  const duration =
    metadata.durationMs === null ? "" : ` duration="${formatTime(metadata.durationMs)}"`;

  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="dyad" parentID="-1" restricted="1">',
    `<dc:title>${escapeXml(metadata.title)}</dc:title>`,
    optional("dc:creator", metadata.artist),
    optional("upnp:artist", metadata.artist),
    optional("upnp:album", metadata.album),
    optional("upnp:albumArtURI", metadata.artworkUrl),
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>",
    `<res protocolInfo="http-get:*:${escapeXml(mimeType)}:*"${duration}>${escapeXml(url)}</res>`,
    "</item></DIDL-Lite>",
  ].join("");
};

/**
 * Opens a UPnP MediaRenderer. For a Sonos speaker, transport commands go to the coordinator of its
 * group at open time, and the volume is the group volume.
 */
export const openUpnp = (device: UpnpDevice) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const transport = device.kind === "sonos" ? yield* sonosCoordinator(device) : device;
    const name = device.name;
    const instance = ["InstanceID", 0] as const;

    const avTransport = findService(transport.services, "AVTransport");
    if (avTransport === undefined) {
      return yield* new CommandFailed({ device: name, command: "open", reason: "No AVTransport" });
    }

    const groupVolume = findService(transport.services, "GroupRenderingControl");
    const renderingControl = findService(device.services, "RenderingControl");
    const volumeControl =
      device.kind === "sonos" && groupVolume !== undefined
        ? { service: groupVolume, volume: "GroupVolume", mute: "GroupMute", args: [instance] }
        : renderingControl && {
            service: renderingControl,
            volume: "Volume",
            mute: "Mute",
            args: [instance, ["Channel", "Master"] as const],
          };
    // Mute is optional in RenderingControl 1.0
    const mutes = volumeControl?.service.actions.includes(`Set${volumeControl.mute}`) === true;

    const state = yield* SubscriptionRef.make(idleState);
    const update = (change: Partial<ConstructorParameters<typeof TargetState>[0]>) =>
      SubscriptionRef.update(state, (current) => new TargetState({ ...current, ...change }));

    const transportCommand = (action: string, args: ReadonlyArray<readonly [string, string]>) =>
      soapCommand(name, avTransport, action, [instance, ...args]).pipe(
        Effect.provideContext(context),
      );

    const readVolume =
      volumeControl === undefined
        ? Effect.succeed({ volume: null, muted: false })
        : Effect.all({
            volume: soap(
              name,
              volumeControl.service,
              `Get${volumeControl.volume}`,
              volumeControl.args,
              Volume,
            ).pipe(Effect.map((answer) => answer.CurrentVolume / 100)),
            muted: mutes
              ? soap(
                  name,
                  volumeControl.service,
                  `Get${volumeControl.mute}`,
                  volumeControl.args,
                  Mute,
                ).pipe(Effect.map((answer) => isTrue(answer.CurrentMute)))
              : Effect.succeed(false),
          });

    const applyEvent = (variables: ReadonlyMap<string, string>) => {
      const transportState = variables.get("TransportState");
      const transportStatus = variables.get("TransportStatus");
      const trackUri = variables.get("CurrentTrackURI");
      const trackDuration = variables.get("CurrentTrackDuration");
      const volume = volumeControl && variables.get(volumeControl.volume);
      const mute = volumeControl && variables.get(volumeControl.mute);

      return SubscriptionRef.update(
        state,
        (current) =>
          new TargetState({
            status: transportState === undefined ? current.status : statusOf(transportState),
            url: trackUri === undefined ? current.url : urlOf(trackUri),
            positionMs: current.positionMs,
            durationMs: trackDuration === undefined ? current.durationMs : parseTime(trackDuration),
            volume: volume === undefined || volume === "" ? current.volume : Number(volume) / 100,
            muted: mute === undefined || mute === "" ? current.muted : isTrue(mute),
            error: transportStatus === undefined ? current.error : errorOf(transportStatus),
          }),
      );
    };

    const evented =
      volumeControl === undefined ? [avTransport] : [avTransport, volumeControl.service];
    const events = yield* subscribeEvents(transport.host, evented, applyEvent).pipe(
      Effect.catch((error) =>
        Effect.logWarning("UPnP events are not available, polling", name, String(error)).pipe(
          Effect.as({ active: Effect.succeed(false) }),
        ),
      ),
    );

    const answeredAt = yield* Ref.make(yield* Clock.currentTimeMillis);
    const unreachable = yield* Deferred.make<never, TargetUnreachable>();

    // AVTransport does not send the position as an event
    const poll = Effect.gen(function* () {
      const active = yield* events.active;
      const current = yield* SubscriptionRef.get(state);

      if (!active) {
        const info = yield* soap(name, avTransport, "GetTransportInfo", [instance], TransportInfo);
        yield* update({
          status: statusOf(info.CurrentTransportState),
          error: errorOf(info.CurrentTransportStatus),
          ...(yield* readVolume),
        });
      }
      if (active && (current.status === "idle" || current.status === "paused")) return;

      const position = yield* soap(name, avTransport, "GetPositionInfo", [instance], PositionInfo);
      const positionMs = parseTime(position.RelTime) ?? 0;
      const durationMs = parseTime(position.TrackDuration);
      const url = urlOf(position.TrackURI);
      // Rygel 45.2 reports position 0 at the end of a track, shortly before it stops
      const ends =
        positionMs === 0 &&
        url === current.url &&
        durationMs !== null &&
        current.positionMs > durationMs - 2000;
      yield* update({ positionMs: ends ? current.positionMs : positionMs, durationMs, url });
    }).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => Ref.set(answeredAt, now)),
      Effect.catch((error: TargetError) =>
        Effect.gen(function* () {
          yield* update({ error: error.reason });
          const now = yield* Clock.currentTimeMillis;
          if (
            error instanceof TargetUnreachable &&
            now - (yield* Ref.get(answeredAt)) > unreachableAfterMs
          ) {
            yield* Deferred.fail(unreachable, error);
          }
        }),
      ),
      Effect.provideContext(context),
    );
    yield* Effect.forkScoped(Effect.repeat(poll, Schedule.spaced("1 second")));

    // Sends the MIME type in the spelling that the renderer lists
    const protocolMimeType = (mimeType: string) =>
      Effect.gen(function* () {
        const listed = device.capabilities.mimeTypes;
        if (listed.length === 0) return mimeType;

        const spellings = mimeAliases.get(mimeType) ?? [mimeType];
        const match = spellings.find((spelling) => listed.includes(spelling));
        if (match !== undefined) return match;

        return yield* new UnsupportedFormat({
          device: name,
          reason: `${name} does not list ${mimeType}`,
        });
      });

    // A renderer can reject `Seek` until it plays
    const waitUntilPlaying = SubscriptionRef.changes(state).pipe(
      Stream.filter((current) => current.status === "playing"),
      Stream.runHead,
      Effect.timeout("10 seconds"),
      Effect.ignore,
    );

    const seek = (positionMs: number) =>
      transportCommand("Seek", [
        ["Unit", "REL_TIME"],
        ["Target", formatTime(positionMs)],
      ]);

    const load = (url: string, metadata: TrackMetadata, startMs: number) =>
      Effect.gen(function* () {
        const mimeType = yield* protocolMimeType(metadata.mimeType);
        // Rygel 45.2 plays a new URI at once when it played before, and then rejects `Play`
        const { status } = yield* SubscriptionRef.get(state);
        if (status !== "idle") yield* transportCommand("Stop", []);
        yield* transportCommand("SetAVTransportURI", [
          ["CurrentURI", url],
          ["CurrentURIMetaData", didl(url, metadata, mimeType)],
        ]);
        yield* update({ status: "buffering", url, positionMs: startMs, error: null });
        yield* transportCommand("Play", [["Speed", "1"]]);

        if (startMs > 0) {
          yield* waitUntilPlaying;
          yield* seek(startMs);
        }
      });

    const next = (url: string, metadata: TrackMetadata) =>
      Effect.gen(function* () {
        if (!device.capabilities.queueNext) {
          return yield* new CommandFailed({
            device: name,
            command: "next",
            reason: `${name} has no SetNextAVTransportURI`,
          });
        }

        const mimeType = yield* protocolMimeType(metadata.mimeType);
        yield* transportCommand("SetNextAVTransportURI", [
          ["NextURI", url],
          ["NextURIMetaData", didl(url, metadata, mimeType)],
        ]);
      });

    // UPnP volume is from 0 to 100 on Sonos and on most renderers
    const setVolume = (volume: number) => {
      if (volumeControl === undefined) {
        return Effect.fail(
          new CommandFailed({ device: name, command: "setVolume", reason: "No RenderingControl" }),
        );
      }

      const { service, args } = volumeControl;
      const level = Math.round(Math.min(Math.max(volume, 0), 1) * 100);
      return Effect.gen(function* () {
        if (mutes && (yield* SubscriptionRef.get(state)).muted) {
          yield* soapCommand(name, service, `Set${volumeControl.mute}`, [
            ...args,
            ["DesiredMute", 0],
          ]);
        }
        yield* soapCommand(name, service, `Set${volumeControl.volume}`, [
          ...args,
          ["DesiredVolume", level],
        ]);
      }).pipe(Effect.provideContext(context));
    };

    return new UrlTarget({
      device,
      load,
      play: transportCommand("Play", [["Speed", "1"]]),
      pause: transportCommand("Pause", []),
      seek,
      stop: transportCommand("Stop", []),
      setVolume,
      next,
      state: SubscriptionRef.changes(state).pipe(Stream.interruptWhen(Deferred.await(unreachable))),
    });
  });
