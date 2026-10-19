import { Crypto, Effect } from "effect";

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const fromHex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

// Every catalog ID depends on this namespace; it must never change
const namespace = fromHex("5162e6fc8cee458490d95da3fb86a603");

/** RFC 9562 UUID version 5: SHA-1 of the Dyad namespace and `name` */
export const uuidV5 = (name: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-1", new Uint8Array([...namespace, ...new TextEncoder().encode(name)]))
      .pipe(Effect.orDie);

    // The version (5) is in the high bits of byte 6, and the variant (`10`) in the high bits of byte 8
    const bytes = digest.subarray(0, 16).map((byte, index) => {
      if (index === 6) return (byte & 0x0f) | 0x50;
      if (index === 8) return (byte & 0x3f) | 0x80;
      return byte;
    });

    const digits = hex(bytes);
    return [
      digits.slice(0, 8),
      digits.slice(8, 12),
      digits.slice(12, 16),
      digits.slice(16, 20),
      digits.slice(20),
    ].join("-");
  });

/** The ID of the `source_preference` row of the `global` scope */
export const sourcePreferenceId = uuidV5("source_preference:global");

/** The ID of one library membership: one row per entity and origin */
export const libraryItemId = (item: {
  readonly entityType: string;
  readonly entityId: string;
  readonly origin: string;
}) => uuidV5(`library_item:${item.entityType}:${item.entityId}:${item.origin}`);

/** The release of a provider album: the entity of a saved album until release groups exist */
export const providerReleaseId = (provider: string, externalId: string) =>
  uuidV5(`${provider}:release:${externalId}`);

/** Equal to the server's `artistIdOf` for a provider scheme */
export const providerArtistId = (provider: string, externalId: string) =>
  uuidV5(`${provider}:artist:${externalId}`);
