import { NodeDatagramSocket } from "@effect/platform-node";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { NetAddress } from "effect/net";

import { describe } from "./description.ts";
import { sonosBonded } from "./sonos.ts";

const searchTargets = [
  "urn:schemas-upnp-org:device:MediaRenderer:1",
  "urn:schemas-upnp-org:device:ZonePlayer:1",
];

const search = (target: string) =>
  [
    "M-SEARCH * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    'MAN: "ssdp:discover"',
    "MX: 2",
    `ST: ${target}`,
    "",
    "",
  ].join("\r\n");

/** When discovery searches again: after 1, 2, 4, 8 and 16 seconds, then every 30 seconds */
export const searchSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const SearchAnswer = Schema.Struct({ location: Schema.String });

// HTTP over UDP: a status line, then `Name: value` lines
const headersOf = (payload: Uint8Array) => {
  const lines = new TextDecoder().decode(payload).split("\r\n");
  if (!/^HTTP\/1\.1 200/i.test(lines[0] ?? "")) return {};

  return Object.fromEntries(
    lines.slice(1).flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return [];
      return [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]];
    }),
  );
};

/** Finds UPnP MediaRenderers and Sonos rooms with SSDP */
export const upnpDevices = Stream.unwrap(
  Effect.gen(function* () {
    // @effect-diagnostics-next-line experimentalApiUsage:off -- Effect has no stable UDP socket
    const socket = yield* NodeDatagramSocket.make({ multicast: { ttl: 2 } });
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;

    const destination = NetAddress.inetAddressFromIpStringUnsafe("239.255.255.250", 1900);
    yield* Effect.forEach(searchTargets, (target) =>
      writer.write({ payload: search(target), address: destination }),
    ).pipe(Effect.ignore, Effect.repeat(searchSchedule), Effect.forkScoped);

    // A Sonos speaker answers each search target with the same location
    const described = new Set<string>();
    const emitted = new Map<string, string>();

    const deviceIn = Effect.fn("deviceIn")(function* (payload: Uint8Array) {
      const answer = yield* Schema.decodeUnknownEffect(SearchAnswer)(headersOf(payload)).pipe(
        Effect.option,
      );
      if (Option.isNone(answer)) return [];

      const { location } = answer.value;
      if (described.has(location) || !URL.canParse(location)) return [];
      described.add(location);

      const device = yield* describe(location).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Cannot read a UPnP device", location, error.reason).pipe(
            // A later search tries again
            Effect.andThen(Effect.sync(() => described.delete(location))),
            Effect.as(null),
          ),
        ),
      );
      if (device === null || emitted.get(device.id) === location) return [];

      const bonded =
        device.kind === "sonos" &&
        (yield* sonosBonded(device).pipe(Effect.orElseSucceed(() => false)));
      if (bonded) return [];

      emitted.set(device.id, location);
      return [device];
    });

    return Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flattenIterable,
      Stream.mapEffect((datagram) => deviceIn(datagram.payload), { concurrency: 4 }),
      Stream.flattenIterable,
    );
  }),
);
