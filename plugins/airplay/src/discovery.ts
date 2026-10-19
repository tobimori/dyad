import { NodeDatagramSocket } from "@effect/platform-node";
import { decode, encode } from "dns-packet";
import { Effect, Result, Schedule, Stream } from "effect";
import { NetAddress } from "effect/net";

import { type AirPlayDevice, deviceFromRecords } from "./device.ts";
import { AirPlayNetworkError } from "./errors.ts";

const raopService = "_raop._tcp.local";
const airPlayService = "_airplay._tcp.local";
const group = "224.0.0.251";

const query = encode({
  type: "query",
  id: 0,
  questions: [
    { type: "PTR", name: raopService, class: "IN" },
    { type: "PTR", name: airPlayService, class: "IN" },
  ],
});

// After 1, 2, 4, 8 and 16 seconds, then every 30 seconds
const searchSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const open = Effect.fn(function* (port: number) {
  // @effect-diagnostics-next-line experimentalApiUsage:off -- Effect has no stable UDP socket
  const socket = yield* NodeDatagramSocket.make({
    bind: { address: "0.0.0.0", port },
    reuseAddress: true,
    multicast: { ttl: 255 },
  });
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  return { reader, writer };
});

// Keys are lowercase; an entry without `=` is a flag
const txtRecord = (data: string | Uint8Array | ReadonlyArray<string | Uint8Array>) => {
  const entries = data instanceof Array ? data : [data];
  return new Map(
    entries.map((entry) => {
      const text = entry instanceof Uint8Array ? Buffer.from(entry).toString("utf8") : entry;
      const separator = text.indexOf("=");
      return separator === -1
        ? [text.toLowerCase(), ""]
        : [text.slice(0, separator).toLowerCase(), text.slice(separator + 1)];
    }),
  );
};

/**
 * Finds receivers that announce RAOP, also those that need AirPlay 2 (see `raopAccess`). It emits a
 * device again when its records change.
 */
export const discover = Stream.unwrap(
  Effect.gen(function* () {
    // Port 5353 also receives the answers to other queries. Without it, devices answer by unicast.
    const { reader, writer } = yield* open(5353).pipe(Effect.catch(() => open(0)));
    const groupAddress = NetAddress.ipFromStringUnsafe(group);
    if (NetAddress.isMulticast(groupAddress)) {
      yield* reader.joinMulticast({ group: groupAddress }).pipe(Effect.ignore);
    }

    const destination = NetAddress.inetAddressFromIpStringUnsafe(group, 5353);
    yield* writer
      .write({ payload: query, address: destination })
      .pipe(Effect.ignore, Effect.repeat(searchSchedule), Effect.forkScoped);

    // A receiver can answer in several responses, so records stay until a newer one replaces them
    const services = new Map<string, { readonly host: string; readonly port: number }>();
    const texts = new Map<string, ReadonlyMap<string, string>>();
    const addresses = new Map<string, string>();
    const emitted = new Map<string, string>();

    const devicesIn = (payload: Uint8Array, source: string) => {
      const packet = Result.try(() => decode(Buffer.from(payload)));
      if (Result.isFailure(packet)) return [];

      const records = [...(packet.success.answers ?? []), ...(packet.success.additionals ?? [])];
      const ours = (name: string) => name.endsWith(raopService) || name.endsWith(airPlayService);
      for (const record of records) {
        if (record.type === "SRV" && ours(record.name)) {
          services.set(record.name, { host: record.data.target, port: record.data.port });
        }
        if (record.type === "TXT" && ours(record.name))
          texts.set(record.name, txtRecord(record.data));
        if (record.type === "A") addresses.set(record.name, record.data);
      }

      // The AirPlay record has the hardware address of the receiver in `deviceid`
      const airPlayById = new Map<string, ReadonlyMap<string, string>>();
      for (const [name, text] of texts) {
        const id = text.get("deviceid")?.replaceAll(":", "").toUpperCase();
        if (name.endsWith(airPlayService) && id !== undefined) airPlayById.set(id, text);
      }

      const devices: Array<AirPlayDevice> = [];
      for (const [name, service] of services) {
        const raop = texts.get(name);
        if (!name.endsWith(`.${raopService}`) || raop === undefined) continue;

        const instance = name.slice(0, -raopService.length - 1);
        const device = deviceFromRecords({
          instance,
          host: addresses.get(service.host) ?? source,
          port: service.port,
          raop,
          airPlay: airPlayById.get(instance.slice(0, instance.indexOf("@")).toUpperCase()),
        });

        const key = JSON.stringify(device);
        if (emitted.get(device.id) === key) continue;
        emitted.set(device.id, key);
        devices.push(device);
      }
      return devices;
    };

    return Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flattenIterable,
      Stream.map((datagram) =>
        devicesIn(datagram.payload, NetAddress.formatIp(datagram.address.address)),
      ),
      Stream.flattenIterable,
    );
  }),
).pipe(Stream.mapError((cause) => new AirPlayNetworkError({ device: "mDNS", cause })));
