import { Data } from "effect";
import type { Effect, Stream } from "effect";

export class Capabilities extends Data.Class<{
  /** MIME types that the device lists. Empty when it lists none, then `load` tries any type. */
  readonly mimeTypes: ReadonlyArray<string>;
  /** `UrlTarget.next` can queue the next item */
  readonly queueNext: boolean;
  readonly volume: boolean;
}> {}

export class UpnpService extends Data.Class<{
  readonly serviceType: string;
  readonly controlUrl: string;
  readonly eventUrl: string;
  /** Action names from the service description */
  readonly actions: ReadonlyArray<string>;
}> {}

/** A UPnP MediaRenderer. For Sonos, `id` is the UDN of the `ZonePlayer` root device. */
export class UpnpDevice extends Data.TaggedClass("UpnpDevice")<{
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly kind: "upnp" | "sonos";
  readonly host: string;
  /** URL of the device description */
  readonly location: string;
  /** Services of the root device and of its embedded devices */
  readonly services: ReadonlyArray<UpnpService>;
  readonly capabilities: Capabilities;
}> {}

/** A Google Cast device or a Cast group */
export class CastDevice extends Data.TaggedClass("CastDevice")<{
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly kind: "cast" | "cast-group";
  readonly host: string;
  readonly port: number;
  readonly capabilities: Capabilities;
}> {}

export type Device = UpnpDevice | CastDevice;

export class TrackMetadata extends Data.Class<{
  /** MIME type of the stream at the loaded URL, for example `audio/flac` */
  readonly mimeType: string;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly artworkUrl: string | null;
  readonly durationMs: number | null;
}> {}

export class TargetState extends Data.Class<{
  readonly status: "idle" | "buffering" | "playing" | "paused";
  /** URL of the current item. It changes when a queued next item starts. */
  readonly url: string | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  /** From 0 to 1 */
  readonly volume: number | null;
  readonly muted: boolean;
  /** The last playback or connection error, until the next successful status */
  readonly error: string | null;
}> {}

export class TargetUnreachable extends Data.TaggedError("TargetUnreachable")<{
  readonly device: string;
  readonly reason: string;
}> {}

export class UnsupportedFormat extends Data.TaggedError("UnsupportedFormat")<{
  readonly device: string;
  readonly reason: string;
}> {}

/** Another controller or app holds the device */
export class DeviceBusy extends Data.TaggedError("DeviceBusy")<{
  readonly device: string;
  readonly reason: string;
}> {}

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly device: string;
  readonly command: string;
  readonly reason: string;
}> {}

export type TargetError = TargetUnreachable | UnsupportedFormat | DeviceBusy | CommandFailed;

/** A speaker that pulls a stream URL. Its state is not synced with other Dyad outputs. */
export class UrlTarget extends Data.Class<{
  readonly device: Device;
  /** Replaces the current item and starts it at `startMs` */
  readonly load: (
    url: string,
    metadata: TrackMetadata,
    startMs: number,
  ) => Effect.Effect<void, TargetError>;
  readonly play: Effect.Effect<void, TargetError>;
  readonly pause: Effect.Effect<void, TargetError>;
  readonly seek: (positionMs: number) => Effect.Effect<void, TargetError>;
  readonly stop: Effect.Effect<void, TargetError>;
  /** `volume` is from 0 to 1 */
  readonly setVolume: (volume: number) => Effect.Effect<void, TargetError>;
  /** Queues the item after the current one. Fails when `capabilities.queueNext` is false. */
  readonly next: (url: string, metadata: TrackMetadata) => Effect.Effect<void, TargetError>;
  /** Emits the current state first. Fails when the device stops answering. */
  readonly state: Stream.Stream<TargetState, TargetUnreachable>;
}> {}

export const idleState = new TargetState({
  status: "idle",
  url: null,
  positionMs: 0,
  durationMs: null,
  volume: null,
  muted: false,
  error: null,
});
