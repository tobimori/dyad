import { device, serverPeer } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  Authentication,
  AuthenticationFailed,
  CurrentPrincipal,
  DeviceId,
  DeviceSession,
  DeviceSummary,
  PairingCode,
  Principal,
  Unauthorized,
} from "@dyad/domain";
import { eq } from "drizzle-orm";
import { Clock, Context, Crypto, Effect, Layer, Ref } from "effect";

import { hex } from "./ids.ts";
import { Sessions } from "./sessions.ts";

export const randomBytes = (size: number) =>
  Crypto.Crypto.use((crypto) => crypto.randomBytes(size)).pipe(Effect.orDie);

export const sha256 = Effect.fn("sha256")(
  function* (value: string) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(value));
    return hex(digest);
  },
  (effect) => effect.pipe(Effect.orDie),
);

// No 0, O, 1 or I, so that a code read from a screen is typed correctly
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const randomCode = Effect.gen(function* () {
  const bytes = yield* randomBytes(8);
  // 256 is a multiple of the 32 characters, so each character has the same probability
  const characters = Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
});

export const normalizeCode = (code: string) => {
  const characters = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
};

const codeLifetimeMs = 10 * 60 * 1000;

/**
 * Pairing codes for devices and replicas. They stay in memory, so a restart cancels them. While the
 * replica has no paired device and no paired replica, its log shows a code that does not expire.
 */
export class PairingCodes extends Context.Service<
  PairingCodes,
  Ref.Ref<ReadonlyMap<string, number>>
>()("@dyad/server-core/PairingCodes") {}

export const pairingCodesLayer = Layer.effect(
  PairingCodes,
  Effect.gen(function* () {
    const db = yield* Database;
    const codes = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    if ((yield* db.$count(device)) + (yield* db.$count(serverPeer)) > 0) return codes;

    const code = yield* randomCode;
    yield* Ref.set(codes, new Map([[code, Number.POSITIVE_INFINITY]]));
    // The only way in, so the operator must see it
    yield* Effect.logWarning(
      `Nothing is paired. Pair the first device or replica with code ${code}`,
    );
    return codes;
  }).pipe(Effect.orDie),
);

export const createPairingCode = Effect.gen(function* () {
  const codes = yield* PairingCodes;
  const now = yield* Clock.currentTimeMillis;
  const code = yield* randomCode;
  const expiresAt = now + codeLifetimeMs;

  yield* Ref.update(codes, (pending) =>
    new Map([...pending].filter(([, expiry]) => expiry > now)).set(code, expiresAt),
  );
  return new PairingCode({ code, expiresAt });
});

/** Removes the code, because a code works once. `false` if it is wrong or expired. */
export const redeemCode = Effect.fn("redeemCode")(function* (code: string) {
  const codes = yield* PairingCodes;
  const now = yield* Clock.currentTimeMillis;
  const normalized = normalizeCode(code);
  const expiresAt = yield* Ref.modify(codes, (pending) => {
    const next = new Map(pending);
    next.delete(normalized);
    return [pending.get(normalized), next];
  });
  return expiresAt !== undefined && expiresAt > now;
});

/** Adds a device and returns its token */
export const createDevice = Effect.fn("createDevice")(function* (name: string) {
  const db = yield* Database;
  const crypto = yield* Crypto.Crypto;
  const token = hex(yield* randomBytes(32));
  const id = DeviceId.make(yield* crypto.randomUUIDv7().pipe(Effect.orDie));

  yield* db.insert(device).values({
    id,
    name,
    tokenHash: yield* sha256(token),
    createdAt: yield* Clock.currentTimeMillis,
  });

  return new DeviceSession({ token, principal: new Principal({ deviceId: id }) });
});

export const pair = Effect.fn("pair")(function* (code: string, deviceName: string) {
  if (!(yield* redeemCode(code)))
    return yield* new AuthenticationFailed({ reason: "invalid_code" });
  return yield* createDevice(deviceName);
});

export const listDevices = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const rows = yield* db.select().from(device);

  return rows.map(
    (row) =>
      new DeviceSummary({
        id: DeviceId.make(row.id),
        name: row.name,
        createdAt: row.createdAt,
        current: row.id === principal.deviceId,
      }),
  );
});

export const removeDevice = Effect.fn("removeDevice")(function* (deviceId: DeviceId) {
  const db = yield* Database;
  yield* db.delete(device).where(eq(device.id, deviceId));

  // Authentication checks a token only when a request starts, so open streams must end
  yield* (yield* Sessions).removeDevice(deviceId);
});

/** The device of a device token */
export const principalOf = Effect.fn("principalOf")(function* (token: string) {
  const db = yield* Database;
  const tokenHash = yield* sha256(token);
  const [row] = yield* db
    .select({ id: device.id })
    .from(device)
    .where(eq(device.tokenHash, tokenHash))
    .limit(1)
    .pipe(orDieOnDatabaseError("authenticate"));
  if (row !== undefined) return new Principal({ deviceId: DeviceId.make(row.id) });

  // A paired replica uses its replica ID as device ID
  const [peer] = yield* db
    .select({ replicaId: serverPeer.replicaId })
    .from(serverPeer)
    .where(eq(serverPeer.tokenHash, tokenHash))
    .pipe(orDieOnDatabaseError("authenticate"));
  if (peer === undefined) return yield* new Unauthorized();
  return new Principal({ deviceId: DeviceId.make(peer.replicaId) });
});

export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | Crypto.Crypto>();

    return (effect, { headers }) =>
      Effect.gen(function* () {
        const header = headers.authorization ?? "";
        if (!header.startsWith("Bearer ")) return yield* new Unauthorized();

        const principal = yield* principalOf(header.slice("Bearer ".length));
        return yield* Effect.provideService(effect, CurrentPrincipal, principal);
      }).pipe(Effect.provide(services));
  }),
);
