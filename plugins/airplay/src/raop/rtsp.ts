// @effect-diagnostics-next-line nodeBuiltinImport:off -- RTSP Digest needs MD5, which WebCrypto does not have
import { createHash } from "node:crypto";
import * as Net from "node:net";

import { Cause, Data, Deferred, Effect, Queue, Semaphore } from "effect";

import { AirPlayAuthRequired, AirPlayNetworkError, AirPlayRequestFailed } from "../errors.ts";

export class RtspResponse extends Data.Class<{
  readonly status: number;
  /** Lowercase names */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
}> {}

const encoder = new TextEncoder();
const headerEnd = encoder.encode("\r\n\r\n");

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

// Returns the response and the bytes after it, or `undefined` while the response is incomplete
const parseResponse = (buffer: Uint8Array) => {
  const end = buffer.findIndex((_, index) =>
    headerEnd.every((byte, offset) => buffer[index + offset] === byte),
  );
  if (end < 0) return undefined;

  const [statusLine = "", ...lines] = new TextDecoder()
    .decode(buffer.subarray(0, end))
    .split("\r\n");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const split = line.indexOf(":");
    if (split > 0) {
      headers.set(line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim());
    }
  }

  const bodyStart = end + headerEnd.length;
  const bodyEnd = bodyStart + Number(headers.get("content-length") ?? 0);
  if (buffer.length < bodyEnd) return undefined;

  const status = Number(statusLine.split(" ")[1]);
  const body = buffer.slice(bodyStart, bodyEnd);
  return { response: new RtspResponse({ status, headers, body }), rest: buffer.subarray(bodyEnd) };
};

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

// RTSP Digest (RFC 2069) without `qop`, as AirPort receivers expect
const digest = (options: {
  readonly challenge: string;
  readonly password: string;
  readonly method: string;
  readonly uri: string;
}) => {
  const realm = /realm="([^"]*)"/.exec(options.challenge)?.[1] ?? "";
  const nonce = /nonce="([^"]*)"/.exec(options.challenge)?.[1] ?? "";
  const user = "iTunes";
  const secret = md5(`${user}:${realm}:${options.password}`);
  const response = md5(`${secret}:${nonce}:${md5(`${options.method}:${options.uri}`)}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${options.uri}", response="${response}"`;
};

/** Opens an RTSP connection to a RAOP receiver. Requests run one at a time. */
export const connectRtsp = Effect.fn("AirPlay.connectRtsp")(function* (target: {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** Answers a Digest challenge */
  readonly password: string | undefined;
}) {
  const networkError = (cause: unknown) => new AirPlayNetworkError({ device: target.name, cause });

  const socket = yield* Effect.acquireRelease(
    Effect.callback<Net.Socket, AirPlayNetworkError>((resume) => {
      const socket = Net.createConnection({ host: target.host, port: target.port });
      socket.setNoDelay(true);
      socket.once("connect", () => resume(Effect.succeed(socket)));
      socket.once("error", (cause) => resume(Effect.fail(networkError(cause))));
      return Effect.sync(() => socket.destroy());
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(networkError("connect timed out")),
      }),
    ),
    (socket) => Effect.sync(() => socket.destroy()),
  );

  const incoming = yield* Queue.unbounded<Uint8Array, AirPlayNetworkError>();
  const closed = yield* Deferred.make<never, AirPlayNetworkError>();
  const close = (cause: unknown) => {
    Queue.failCauseUnsafe(incoming, Cause.fail(networkError(cause)));
    Deferred.doneUnsafe(closed, Effect.fail(networkError(cause)));
  };
  socket.on("data", (chunk) => Queue.offerUnsafe(incoming, chunk));
  socket.on("error", close);
  socket.on("close", () => close("connection closed"));

  const lock = yield* Semaphore.make(1);
  let sequence = 0;
  let buffered: Uint8Array = new Uint8Array(0);
  let authorization: { readonly challenge: string; readonly password: string } | undefined;

  const readResponse = Effect.gen(function* () {
    while (true) {
      const parsed = parseResponse(buffered);
      if (parsed !== undefined) {
        buffered = parsed.rest;
        return parsed.response;
      }
      buffered = concat([buffered, yield* Queue.take(incoming)]);
    }
  });

  const write = (bytes: Uint8Array) =>
    Effect.callback<void, AirPlayNetworkError>((resume) => {
      socket.write(bytes, (cause) =>
        resume(cause ? Effect.fail(networkError(cause)) : Effect.void),
      );
    });

  /** Sends a request. It answers a 401 once with the password, if there is one. */
  const request = (
    method: string,
    uri: string,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: Uint8Array;
      /** AirPort `/auth-setup` is HTTP on the RTSP connection */
      readonly protocol?: string;
    } = {},
  ) => {
    const send = Effect.gen(function* () {
      sequence += 1;
      const headers = {
        CSeq: String(sequence),
        "User-Agent": "AirPlay/381.13",
        ...(authorization && { Authorization: digest({ ...authorization, method, uri }) }),
        ...options.headers,
        ...(options.body && { "Content-Length": String(options.body.length) }),
      };
      const head = [
        `${method} ${uri} ${options.protocol ?? "RTSP/1.0"}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "\r\n",
      ].join("\r\n");

      yield* write(concat([encoder.encode(head), options.body ?? new Uint8Array(0)]));
      const response = yield* readResponse.pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(networkError(`no answer to ${method}`)),
        }),
      );
      yield* Effect.logDebug("AirPlay RTSP", { method, status: response.status });
      return response;
    });

    return Effect.gen(function* () {
      const first = yield* send;
      const challenge = first.headers.get("www-authenticate");
      const password = target.password;
      const retry = first.status === 401 && challenge !== undefined && password !== undefined;
      if (retry) authorization = { challenge, password };
      const response = retry ? yield* send : first;

      if (response.status === 401) {
        return yield* new AirPlayAuthRequired({ device: target.name });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new AirPlayRequestFailed({
          device: target.name,
          method,
          status: response.status,
        });
      }
      return response;
    }).pipe(lock.withPermits(1));
  };

  return {
    request,
    /** Fails when the connection closes */
    closed: Deferred.await(closed),
    localAddress: socket.localAddress ?? "0.0.0.0",
    remoteAddress: socket.remoteAddress ?? target.host,
  };
});
