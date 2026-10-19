import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";

import { findService, soap } from "./soap.ts";
import {
  Capabilities,
  CommandFailed,
  TargetUnreachable,
  UpnpDevice,
  UpnpService,
} from "../target.ts";
import { decodeXml } from "./xml.ts";

const ServiceEntry = Schema.Struct({
  serviceType: Schema.String,
  SCPDURL: Schema.String,
  controlURL: Schema.String,
  eventSubURL: Schema.String,
});

// An empty list element parses as an empty string
const ServiceList = Schema.optional(
  Schema.Union([Schema.Struct({ service: Schema.Array(ServiceEntry) }), Schema.Literal("")]),
);

const DeviceList = <S extends Schema.Constraint>(device: S) =>
  Schema.optional(
    Schema.Union([Schema.Struct({ device: Schema.Array(device) }), Schema.Literal("")]),
  );

// Sonos puts the MediaRenderer one level below the root. Deeper levels are not read.
const EmbeddedDevice = Schema.Struct({
  serviceList: ServiceList,
  deviceList: DeviceList(Schema.Struct({ serviceList: ServiceList })),
});

const DeviceDescription = Schema.Struct({
  root: Schema.Struct({
    URLBase: Schema.optional(Schema.String),
    device: Schema.Tuple([
      Schema.Struct({
        deviceType: Schema.String,
        friendlyName: Schema.String,
        manufacturer: Schema.optional(Schema.String),
        modelName: Schema.optional(Schema.String),
        UDN: Schema.String,
        roomName: Schema.optional(Schema.String),
        serviceList: ServiceList,
        deviceList: DeviceList(EmbeddedDevice),
      }),
    ]),
  }),
});

const ServiceDescription = Schema.Struct({
  scpd: Schema.Struct({
    actionList: Schema.optional(
      Schema.Union([
        Schema.Struct({ action: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        Schema.Literal(""),
      ]),
    ),
  }),
});

const ProtocolInfo = Schema.Struct({ Sink: Schema.String });

// Dyad only calls actions of these services
const describedServices = new Set([
  "AVTransport",
  "RenderingControl",
  "GroupRenderingControl",
  "ConnectionManager",
]);

const servicesOf = (list: typeof ServiceList.Type) =>
  list === undefined || list === "" ? [] : list.service;

const devicesOf = <A>(list: { readonly device: ReadonlyArray<A> } | "" | undefined) =>
  list === undefined || list === "" ? [] : list.device;

const fetchText = (device: string, url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("5 seconds"),
    Effect.mapError((error) => new TargetUnreachable({ device, reason: error.message })),
  );

/**
 * Reads the device description at `location`. Returns `null` when the device is not a
 * MediaRenderer.
 */
export const describe = Effect.fn("describe")(function* (location: string) {
  const description = yield* fetchText(location, location).pipe(
    Effect.flatMap((xml) => decodeXml(DeviceDescription, xml)),
    Effect.catchTag("XmlError", (error) =>
      Effect.fail(
        new CommandFailed({ device: location, command: "describe", reason: error.reason }),
      ),
    ),
  );
  const root = description.root.device[0];
  const base = description.root.URLBase ?? location;
  const name = root.roomName ?? root.friendlyName;

  // The renderer is the root or an embedded device. Its siblings, such as the Sonos
  // MediaServer, have their own ConnectionManager.
  const embedded = devicesOf(root.deviceList);
  const nested = embedded.flatMap((device) => devicesOf(device.deviceList));
  const renderer = [root, ...embedded, ...nested].find((device) =>
    servicesOf(device.serviceList).some((entry) => entry.serviceType.includes(":AVTransport:")),
  );
  if (renderer === undefined) return null;

  const entries =
    renderer === root
      ? servicesOf(root.serviceList)
      : [...servicesOf(root.serviceList), ...servicesOf(renderer.serviceList)];

  const services = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const described = describedServices.has(entry.serviceType.split(":")[3] ?? "");
        const scpd = described
          ? yield* fetchText(name, new URL(entry.SCPDURL, base).href).pipe(
              Effect.flatMap((xml) => decodeXml(ServiceDescription, xml)),
              Effect.catchTag("XmlError", (error) =>
                Effect.fail(
                  new CommandFailed({ device: name, command: "describe", reason: error.reason }),
                ),
              ),
            )
          : undefined;
        const actionList = scpd?.scpd.actionList;

        return new UpnpService({
          serviceType: entry.serviceType,
          controlUrl: new URL(entry.controlURL, base).href,
          eventUrl: new URL(entry.eventSubURL, base).href,
          actions:
            actionList === undefined || actionList === ""
              ? []
              : actionList.action.map((action) => action.name),
        });
      }),
    { concurrency: 4 },
  );

  const has = (service: string, action: string) =>
    findService(services, service)?.actions.includes(action) === true;
  const sonos = root.deviceType.includes(":ZonePlayer:");

  const connectionManager = findService(services, "ConnectionManager");
  const sink =
    connectionManager === undefined
      ? ""
      : yield* soap(name, connectionManager, "GetProtocolInfo", [], ProtocolInfo).pipe(
          Effect.map((info) => info.Sink),
        );
  // For example `http-get:*:audio/flac:*`
  const mimeTypes = sink.split(",").flatMap((entry) => {
    const [protocol, , mimeType] = entry.trim().split(":");
    return protocol === "http-get" && mimeType?.startsWith("audio/") === true ? [mimeType] : [];
  });

  return new UpnpDevice({
    id: root.UDN,
    name,
    manufacturer: root.manufacturer ?? "",
    model: root.modelName ?? "",
    kind: sonos ? "sonos" : "upnp",
    host: new URL(location).hostname,
    location,
    services,
    capabilities: new Capabilities({
      mimeTypes: [...new Set(mimeTypes)],
      queueNext: has("AVTransport", "SetNextAVTransportURI"),
      volume:
        has("RenderingControl", "SetVolume") ||
        (sonos && has("GroupRenderingControl", "SetGroupVolume")),
    }),
  });
});
