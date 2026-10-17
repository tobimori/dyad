import { Data, Effect, Schema } from "effect";
import { XMLParser } from "fast-xml-parser";

// The parser returns one child as an object and more children as an array. These elements can
// repeat, so they are always arrays.
const repeated = new Set([
  "device",
  "service",
  "action",
  "property",
  "Volume",
  "ZoneGroup",
  "ZoneGroupMember",
  "Satellite",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => repeated.has(name),
});

export class XmlError extends Data.TaggedError("XmlError")<{ readonly reason: string }> {}

/** Parses `xml` with namespace prefixes removed, attributes as plain keys and all values as strings */
export const decodeXml = <S extends Schema.Constraint>(schema: S, xml: string) =>
  Effect.try({
    try: () => parser.parse(xml, true),
    catch: (error) => new XmlError({ reason: String(error) }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(schema)(parsed).pipe(
        Effect.mapError((error) => new XmlError({ reason: error.message })),
      ),
    ),
  );

export const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
