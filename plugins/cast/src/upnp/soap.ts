import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CommandFailed, DeviceBusy, TargetUnreachable, UnsupportedFormat } from "../target.ts";
import type { UpnpService } from "../target.ts";
import { decodeXml, escapeXml } from "./xml.ts";

const Envelope = Schema.Struct({
  Envelope: Schema.Struct({ Body: Schema.Record(Schema.String, Schema.Unknown) }),
});

const Fault = Schema.Struct({
  detail: Schema.Struct({
    UPnPError: Schema.Struct({
      errorCode: Schema.FiniteFromString,
      errorDescription: Schema.optional(Schema.String),
    }),
  }),
});

// AVTransport 1.0: 704 "Format not supported for playback", 714 "Illegal MIME-type"
const formatErrors = new Set([704, 714]);
// AVTransport 1.0: 705 "Transport is locked", 715 "Content busy"
const busyErrors = new Set([705, 715]);

/** Arguments in the order of the service description. UPnP devices can reject another order. */
export type SoapArguments = ReadonlyArray<readonly [string, string | number]>;

const envelope = (serviceType: string, action: string, args: SoapArguments) => {
  const body = args.map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body.join("")}</u:${action}></s:Body>`,
    "</s:Envelope>",
  ].join("");
};

/** Calls a UPnP action and decodes its output arguments with `output` */
export const soap = Effect.fn("soap")(function* <S extends Schema.Constraint>(
  device: string,
  service: UpnpService,
  action: string,
  args: SoapArguments,
  output: S,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(service.controlUrl).pipe(
    HttpClientRequest.setHeader("SOAPACTION", `"${service.serviceType}#${action}"`),
    HttpClientRequest.bodyText(
      envelope(service.serviceType, action, args),
      'text/xml; charset="utf-8"',
    ),
  );
  const failed = (reason: string) => new CommandFailed({ device, command: action, reason });

  const text = yield* client.execute(request).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("5 seconds"),
    Effect.mapError((error) => new TargetUnreachable({ device, reason: error.message })),
  );
  const body = yield* decodeXml(Envelope, text).pipe(
    Effect.map((parsed) => parsed.Envelope.Body),
    Effect.mapError((error) => failed(`Unexpected SOAP response: ${error.reason}`)),
  );

  if ("Fault" in body) {
    const fault = yield* Schema.decodeUnknownEffect(Fault)(body.Fault).pipe(
      Effect.mapError(() => failed("Unexpected SOAP fault")),
    );
    const { errorCode, errorDescription } = fault.detail.UPnPError;
    const reason = `UPnP error ${errorCode} ${errorDescription ?? ""}`.trim();

    if (formatErrors.has(errorCode)) return yield* new UnsupportedFormat({ device, reason });
    if (busyErrors.has(errorCode)) return yield* new DeviceBusy({ device, reason });
    return yield* failed(reason);
  }

  return yield* Schema.decodeUnknownEffect(output)(body[`${action}Response`]).pipe(
    Effect.mapError((error) => failed(`Unexpected ${action} response: ${error.message}`)),
  );
});

/** Calls a UPnP action without reading its output */
export const soapCommand = (
  device: string,
  service: UpnpService,
  action: string,
  args: SoapArguments,
) => soap(device, service, action, args, Schema.Unknown).pipe(Effect.asVoid);

/** The service whose type has `name`, for example `AVTransport` */
export const findService = (services: ReadonlyArray<UpnpService>, name: string) =>
  services.find((service) => service.serviceType.split(":")[3] === name);
