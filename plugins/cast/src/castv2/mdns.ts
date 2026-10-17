import { NodeDatagramSocket } from "@effect/platform-node";
import { decode, encode } from "dns-packet";
import { Effect, Schema, Stream } from "effect";
import { NetAddress } from "effect/net";

import { castMimeTypes } from "./cast.ts";
import { searchSchedule } from "../upnp/ssdp.ts";
import { Capabilities, CastDevice } from "../target.ts";

const service = "_googlecast._tcp.local";
const group = "224.0.0.251";

const Txt = Schema.Struct({
  /** Device ID */
  id: Schema.String,
  /** Friendly name */
  fn: Schema.String,
  /** Model name */
  md: Schema.String,
});

const query = encode({
  type: "query",
  id: 0,
  questions: [{ type: "PTR", name: service, class: "IN" }],
});

const open = (port: number) =>
  Effect.gen(function* () {
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

const txtRecord = (data: string | Uint8Array | ReadonlyArray<string | Uint8Array>) => {
  const entries = data instanceof Array ? data : [data];
  return Object.fromEntries(
    entries.map((entry) => {
      const text = entry instanceof Uint8Array ? Buffer.from(entry).toString("utf8") : entry;
      const separator = text.indexOf("=");
      return separator === -1 ? [text, ""] : [text.slice(0, separator), text.slice(separator + 1)];
    }),
  );
};

// A response usually holds the PTR, SRV, TXT and A records of a device
const devicesIn = (payload: Uint8Array, source: string) =>
  Effect.gen(function* () {
    const packet = yield* Effect.try(() => decode(Buffer.from(payload)));
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    const devices: Array<CastDevice> = [];

    for (const pointer of records) {
      if (pointer.type !== "PTR" || pointer.name !== service) continue;

      const instance = pointer.data;
      const srv = records.find((record) => record.type === "SRV" && record.name === instance);
      const txt = records.find((record) => record.type === "TXT" && record.name === instance);
      if (srv?.type !== "SRV" || txt?.type !== "TXT") continue;

      const address = records.find(
        (record) => record.type === "A" && record.name === srv.data.target,
      );
      const fields = yield* Schema.decodeUnknownEffect(Txt)(txtRecord(txt.data));
      const castGroup = fields.md === "Google Cast Group";

      devices.push(
        new CastDevice({
          id: fields.id,
          name: fields.fn,
          model: fields.md,
          kind: castGroup ? "cast-group" : "cast",
          host: address?.type === "A" ? address.data : source,
          port: srv.data.port,
          capabilities: new Capabilities({
            mimeTypes: castMimeTypes,
            queueNext: true,
            volume: true,
          }),
        }),
      );
    }

    return devices;
  }).pipe(Effect.orElseSucceed(() => []));

/** Finds Cast devices and groups with mDNS */
export const castDevices = Stream.unwrap(
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

    const seen = new Map<string, string>();
    return Stream.fromEffectRepeat(reader.pull).pipe(
      Stream.flattenIterable,
      Stream.mapEffect((datagram) =>
        devicesIn(datagram.payload, NetAddress.formatIp(datagram.address.address)),
      ),
      Stream.flattenIterable,
      Stream.filter((device) => {
        const key = `${device.host}:${device.port} ${device.name}`;
        if (seen.get(device.id) === key) return false;
        seen.set(device.id, key);
        return true;
      }),
    );
  }),
);
