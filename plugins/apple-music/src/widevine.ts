import { CDM, Device, KeyType, PSSH } from "@li0ard/widevine";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";

import { AppleMusicError, exchangeLicense } from "./api.ts";
import type { AppleSession } from "./api.ts";
import { wvd } from "./wvd.ts";

const widevineSystem = "edef8ba979d64acea3c827dcd51d21ed";

const keyUri = (playlist: string) =>
  Effect.gen(function* () {
    // Only the DRM URI is needed here. `hls.ts` reads the media segments.
    const uris = playlist.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("#EXT-X-KEY:")) return [];
      const attributes = new Map(
        [...line.slice(11).matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(
          (match) => [match[1], match[2] ?? match[3]] as const,
        ),
      );
      const format = attributes.get("KEYFORMAT");
      const uri = attributes.get("URI");
      const method = attributes.get("METHOD");
      if (format !== undefined && format !== `urn:uuid:${"edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"}`) {
        return [];
      }
      // Apple's AAC web route labels CENC `ISO-23001-7`, not `SAMPLE-AES-CTR`
      if ((method !== "ISO-23001-7" && method !== "SAMPLE-AES-CTR") || uri === undefined) {
        return [];
      }
      return [uri];
    });
    const unique = [...new Set(uris)];
    if (unique.length !== 1 || unique[0] === undefined) {
      return yield* new AppleMusicError({
        stage: "playlist",
        reason: "Expected one Widevine CENC key URI",
      });
    }
    const uri = unique[0];
    if (!uri.startsWith("data:")) {
      return yield* new AppleMusicError({
        stage: "playlist",
        reason: "Unsupported DRM URI format",
      });
    }
    const payload = yield* Schema.decodeEffect(Schema.Uint8ArrayFromBase64)(
      uri.slice(uri.indexOf(",") + 1),
    ).pipe(
      Effect.mapError(
        () => new AppleMusicError({ stage: "playlist", reason: "Invalid DRM initialization data" }),
      ),
    );
    return { uri, payload };
  });

/** Gets keys through the subscriber's license endpoint with the bundled device */
export const acquireAppleKeys = (session: AppleSession, songId: string, assetUrl: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cdm = yield* Effect.try({
        // Widevine 0.1.6 reads a `DataView` from offset zero, so a pooled Buffer must be copied
        try: () => new CDM(Device.fromWvd(Uint8Array.from(Buffer.from(wvd, "base64")))),
        catch: () => new AppleMusicError({ stage: "device", reason: "Invalid bundled WVD device" }),
      });
      const cdmSession = yield* Effect.acquireRelease(
        Effect.try({
          try: () => cdm.open(),
          catch: () =>
            new AppleMusicError({ stage: "device", reason: "Cannot open the device session" }),
        }),
        (id) => Effect.sync(() => cdm.close(id)),
      );
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const playlist = yield* client.get(assetUrl).pipe(
        Effect.flatMap((response) => response.text),
        Effect.mapError(
          () =>
            new AppleMusicError({ stage: "playlist", reason: "Cannot read the asset playlist" }),
        ),
      );
      const { uri, payload } = yield* keyUri(playlist);
      const pssh = yield* Effect.try({
        try: () => {
          if (Buffer.from(payload.subarray(4, 8)).toString("ascii") === "pssh")
            return PSSH.decode(payload);
          // Apple can give only the 16-byte KID instead of a full Widevine PSSH payload
          const data = payload.length === 16 ? new Uint8Array([8, 1, 18, 16, ...payload]) : payload;
          return new PSSH(0, 0, Buffer.from(widevineSystem, "hex"), [], data);
        },
        catch: () =>
          new AppleMusicError({ stage: "license", reason: "Invalid Widevine initialization data" }),
      });
      const challenge = yield* Effect.try({
        try: () => cdm.getLicenseChallenge(cdmSession, pssh),
        catch: () =>
          new AppleMusicError({ stage: "license", reason: "Cannot create the license challenge" }),
      });
      const license = yield* exchangeLicense(session, songId, uri, challenge);
      const keys = yield* Effect.try({
        try: () =>
          new Map(
            cdm
              .parseLicense(cdmSession, license)
              .flatMap((key) =>
                key.type === KeyType.CONTENT
                  ? [
                      [
                        Buffer.from(key.kid).toString("hex"),
                        Buffer.from(key.key).toString("hex"),
                      ] as const,
                    ]
                  : [],
              ),
          ),
        catch: () =>
          new AppleMusicError({ stage: "license", reason: "Cannot validate the license response" }),
      });
      if (keys.size === 0) {
        return yield* new AppleMusicError({
          stage: "license",
          reason: "License contains no content keys",
        });
      }
      return Redacted.make(keys);
    }),
  );
