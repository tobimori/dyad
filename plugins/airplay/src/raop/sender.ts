// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto is async and pads AES-CBC; each audio packet needs synchronous unpadded CBC
import * as Crypto from "node:crypto";

import { NodeDatagramSocket } from "@effect/platform-node";
import { Data, Duration, Effect, Stream } from "effect";
import { NetAddress } from "effect/net";

import { encodeAlac, framesPerPacket } from "./alac.ts";
import { type AirPlayDevice, raopAccess } from "../device.ts";
import {
  AirPlayAuthRequired,
  type AirPlayError,
  AirPlayNetworkError,
  AirPlayUnsupported,
} from "../errors.ts";
import { addFrames, millisBetween, NtpClock, type NtpTime } from "./ntp.ts";
import { connectRtsp } from "./rtsp.ts";

const sampleRate = 44100;

// With sync flags 7, as iTunes sends them, receivers play 11025 frames later than the latency
// in the sync packet
const receiverDelayFrames = 11025;

// About 8 seconds of packets for retransmit requests
const historySize = 1024;

// One sync packet per 125 audio packets, about once per second
const syncInterval = 125 * framesPerPacket;

// Receivers with `et=1` decrypt the AES key with the private key of the AirPort Express
const airPortKey = Crypto.createPublicKey({
  format: "jwk",
  key: {
    kty: "RSA",
    e: "AQAB",
    n:
      "59dE8qLieItsH1WgjrcFRKj6eUWqi-bGLOX1HL3U3GhC_j0Qg90u3sG_1CUtwC5vOYvfDmFI6oSFXi5ELabWJmT2dKH" +
      "zBJKa3k9ok-8t9ucRqMd6DZHJ2YCCLlDRKSKv6kDqnw4UwPdpOMXziC_AMj3Z_lUVX1G7WSHCAWKf1zNS1eLvqr-boE" +
      "jXuBOitnZ_bDzPHrTOZz0Dew0uowxf_-sG-NCK3eQJVxqcaJ_vEHKIVd2M-5qL71yJQ-87X6oV3eaYvt3zWZYD6z5v" +
      "YTcrtij2VZ9Zmni_UAaHqn9JdsBWLUEpVviYnhimNVvYFZeCXg_IdTQ-x4IRdiXNv5hEew",
  },
});

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");
const randomUint32 = () => Crypto.randomBytes(4).readUInt32BE();

/** Cover art for `setMetadata` */
export class Artwork extends Data.Class<{
  readonly bytes: Uint8Array;
  readonly mimeType: "image/jpeg" | "image/png";
}> {}

export class TrackMetadata extends Data.Class<{
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artwork?: Artwork;
  /** With `durationMs`, the receiver shows progress */
  readonly startAt?: NtpTime;
  readonly durationMs?: number;
}> {}

export class PlayResult extends Data.Class<{
  /** When the receiver plays the end of the source */
  readonly endAt: NtpTime;
  /** `flush` stopped the source before its end */
  readonly stopped: boolean;
}> {}

export class SenderStats extends Data.Class<{
  readonly packets: number;
  readonly resent: number;
  /** Retransmit requests for packets that are no longer in the history */
  readonly missed: number;
}> {}

// A DMAP item: a 4-character tag, a 32-bit length and the data
const dmap = (tag: string, ...data: ReadonlyArray<Uint8Array>) => {
  const length = data.reduce((total, part) => total + part.length, 0);
  const item = new Uint8Array(8 + length);
  item.set(encoder.encode(tag));
  new DataView(item.buffer).setUint32(4, length);

  let offset = 8;
  for (const part of data) {
    item.set(part, offset);
    offset += part.length;
  }
  return item;
};

const toInt16 = (chunk: Int16Array | Float32Array) =>
  chunk instanceof Int16Array
    ? chunk
    : Int16Array.from(chunk, (sample) =>
        Math.max(-32768, Math.min(32767, Math.round(sample * 32768))),
      );

/** An open RAOP session with one receiver */
export class RaopSender extends Data.Class<{
  readonly device: AirPlayDevice;
  /** How long before its play time a frame is sent. The receiver buffers this much audio. */
  readonly leadMs: number;
  /**
   * Plays interleaved 44.1 kHz stereo PCM so that its first frame plays at `startAt`. Run one at a
   * time, and `flush` first to drop audio that the receiver still holds.
   */
  readonly play: <E, R>(
    source: Stream.Stream<Int16Array | Float32Array, E, R>,
    startAt: NtpTime,
  ) => Effect.Effect<PlayResult, E | AirPlayNetworkError, R>;
  /** 0 mutes, 1 is full volume. Volume is linear in dB from -30 dB to 0 dB. */
  readonly setVolume: (volume: number) => Effect.Effect<void, AirPlayError>;
  /** Sends what the receiver shows, as far as its `md` record allows */
  readonly setMetadata: (metadata: TrackMetadata) => Effect.Effect<void, AirPlayError>;
  /** Stops a running `play` and makes the receiver drop all audio that it holds */
  readonly flush: Effect.Effect<void, AirPlayError>;
  readonly stats: Effect.Effect<SenderStats>;
  /** Fails when the receiver closes the connection, for example for another sender */
  readonly closed: Effect.Effect<never, AirPlayNetworkError>;
}> {}

/**
 * Opens a RAOP session: RTSP setup, the UDP ports for audio, control and timing, and the NTP
 * responder. Closing the scope stops the session with TEARDOWN.
 */
export const openRaopSender = Effect.fn("AirPlay.openSender")(function* (
  device: AirPlayDevice,
  options: {
    /** Answers the Digest challenge of a receiver with `pw=true` */
    readonly password?: string;
    /** At least 500 ms. iTunes uses 2000 ms, the default. */
    readonly leadMs?: number;
  } = {},
) {
  const clock = yield* NtpClock;
  const access = raopAccess(device);

  if (access === "pairing") {
    return yield* new AirPlayUnsupported({
      device: device.name,
      reason: "the receiver needs AirPlay 2 pairing",
    });
  }
  if (access === "unsupported") {
    return yield* new AirPlayUnsupported({
      device: device.name,
      reason:
        "the receiver needs FairPlay, a codec other than ALAC or a format other than 44.1 kHz 16-bit stereo over UDP",
    });
  }
  if (access === "password" && options.password === undefined) {
    return yield* new AirPlayAuthRequired({ device: device.name });
  }

  const leadMs = Math.max(options.leadMs ?? 2000, 500);
  const leadFrames = Math.round((leadMs / 1000) * sampleRate);
  const networkError = (cause: unknown) => new AirPlayNetworkError({ device: device.name, cause });

  const openUdp = Effect.gen(function* () {
    // @effect-diagnostics-next-line experimentalApiUsage:off -- Effect has no stable UDP socket
    const socket = yield* NodeDatagramSocket.make();
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    return { reader, writer };
  }).pipe(Effect.mapError(networkError));
  const control = yield* openUdp;
  const timing = yield* openUdp;
  const audio = yield* openUdp;

  const rtsp = yield* connectRtsp({ ...device, password: options.password });
  const sessionId = randomUint32();
  const uri = `rtsp://${rtsp.localAddress}/${sessionId}`;
  const clientId = Crypto.randomBytes(8).toString("hex").toUpperCase();
  const client = {
    "DACP-ID": clientId,
    "Active-Remote": String(randomUint32()),
    "Client-Instance": clientId,
  };

  yield* rtsp.request("OPTIONS", "*", {
    headers: { ...client, "Apple-Challenge": base64(Crypto.randomBytes(16)) },
  });

  // An AirPort Express with MFiSAP plays nothing until it gets a Curve25519 key. It does not check
  // the key.
  if (device.encryptions.includes(4) && device.model?.startsWith("AirPort")) {
    const key = Crypto.generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x ?? "";
    yield* rtsp.request("POST", "/auth-setup", {
      protocol: "HTTP/1.1",
      headers: { ...client, "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, ...Buffer.from(key, "base64url")]),
    });
  }

  // RSA only when the receiver cannot play unencrypted audio
  const encryption = device.encryptions.includes(0)
    ? undefined
    : { key: Crypto.randomBytes(16), iv: Crypto.randomBytes(16) };
  const encryptionLines =
    encryption === undefined
      ? []
      : [
          `a=rsaaeskey:${base64(
            Crypto.publicEncrypt(
              { key: airPortKey, padding: Crypto.constants.RSA_PKCS1_OAEP_PADDING },
              encryption.key,
            ),
          )}`,
          `a=aesiv:${base64(encryption.iv)}`,
        ];
  const sdp = [
    "v=0",
    `o=iTunes ${sessionId} 0 IN IP4 ${rtsp.localAddress}`,
    "s=iTunes",
    `c=IN IP4 ${rtsp.remoteAddress}`,
    "t=0 0",
    "m=audio 0 RTP/AVP 96",
    "a=rtpmap:96 AppleLossless",
    `a=fmtp:96 ${framesPerPacket} 0 16 40 10 14 2 255 0 0 ${sampleRate}`,
    ...encryptionLines,
    "",
  ].join("\r\n");
  yield* rtsp.request("ANNOUNCE", uri, {
    headers: { ...client, "Content-Type": "application/sdp" },
    body: encoder.encode(sdp),
  });

  const setup = yield* rtsp.request("SETUP", uri, {
    headers: {
      ...client,
      Transport:
        "RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;" +
        `control_port=${control.reader.address.port};timing_port=${timing.reader.address.port}`,
    },
  });
  const transport = new Map(
    (setup.headers.get("transport") ?? "").split(";").map((part) => {
      const [name = "", value] = part.split("=");
      return [name, Number(value)] as const;
    }),
  );
  const serverPort = transport.get("server_port");
  const controlPort = transport.get("control_port");
  if (!serverPort || !controlPort) {
    return yield* new AirPlayUnsupported({
      device: device.name,
      reason: "the SETUP answer has no server or control port",
    });
  }
  const audioAddress = NetAddress.inetAddressFromIpStringUnsafe(rtsp.remoteAddress, serverPort);
  const controlAddress = NetAddress.inetAddressFromIpStringUnsafe(rtsp.remoteAddress, controlPort);
  const session = { ...client, Session: setup.headers.get("session") ?? "1" };

  let sequence = randomUint32() & 0xffff;
  let rtpTime = randomUint32();
  const ssrc = randomUint32();

  const record = yield* rtsp.request("RECORD", uri, {
    headers: { ...session, Range: "npt=0-", "RTP-Info": `seq=${sequence};rtptime=${rtpTime}` },
  });
  yield* Effect.logDebug("AirPlay session started", {
    device: device.name,
    encrypted: encryption !== undefined,
    receiverLatency: record.headers.get("audio-latency"),
  });
  yield* Effect.addFinalizer(() =>
    rtsp
      .request("TEARDOWN", uri, { headers: session })
      .pipe(Effect.timeout("2 seconds"), Effect.ignore),
  );

  // The receiver measures its offset to `clock` with these exchanges
  const answerTiming = Effect.gen(function* () {
    const datagrams = yield* timing.reader.pull;
    const receivedAt = yield* clock.now;

    for (const datagram of datagrams) {
      const request = new DataView(datagram.payload.buffer, datagram.payload.byteOffset);
      if (datagram.payload.length < 32 || (request.getUint8(1) & 0x7f) !== 0x52) continue;

      const reply = new Uint8Array(32);
      const view = new DataView(reply.buffer);
      reply.set([0x80, 0xd3, 0x00, 0x07]);
      reply.set(datagram.payload.subarray(24, 32), 8);
      view.setBigUint64(16, receivedAt);
      view.setBigUint64(24, yield* clock.now);
      yield* timing.writer.write({ payload: reply, address: datagram.address });
    }
  });

  const history = Array.from<Uint8Array | undefined>({ length: historySize });
  let packets = 0;
  let resent = 0;
  let missed = 0;

  const answerRetransmits = Effect.gen(function* () {
    for (const datagram of yield* control.reader.pull) {
      const request = new DataView(datagram.payload.buffer, datagram.payload.byteOffset);
      if (datagram.payload.length < 8 || (request.getUint8(1) & 0x7f) !== 0x55) continue;

      const first = request.getUint16(4);
      const count = Math.min(request.getUint16(6), historySize);
      for (let index = 0; index < count; index++) {
        const wanted = (first + index) & 0xffff;
        const packet = history[wanted % historySize];
        if (packet === undefined || new DataView(packet.buffer).getUint16(2) !== wanted) {
          missed += 1;
          continue;
        }

        const payload = new Uint8Array(4 + packet.length);
        payload.set([0x80, 0xd6, wanted >> 8, wanted & 0xff]);
        payload.set(packet, 4);
        yield* control.writer.write({ payload, address: datagram.address });
        resent += 1;
      }
    }
  });

  const keepAlive = Effect.sleep("30 seconds").pipe(
    Effect.andThen(rtsp.request("OPTIONS", "*", { headers: client })),
  );

  const background = <A, E>(name: string, loop: Effect.Effect<A, E>) =>
    Effect.forkScoped(
      Effect.forever(loop).pipe(
        Effect.tapError((error) => Effect.logWarning(`AirPlay ${name} stopped`, error)),
        Effect.annotateLogs({ device: device.name }),
      ),
    );
  yield* background("timing", answerTiming);
  yield* background("retransmit", answerRetransmits);
  yield* background("keep-alive", keepAlive);

  // `flush` increments `generation`, which ends the `play` that started before it
  let generation = 0;
  // The next packet starts a stream: the marker bit and sync type 0x90 tell the receiver
  let restart = true;
  let mapping: { readonly rtp: number; readonly ntp: NtpTime } | undefined;

  const encrypt = (payload: Uint8Array) => {
    if (encryption === undefined) return payload;

    // Only whole blocks are encrypted; the rest of the payload stays as it is
    const whole = payload.length - (payload.length % 16);
    const cipher = Crypto.createCipheriv("aes-128-cbc", encryption.key, encryption.iv);
    payload.set(cipher.setAutoPadding(false).update(payload.subarray(0, whole)));
    return payload;
  };

  // Frame `rtp` plays at `playAt`. Receivers apply the latency in the packet and 11025 frames more.
  const syncPacket = (rtp: number, playAt: NtpTime) => {
    const packet = new Uint8Array(20);
    const view = new DataView(packet.buffer);
    packet.set([restart ? 0x90 : 0x80, 0xd4, 0x00, 0x07]);
    view.setUint32(4, (rtp - (leadFrames - receiverDelayFrames)) >>> 0);
    view.setBigUint64(8, addFrames(playAt, -leadFrames, sampleRate));
    view.setUint32(16, rtp);
    return packet;
  };

  const audioPacket = (samples: Int16Array) => {
    const payload = encrypt(encodeAlac(samples));
    const packet = new Uint8Array(12 + payload.length);
    const view = new DataView(packet.buffer);
    packet.set([0x80, restart ? 0xe0 : 0x60]);
    view.setUint16(2, sequence);
    view.setUint32(4, rtpTime);
    view.setUint32(8, ssrc);
    packet.set(payload, 12);
    return packet;
  };

  const play = <E, R>(source: Stream.Stream<Int16Array | Float32Array, E, R>, startAt: NtpTime) =>
    Effect.gen(function* () {
      const own = generation;
      const startRtp = rtpTime;
      mapping = { rtp: startRtp, ntp: startAt };

      const pending = new Int16Array(framesPerPacket * 2);
      let filled = 0;
      let frames = 0;

      // Returns `false` when a `flush` ended this play
      const send = Effect.gen(function* () {
        const playAt = addFrames(startAt, frames, sampleRate);
        const wait = millisBetween(yield* clock.now, addFrames(playAt, -leadFrames, sampleRate));
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
        if (generation !== own) return false;

        // The state changes before the first write, so that a `flush` during a write gets the
        // next sequence number and the receiver drops this packet
        const sync =
          frames % syncInterval === 0 ? syncPacket(startRtp + frames, playAt) : undefined;
        const packet = audioPacket(pending);
        history[sequence % historySize] = packet;
        packets += 1;
        frames += framesPerPacket;
        sequence = (sequence + 1) & 0xffff;
        rtpTime = (rtpTime + framesPerPacket) >>> 0;
        restart = false;

        if (sync !== undefined) {
          yield* control.writer.write({ payload: sync, address: controlAddress });
        }
        yield* audio.writer.write({ payload: packet, address: audioAddress });

        // A late start catches up at 4 times real time, so that the receiver's socket buffer
        // does not overflow
        if (wait < 0) yield* Effect.sleep("2 millis");
        return true;
      });

      yield* Stream.runForEachWhile(source, (chunk) =>
        Effect.gen(function* () {
          const samples = toInt16(chunk);
          for (let offset = 0; offset < samples.length;) {
            const count = Math.min(samples.length - offset, pending.length - filled);
            pending.set(samples.subarray(offset, offset + count), filled);
            filled += count;
            offset += count;
            if (filled < pending.length) continue;

            filled = 0;
            if (!(yield* send)) return false;
          }
          return true;
        }),
      );

      const endFrames = frames + Math.floor(filled / 2);
      if (filled > 0 && generation === own) {
        pending.fill(0, filled);
        yield* send;
      }

      return new PlayResult({
        endAt: addFrames(startAt, endFrames, sampleRate),
        stopped: generation !== own,
      });
    }).pipe(
      Effect.catchTag("DatagramSocketError", (cause) => Effect.fail(networkError(cause))),
      Effect.raceFirst(rtsp.closed),
      Effect.annotateLogs({ device: device.name }),
    );

  const setVolume = (volume: number) => {
    const decibels = volume <= 0 ? -144 : -30 + 30 * Math.min(volume, 1);
    return rtsp
      .request("SET_PARAMETER", uri, {
        headers: { ...session, "Content-Type": "text/parameters" },
        body: encoder.encode(`volume: ${decibels.toFixed(6)}\r\n`),
      })
      .pipe(Effect.asVoid);
  };

  const rtpAt = (time: NtpTime | undefined) =>
    mapping === undefined || time === undefined
      ? rtpTime
      : (mapping.rtp + Math.round((millisBetween(mapping.ntp, time) / 1000) * sampleRate)) >>> 0;

  const setMetadata = Effect.fn("AirPlay.setMetadata")(function* (metadata: TrackMetadata) {
    const start = rtpAt(metadata.startAt);
    const parameter = (contentType: string, body: Uint8Array) =>
      rtsp.request("SET_PARAMETER", uri, {
        headers: { ...session, "Content-Type": contentType, "RTP-Info": `rtptime=${start}` },
        body,
      });

    if (device.metadata.includes(0)) {
      const items = [
        dmap("minm", encoder.encode(metadata.title)),
        ...(metadata.artist === undefined ? [] : [dmap("asar", encoder.encode(metadata.artist))]),
        ...(metadata.album === undefined ? [] : [dmap("asal", encoder.encode(metadata.album))]),
      ];
      yield* parameter("application/x-dmap-tagged", dmap("mlit", ...items));
    }

    if (device.metadata.includes(1) && metadata.artwork !== undefined) {
      yield* parameter(metadata.artwork.mimeType, metadata.artwork.bytes);
    }

    const durationMs = metadata.durationMs;
    if (device.metadata.includes(2) && metadata.startAt !== undefined && durationMs !== undefined) {
      const now = rtpAt(yield* clock.now);
      const end = (start + Math.round((durationMs / 1000) * sampleRate)) >>> 0;
      yield* parameter("text/parameters", encoder.encode(`progress: ${start}/${now}/${end}\r\n`));
    }
  });

  const flush = Effect.gen(function* () {
    generation += 1;
    restart = true;
    mapping = undefined;
    yield* rtsp.request("FLUSH", uri, {
      headers: { ...session, "RTP-Info": `seq=${sequence};rtptime=${rtpTime}` },
    });
  });

  return new RaopSender({
    device,
    leadMs,
    play,
    setVolume,
    setMetadata,
    flush,
    stats: Effect.sync(() => new SenderStats({ packets, resent, missed })),
    closed: rtsp.closed,
  });
});
