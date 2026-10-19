import { Data, Effect, Schema } from "effect";

import { describe } from "./description.ts";
import { findService, soap, soapCommand } from "./soap.ts";
import { CommandFailed } from "../target.ts";
import type { UpnpDevice } from "../target.ts";
import { decodeXml } from "./xml.ts";

const ZoneGroupState = Schema.Struct({ ZoneGroupState: Schema.String });

const ZoneGroups = Schema.Struct({
  ZoneGroup: Schema.Array(
    Schema.Struct({
      Coordinator: Schema.String,
      ZoneGroupMember: Schema.Array(
        Schema.Struct({
          UUID: Schema.String,
          Location: Schema.String,
          ZoneName: Schema.optional(Schema.String),
          Invisible: Schema.optional(Schema.String),
          Satellite: Schema.optional(Schema.Array(Schema.Struct({ UUID: Schema.String }))),
        }),
      ),
    }),
  ),
});

// Newer firmware wraps `ZoneGroups` in `ZoneGroupState`
const Topology = Schema.Union([
  Schema.Struct({ ZoneGroupState: Schema.Struct({ ZoneGroups }) }),
  Schema.Struct({ ZoneGroups }),
]);

const uuidOf = (device: UpnpDevice) => device.id.replace(/^uuid:/, "");

const zoneGroups = Effect.fn(function* (device: UpnpDevice) {
  const topology = findService(device.services, "ZoneGroupTopology");
  if (topology === undefined) return [];

  const state = yield* soap(device.name, topology, "GetZoneGroupState", [], ZoneGroupState);
  const parsed = yield* decodeXml(Topology, state.ZoneGroupState);
  const groups = "ZoneGroupState" in parsed ? parsed.ZoneGroupState.ZoneGroups : parsed.ZoneGroups;
  return groups.ZoneGroup;
});

/**
 * Whether `device` is bonded to another speaker, for example as the second speaker of a stereo
 * pair or as a surround speaker. The Sonos app does not show it as a room.
 */
export const sonosBonded = (device: UpnpDevice) =>
  zoneGroups(device).pipe(
    Effect.map((groups) =>
      groups.some((group) =>
        group.ZoneGroupMember.some(
          (member) =>
            (member.UUID === uuidOf(device) && member.Invisible === "1") ||
            member.Satellite?.some((satellite) => satellite.UUID === uuidOf(device)) === true,
        ),
      ),
    ),
  );

export class SonosRoom extends Data.Class<{
  /** UDN, as in `UpnpDevice.id` */
  readonly id: string;
  readonly name: string;
}> {}

export class SonosGroup extends Data.Class<{
  /** UDN of the coordinator, as in `UpnpDevice.id` */
  readonly coordinatorId: string;
  /** The rooms of the other members. A stereo pair or a surround speaker is not a room. */
  readonly otherRooms: ReadonlyArray<SonosRoom>;
}> {}

/** The groups of the Sonos household of `device`, as the Sonos app shows them */
export const sonosGroups = (device: UpnpDevice) =>
  zoneGroups(device).pipe(
    Effect.map((groups) =>
      groups.map(
        (group) =>
          new SonosGroup({
            coordinatorId: `uuid:${group.Coordinator}`,
            otherRooms: group.ZoneGroupMember.flatMap((member) =>
              member.UUID === group.Coordinator ||
              member.Invisible === "1" ||
              member.ZoneName === undefined
                ? []
                : [new SonosRoom({ id: `uuid:${member.UUID}`, name: member.ZoneName })],
            ),
          }),
      ),
    ),
  );

const avTransportOf = (device: UpnpDevice) => {
  const service = findService(device.services, "AVTransport");
  return service === undefined
    ? Effect.fail(
        new CommandFailed({ device: device.name, command: "group", reason: "No AVTransport" }),
      )
    : Effect.succeed(service);
};

/** Makes `member` play what the group of `coordinator` plays */
export const sonosJoin = (member: UpnpDevice, coordinator: UpnpDevice) =>
  Effect.flatMap(avTransportOf(member), (service) =>
    soapCommand(member.name, service, "SetAVTransportURI", [
      ["InstanceID", 0],
      ["CurrentURI", `x-rincon:${uuidOf(coordinator)}`],
      ["CurrentURIMetaData", ""],
    ]),
  );

/** Takes `member` out of its group. It then plays nothing. */
export const sonosLeave = (member: UpnpDevice) =>
  Effect.flatMap(avTransportOf(member), (service) =>
    soapCommand(member.name, service, "BecomeCoordinatorOfStandaloneGroup", [["InstanceID", 0]]),
  );

/** Sets the volume of the room `device` alone, also in a group, and unmutes it */
export const sonosRoomVolume = Effect.fn("sonosRoomVolume")(function* (
  device: UpnpDevice,
  volume: number,
) {
  const service = findService(device.services, "RenderingControl");
  if (service === undefined) {
    return yield* new CommandFailed({
      device: device.name,
      command: "setVolume",
      reason: "No RenderingControl",
    });
  }
  const channel = [
    ["InstanceID", 0],
    ["Channel", "Master"],
  ] as const;
  yield* soapCommand(device.name, service, "SetMute", [...channel, ["DesiredMute", 0]]);
  yield* soapCommand(device.name, service, "SetVolume", [
    ...channel,
    ["DesiredVolume", Math.round(Math.min(Math.max(volume, 0), 1) * 100)],
  ]);
});

/**
 * The coordinator of the Sonos group of `device`. A group member ignores transport commands, so
 * they go to the coordinator. Falls back to `device` when the topology cannot be read.
 */
export const sonosCoordinator = Effect.fn("sonosCoordinator")(
  function* (device: UpnpDevice) {
    const groups = yield* zoneGroups(device);
    const group = groups.find((candidate) =>
      candidate.ZoneGroupMember.some((member) => member.UUID === uuidOf(device)),
    );
    if (group === undefined || group.Coordinator === uuidOf(device)) return device;

    const coordinator = group.ZoneGroupMember.find((member) => member.UUID === group.Coordinator);
    if (coordinator === undefined) return device;

    return (yield* describe(coordinator.Location)) ?? device;
  },
  (effect, device) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Cannot read the Sonos group", device.name, String(error)).pipe(
          Effect.as(device),
        ),
      ),
    ),
);
