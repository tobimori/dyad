import { device, user } from "@dyad/db";
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
  UserId,
} from "@dyad/domain";
import { and, eq } from "drizzle-orm";
import { Clock, Context, Crypto, Data, Effect, Layer, Option, Ref } from "effect";

import { fromHex, hex } from "./ids.ts";
import { Sessions } from "./sessions.ts";

// Compares all characters, so that the time does not show how many characters match
const equalSecrets = (a: string, b: string) => {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
};

// OWASP recommendation for PBKDF2-HMAC-SHA256 in 2023. WebCrypto has no memory-hard function, and
// Node, Electron and browsers all have PBKDF2.
const passwordIterations = 600_000;

// Hash of a random password that nobody knows. `login` checks a password against it when the user
// does not exist, so that the answer takes as long as for a wrong password.
const unknownUserHash =
  "pbkdf2-sha256$600000$d41daee5d6c3fab7525367021d62d6ad$778c3d7ea05bb6eabd68179a70bfedd695ed7dca46eecc3cf346d4c742634f0f";

const pbkdf2 = (password: string, salt: Uint8Array, iterations: number) =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() =>
      globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"],
      ),
    );
    const bits = yield* Effect.promise(() =>
      globalThis.crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        key,
        256,
      ),
    );
    return new Uint8Array(bits);
  });

const randomBytes = (size: number) =>
  Crypto.Crypto.use((crypto) => crypto.randomBytes(size)).pipe(Effect.orDie);

const hashPassword = (password: string) =>
  Effect.gen(function* () {
    const salt = yield* randomBytes(16);
    const hash = yield* pbkdf2(password, salt, passwordIterations);
    return `pbkdf2-sha256$${passwordIterations}$${hex(salt)}$${hex(hash)}`;
  });

const verifyPassword = (password: string, stored: string) =>
  Effect.gen(function* () {
    const [scheme, iterations, salt, expected] = stored.split("$");
    if (scheme !== "pbkdf2-sha256" || salt === undefined || expected === undefined) return false;

    const hash = yield* pbkdf2(password, fromHex(salt), Number(iterations));
    return equalSecrets(hex(hash), expected);
  });

const sha256 = (value: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(value));
    return hex(digest);
  }).pipe(Effect.orDie);

// No 0, O, 1 or I, so that a code read from a screen is typed correctly
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomCode = Effect.gen(function* () {
  const bytes = yield* randomBytes(8);
  // 256 is a multiple of the 32 characters, so each character has the same probability
  const characters = Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
});

const normalizeCode = (code: string) => {
  const characters = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
};

class PendingPairing extends Data.Class<{ readonly userId: UserId; readonly expiresAt: number }> {}

const pairingLifetimeMs = 5 * 60 * 1000;

/**
 * Short-lived codes stay in memory, so a server restart cancels them. The server then logs a new
 * setup code, and a signed-in device can make a new pairing code.
 */
class AuthCodes extends Context.Service<
  AuthCodes,
  {
    /** Exists only while the replica has no user */
    readonly setup: Ref.Ref<Option.Option<string>>;
    readonly pairings: Ref.Ref<ReadonlyMap<string, PendingPairing>>;
  }
>()("@dyad/server-core/AuthCodes") {}

export const authCodesLayer = Layer.effect(
  AuthCodes,
  Effect.gen(function* () {
    const db = yield* Database;
    const users = yield* db.$count(user);
    const setup = yield* Ref.make(Option.none<string>());

    if (users === 0) {
      const code = yield* randomCode;
      yield* Ref.set(setup, Option.some(code));
      // The setup code is the only way to create the first admin, so the operator must see it
      yield* Effect.logWarning(`No user exists. Create the first admin with setup code ${code}`);
    }

    const pairings = yield* Ref.make<ReadonlyMap<string, PendingPairing>>(new Map());
    return { setup, pairings };
  }).pipe(Effect.orDie),
);

const createDevice = (userId: UserId, name: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const token = hex(yield* randomBytes(32));
    const id = DeviceId.make(yield* crypto.randomUUIDv7().pipe(Effect.orDie));

    yield* db.insert(device).values({
      id,
      userId,
      name,
      tokenHash: yield* sha256(token),
      createdAt: yield* Clock.currentTimeMillis,
    });

    return new DeviceSession({ token, principal: new Principal({ userId, deviceId: id }) });
  });

export const setup = ({
  setupCode,
  username,
  password,
  deviceName,
}: {
  readonly setupCode: string;
  readonly username: string;
  readonly password: string;
  readonly deviceName: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const codes = yield* AuthCodes;

    // Check and clear in one step, so that two requests with the code cannot create two admins
    const code = normalizeCode(setupCode);
    const result = yield* Ref.modify(codes.setup, (current) => {
      if (Option.isNone(current)) return ["already_set_up", current] as const;
      if (!equalSecrets(code, current.value)) return ["invalid_code", current] as const;
      return ["claimed", Option.none<string>()] as const;
    });
    if (result !== "claimed") return yield* new AuthenticationFailed({ reason: result });

    return yield* Effect.gen(function* () {
      const userId = UserId.make(yield* crypto.randomUUIDv7().pipe(Effect.orDie));
      yield* db.insert(user).values({
        id: userId,
        username,
        passwordHash: yield* hashPassword(password),
        role: "admin",
        createdAt: yield* Clock.currentTimeMillis,
      });
      return yield* createDevice(userId, deviceName);
    }).pipe(
      // Without the code, a failed setup would leave the server without a way to create an admin
      Effect.onError(() => Ref.set(codes.setup, Option.some(code))),
    );
  });

export const login = ({
  username,
  password,
  deviceName,
}: {
  readonly username: string;
  readonly password: string;
  readonly deviceName: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db.select().from(user).where(eq(user.username, username)).limit(1);

    const valid = yield* verifyPassword(password, row?.passwordHash ?? unknownUserHash);
    if (row === undefined || !valid) {
      return yield* new AuthenticationFailed({ reason: "invalid_credentials" });
    }

    return yield* createDevice(UserId.make(row.id), deviceName);
  });

export const createPairingCode = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const codes = yield* AuthCodes;
  const now = yield* Clock.currentTimeMillis;
  const code = yield* randomCode;
  const expiresAt = now + pairingLifetimeMs;

  yield* Ref.update(codes.pairings, (pairings) => {
    const next = new Map([...pairings].filter(([, pairing]) => pairing.expiresAt > now));
    next.set(code, new PendingPairing({ userId: principal.userId, expiresAt }));
    return next;
  });
  return new PairingCode({ code, expiresAt });
});

export const pair = (code: string, deviceName: string) =>
  Effect.gen(function* () {
    const codes = yield* AuthCodes;
    const now = yield* Clock.currentTimeMillis;
    const normalized = normalizeCode(code);

    // A code works once
    const pairing = yield* Ref.modify(codes.pairings, (pairings) => {
      const next = new Map(pairings);
      next.delete(normalized);
      return [pairings.get(normalized), next];
    });
    if (pairing === undefined || pairing.expiresAt <= now) {
      return yield* new AuthenticationFailed({ reason: "invalid_code" });
    }

    return yield* createDevice(pairing.userId, deviceName);
  });

export const listDevices = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const rows = yield* db.select().from(device).where(eq(device.userId, principal.userId));

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

export const removeDevice = (deviceId: DeviceId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    yield* db
      .delete(device)
      .where(and(eq(device.id, deviceId), eq(device.userId, principal.userId)));

    // Authentication checks a token only when a request starts, so open streams must end
    yield* (yield* Sessions).removeDevice(principal.userId, deviceId);
  });

export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | Crypto.Crypto>();

    return (effect, { headers }) =>
      Effect.gen(function* () {
        const header = headers.authorization ?? "";
        if (!header.startsWith("Bearer ")) return yield* new Unauthorized();

        const db = yield* Database;
        const tokenHash = yield* sha256(header.slice("Bearer ".length));
        const [row] = yield* db
          .select({ id: device.id, userId: device.userId })
          .from(device)
          .where(eq(device.tokenHash, tokenHash))
          .limit(1)
          .pipe(orDieOnDatabaseError("authenticate"));
        if (row === undefined) return yield* new Unauthorized();

        const principal = new Principal({
          userId: UserId.make(row.userId),
          deviceId: DeviceId.make(row.id),
        });
        return yield* Effect.provideService(effect, CurrentPrincipal, principal);
      }).pipe(Effect.provide(services));
  }),
);
