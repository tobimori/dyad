import { Data } from "effect";

/** An AirPlay receiver as its RAOP and AirPlay mDNS records describe it */
export class AirPlayDevice extends Data.Class<{
  /** Hardware address from the RAOP instance name, for example `804AF2A8E3C8` */
  readonly id: string;
  readonly name: string;
  readonly host: string;
  /** RTSP port of the RAOP service */
  readonly port: number;
  readonly model: string | undefined;
  /** `vs` */
  readonly version: string | undefined;
  /** `et`: 0 none, 1 RSA, 3 FairPlay, 4 MFiSAP, 5 FairPlay SAPv2.5 */
  readonly encryptions: ReadonlyArray<number>;
  /** `cn`: 0 PCM, 1 ALAC, 2 AAC, 3 AAC-ELD */
  readonly codecs: ReadonlyArray<number>;
  /** `md`: 0 text, 1 artwork, 2 progress */
  readonly metadata: ReadonlyArray<number>;
  /** `tp`, for example `["UDP"]` */
  readonly transports: ReadonlyArray<string>;
  /** `ch`, `sr` and `ss`. Receivers that leave them out take 2 channels of 16-bit 44.1 kHz. */
  readonly channels: number;
  readonly sampleRate: number;
  readonly sampleSize: number;
  /** `pk`: Ed25519 key in hex for AirPlay 2 pairing */
  readonly publicKey: string | undefined;
  readonly passwordRequired: boolean;
  /** HomeKit, PIN or one-time pairing, which needs AirPlay 2 */
  readonly pairingRequired: boolean;
  /** Feature bit 38 or 48, as pyatv 0.16 detects AirPlay 2 */
  readonly airPlay2: boolean;
}> {}

/** How a sender can reach the receiver over RAOP. `pairing` and `unsupported` need AirPlay 2. */
export const raopAccess = (device: AirPlayDevice) => {
  if (device.pairingRequired) return "pairing";

  const plain = device.encryptions.includes(0) || device.encryptions.includes(1);
  const alac = device.codecs.length === 0 || device.codecs.includes(1);
  const format = device.channels === 2 && device.sampleRate === 44100 && device.sampleSize === 16;
  const udp = device.transports.length === 0 || device.transports.includes("UDP");
  if (!plain || !alac || !format || !udp) return "unsupported";

  return device.passwordRequired ? "password" : "raop";
};

const statusPinRequired = 0x8;
const statusPasswordRequired = 0x80;
const statusOneTimePairing = 0x200;

const numbers = (text: string | undefined) =>
  (text ?? "")
    .split(",")
    .filter((part) => part.trim() !== "")
    .map(Number)
    .filter(Number.isInteger);

const integer = (text: string | undefined, fallback: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

// `ft` and `features` hold the low 32 bits first, for example "0x445F8A00,0x801C340"
const featureBits = (text: string | undefined) => {
  const match = /^(0x[0-9a-f]{1,8})(?:,(0x[0-9a-f]{1,8}))?$/i.exec(text ?? "");
  if (match === null) return 0n;

  const [, low = "0", high = "0"] = match;
  return (BigInt(high) << 32n) | BigInt(low);
};

const hexNumber = (text: string | undefined) => Number.parseInt(text ?? "0", 16) || 0;

/** Builds a device from the TXT keys of its RAOP record and of its AirPlay record, if any */
export const deviceFromRecords = (record: {
  /** RAOP instance name without the service, for example `804AF2A8E3C8@Wohnen` */
  readonly instance: string;
  readonly host: string;
  readonly port: number;
  readonly raop: ReadonlyMap<string, string>;
  readonly airPlay: ReadonlyMap<string, string> | undefined;
}) => {
  const separator = record.instance.indexOf("@");
  const raop = record.raop;
  const airPlay = record.airPlay ?? new Map<string, string>();

  const status = hexNumber(raop.get("sf")) | hexNumber(airPlay.get("flags"));
  const features = featureBits(airPlay.get("features") ?? raop.get("ft"));

  return new AirPlayDevice({
    id: record.instance.slice(0, Math.max(separator, 0)),
    name: record.instance.slice(separator + 1),
    host: record.host,
    port: record.port,
    model: raop.get("am") ?? airPlay.get("model"),
    version: raop.get("vs"),
    encryptions: numbers(raop.get("et")),
    codecs: numbers(raop.get("cn")),
    metadata: numbers(raop.get("md")),
    transports: (raop.get("tp") ?? "").split(",").filter((part) => part !== ""),
    channels: integer(raop.get("ch"), 2),
    sampleRate: integer(raop.get("sr"), 44100),
    sampleSize: integer(raop.get("ss"), 16),
    publicKey: raop.get("pk") ?? airPlay.get("pk"),
    passwordRequired:
      raop.get("pw") === "true" ||
      airPlay.get("pw") === "true" ||
      (status & statusPasswordRequired) !== 0,
    // `act=2` and `acl=1` are access control settings that only a paired sender passes
    pairingRequired:
      (status & (statusPinRequired | statusOneTimePairing)) !== 0 ||
      airPlay.get("act") === "2" ||
      airPlay.get("acl") === "1",
    airPlay2: (features & ((1n << 38n) | (1n << 48n))) !== 0n,
  });
};
