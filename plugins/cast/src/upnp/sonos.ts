import { Effect, Schema } from "effect";

import { describe } from "./description.ts";
import { findService, soap } from "./soap.ts";
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

const zoneGroups = (device: UpnpDevice) =>
  Effect.gen(function* () {
    const topology = findService(device.services, "ZoneGroupTopology");
    if (topology === undefined) return [];

    const state = yield* soap(device.name, topology, "GetZoneGroupState", [], ZoneGroupState);
    const parsed = yield* decodeXml(Topology, state.ZoneGroupState);
    const groups =
      "ZoneGroupState" in parsed ? parsed.ZoneGroupState.ZoneGroups : parsed.ZoneGroups;
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

/**
 * The coordinator of the Sonos group of `device`. A group member ignores transport commands, so
 * they go to the coordinator. Falls back to `device` when the topology cannot be read.
 */
export const sonosCoordinator = (device: UpnpDevice) =>
  Effect.gen(function* () {
    const groups = yield* zoneGroups(device);
    const group = groups.find((candidate) =>
      candidate.ZoneGroupMember.some((member) => member.UUID === uuidOf(device)),
    );
    if (group === undefined || group.Coordinator === uuidOf(device)) return device;

    const coordinator = group.ZoneGroupMember.find((member) => member.UUID === group.Coordinator);
    if (coordinator === undefined) return device;

    return (yield* describe(coordinator.Location)) ?? device;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Cannot read the Sonos group", device.name, String(error)).pipe(
        Effect.as(device),
      ),
    ),
  );
