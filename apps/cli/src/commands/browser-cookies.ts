// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no PBKDF2 or AES-CBC API
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import type { BrowserLogin } from "@dyad/domain";
import { Clock, Data, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CookieImportError,
  ImportedCookie,
  cookieMatches,
  selectCookies,
} from "./cookie-import.ts";

export class CookieProfile extends Data.Class<{
  readonly name: string;
  readonly file: string;
}> {}

export class CookieBrowser extends Data.Class<{
  readonly name: string;
  readonly family: "chromium" | "firefox" | "safari";
  readonly service: string;
  readonly application: string;
  readonly profiles: ReadonlyArray<CookieProfile>;
}> {}

const chromiumBrowsers = [
  ["Chrome", "Google/Chrome", "google-chrome", "Chrome Safe Storage", "chrome"],
  ["Chromium", "Chromium", "chromium", "Chromium Safe Storage", "chromium"],
  [
    "Brave",
    "BraveSoftware/Brave-Browser",
    "BraveSoftware/Brave-Browser",
    "Brave Safe Storage",
    "brave",
  ],
  ["Edge", "Microsoft Edge", "microsoft-edge", "Microsoft Edge Safe Storage", "chromium"],
  ["Vivaldi", "Vivaldi", "vivaldi", "Vivaldi Safe Storage", "chrome"],
  ["Opera", "com.operasoftware.Opera", "opera", "Opera Safe Storage", "chromium"],
  ["Arc", "Arc/User Data", "", "Arc Safe Storage", ""],
  // Helium 0.19.4.1 uses a reverse-DNS profile directory and a custom macOS Keychain service
  ["Helium", "net.imput.helium", "net.imput.helium", "Helium Storage Key", "chromium"],
  ["Chrome Beta", "Google/Chrome Beta", "google-chrome-beta", "Chrome Safe Storage", "chrome"],
  ["Chrome Dev", "Google/Chrome Dev", "google-chrome-unstable", "Chrome Safe Storage", "chrome"],
  ["Chrome Canary", "Google/Chrome Canary", "", "Chrome Safe Storage", ""],
] as const;

const firefoxProfiles = (text: string, root: string, path: Path.Path) =>
  text.split(/\r?\n\[/).flatMap((section) => {
    if (!/^\[?Profile\d+\]/.test(section)) return [];
    const fields = Object.fromEntries(
      section.split(/\r?\n/).flatMap((line) => {
        const match = /^(Name|Path|IsRelative)=(.*)$/.exec(line);
        return match === null ? [] : [[match[1], match[2]]];
      }),
    );
    const directory = fields.Path;
    if (directory === undefined) return [];
    const absolute = fields.IsRelative === "0" || path.isAbsolute(directory);
    return [
      new CookieProfile({
        file: path.join(absolute ? directory : path.join(root, directory), "cookies.sqlite"),
        name: fields.Name ?? directory,
      }),
    ];
  });

export const availableCookieBrowsers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = homedir();
  const mac = process.platform === "darwin";
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const support = path.join(home, "Library/Application Support");
  const browsers: CookieBrowser[] = [];

  // macOS denies a terminal without access to the data of other apps, so skip those paths
  const present = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  for (const [name, macDir, linuxDir, service, application] of chromiumBrowsers) {
    const directory = mac ? macDir : linuxDir;
    if (directory === "") continue;
    const root = path.join(mac ? support : config, directory);
    if (!(yield* present(root))) continue;
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const profiles: CookieProfile[] = [];
    for (const profile of ["", ...names.filter((name) => /^(Default|Profile \d+)$/.test(name))]) {
      const candidates = [
        path.join(root, profile, "Network/Cookies"),
        path.join(root, profile, "Cookies"),
      ];
      for (const file of candidates) {
        if (!(yield* present(file))) continue;
        profiles.push(new CookieProfile({ name: profile || "Default", file }));
        break;
      }
    }
    if (profiles.length > 0)
      browsers.push(
        new CookieBrowser({ name, family: "chromium", service, application, profiles }),
      );
  }
  const firefoxRoots = mac
    ? [
        ["Firefox", path.join(support, "Firefox")],
        ["LibreWolf", path.join(support, "LibreWolf")],
        ["Zen", path.join(support, "zen")],
      ]
    : [
        ["Firefox", path.join(config, "mozilla/firefox")],
        ["Firefox", path.join(home, ".mozilla/firefox")],
        ["Firefox", path.join(home, "snap/firefox/common/.mozilla/firefox")],
        ["Firefox", path.join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox")],
        ["Firefox", path.join(home, ".var/app/org.mozilla.firefox/config/mozilla/firefox")],
        ["LibreWolf", path.join(home, ".librewolf")],
        ["LibreWolf", path.join(home, ".var/app/io.gitlab.librewolf-community/.librewolf")],
        ["Zen", path.join(home, ".zen")],
        ["Zen", path.join(home, ".var/app/app.zen_browser.zen/.zen")],
      ];
  for (const [name, root] of firefoxRoots) {
    if (name === undefined || root === undefined) continue;
    const ini = path.join(root, "profiles.ini");
    const text = yield* fs.readFileString(ini).pipe(Effect.orElseSucceed(() => ""));
    const profiles: CookieProfile[] = [];
    for (const profile of firefoxProfiles(text, root, path)) {
      if (yield* present(profile.file)) profiles.push(profile);
    }
    if (profiles.length === 0) continue;
    const previous = browsers.find((browser) => browser.name === name);
    const all = [...(previous?.profiles ?? []), ...profiles];
    const next = new CookieBrowser({
      name,
      family: "firefox",
      service: "",
      application: "",
      profiles: all.filter(
        (profile, index) => all.findIndex((p) => p.file === profile.file) === index,
      ),
    });
    if (previous === undefined) browsers.push(next);
    else browsers.splice(browsers.indexOf(previous), 1, next);
  }
  if (mac) {
    const profiles: CookieProfile[] = [];
    for (const [name, directory, file] of [
      [
        "Safari",
        "Library/Containers/com.apple.Safari",
        "Data/Library/Cookies/Cookies.binarycookies",
      ],
      ["Legacy Safari", "Library/Cookies", "Cookies.binarycookies"],
    ] as const) {
      const root = path.join(home, directory);
      // A denied Safari path is still listed, so that the import can ask for Full Disk Access
      if (yield* fs.exists(root).pipe(Effect.orElseSucceed(() => true)))
        profiles.push(new CookieProfile({ name, file: path.join(root, file) }));
    }
    if (profiles.length > 0)
      browsers.push(
        new CookieBrowser({
          name: "Safari",
          family: "safari",
          service: "",
          application: "",
          profiles,
        }),
      );
  }
  return browsers;
}).pipe(
  Effect.mapError(
    () =>
      new CookieImportError({ reason: "Cannot list browser profiles. Use a cookie file instead." }),
  ),
);

const ChromiumCookie = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  expires_utc: Schema.BigInt,
});
const FirefoxCookie = Schema.Struct({
  host: Schema.String,
  name: Schema.String,
  value: Schema.String,
  expiry: Schema.BigInt,
});
const DatabaseVersion = Schema.Struct({ value: Schema.Union([Schema.String, Schema.Finite]) });

export const decryptChromiumCookie = (
  encrypted: Uint8Array,
  password: string,
  iterations: number,
  version: number,
  host: string,
) => {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  if (version < 24) return plaintext.toString("utf8");
  // Chromium 130 cookie DB version 24 binds the encrypted value to its host
  if (!plaintext.subarray(0, 32).equals(createHash("sha256").update(host).digest()))
    throw new Error();
  return plaintext.subarray(32).toString("utf8");
};

const storagePassword = (browser: CookieBrowser) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const mac = process.platform === "darwin";
      const args = mac
        ? ["find-generic-password", "-w", "-s", browser.service]
        : ["lookup", "application", browser.application];
      const handle = yield* spawner.spawn(
        ChildProcess.make(mac ? "security" : "secret-tool", args, { stderr: "ignore" }),
      );
      const password = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
      const code = yield* handle.exitCode;
      if (code !== 0 || password === "")
        return yield* new CookieImportError({ reason: "The browser key is not available" });
      return password.replace(/\r?\n$/, "");
    }),
  ).pipe(
    Effect.mapError(
      () =>
        new CookieImportError({
          reason:
            process.platform === "darwin"
              ? "Cannot read the browser key. Allow the Keychain prompt, or export a cookie file."
              : "Cannot read Secret Service. Install secret-tool and unlock the keyring, or export a cookie file. KWallet is not supported.",
        }),
    ),
  );

export const parseSafariCookies = (data: Buffer) => {
  if (data.toString("ascii", 0, 4) !== "cook") throw new Error();
  const pages = data.readUInt32BE(4);
  const sizes = Array.from({ length: pages }, (_, index) => data.readUInt32BE(8 + index * 4));
  const cookies: ImportedCookie[] = [];
  let offset = 8 + pages * 4;
  for (const size of sizes) {
    const page = data.subarray(offset, offset + size);
    offset += size;
    if (page.readUInt32LE(0) !== 0x10000 || page.length !== size) throw new Error();
    const count = page.readUInt32LE(4);
    for (let index = 0; index < count; index++) {
      const start = page.readUInt32LE(8 + index * 4);
      const length = page.readUInt32LE(start);
      const record = page.subarray(start, start + length);
      if (record.length !== length || length < 56) throw new Error();
      const string = (field: number) => {
        const start = record.readUInt32LE(field);
        const end = record.indexOf(0, start);
        if (start < 56 || end < start) throw new Error();
        return record.toString("utf8", start, end);
      };
      cookies.push(
        Schema.decodeSync(ImportedCookie)({
          domain: string(16),
          name: string(20),
          value: string(28),
          expires: record.readDoubleLE(40) + 978307200,
        }),
      );
    }
  }
  return cookies;
};

const firefoxCookies = Effect.fn(
  function* (database: DatabaseSync) {
    const version = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ user_version: Schema.Finite }),
    )(yield* Effect.try(() => database.prepare("PRAGMA user_version").get()));
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(FirefoxCookie))(
      yield* Effect.try(() => {
        const query = database.prepare(
          "SELECT host, name, value, expiry FROM moz_cookies WHERE originAttributes = ''",
        );
        query.setReadBigInts(true);
        return query.all();
      }),
    );
    return rows.map(
      (row) =>
        new ImportedCookie({
          domain: row.host,
          name: row.name,
          value: row.value,
          // Firefox 142 schema version 16 changed expiry from seconds to milliseconds
          expires: Number(row.expiry) / (version.user_version >= 16 ? 1000 : 1),
        }),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new CookieImportError({
            reason: "Cannot read Firefox cookies. Close the browser and try again.",
          }),
      ),
    ),
);

const chromiumCookies = Effect.fn(
  function* (database: DatabaseSync, browser: CookieBrowser, login: BrowserLogin, now: number) {
    const meta = yield* Schema.decodeUnknownEffect(DatabaseVersion)(
      yield* Effect.try(() =>
        database.prepare("SELECT value FROM meta WHERE key = 'version'").get(),
      ),
    );
    const version = yield* Schema.decodeEffect(Schema.Finite)(Number(meta.value));
    const all = yield* Schema.decodeUnknownEffect(Schema.Array(ChromiumCookie))(
      yield* Effect.try(() => {
        const query = database.prepare(
          "SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies",
        );
        query.setReadBigInts(true);
        return query.all();
      }),
    );
    const expires = (value: bigint) => (value === 0n ? 0 : Number(value) / 1e6 - 11644473600);
    const rows = all.filter((row) =>
      cookieMatches(
        login,
        { domain: row.host_key, name: row.name, expires: expires(row.expires_utc) },
        now,
      ),
    );
    const mac = process.platform === "darwin";
    const needsKey = rows.some(
      (row) =>
        row.value === "" &&
        row.encrypted_value.length > 0 &&
        (mac || Buffer.from(row.encrypted_value.subarray(0, 3)).toString() === "v11"),
    );
    const password = needsKey ? yield* storagePassword(browser) : "";
    return yield* Effect.try({
      try: () =>
        rows.map((row) => {
          const encrypted = row.encrypted_value;
          const prefix = Buffer.from(encrypted.subarray(0, 3)).toString();
          const value = () => {
            if (row.value !== "" || encrypted.length === 0) return row.value;
            if (prefix !== "v10" && (mac || prefix !== "v11")) throw new Error();
            return decryptChromiumCookie(
              encrypted,
              !mac && prefix === "v10" ? "peanuts" : password,
              mac ? 1003 : 1,
              version,
              row.host_key,
            );
          };
          return new ImportedCookie({
            domain: row.host_key,
            name: row.name,
            value: value(),
            expires: expires(row.expires_utc),
          });
        }),
      catch: () =>
        new CookieImportError({
          reason: "Cannot decrypt browser cookies. Export a cookie file instead.",
        }),
    });
  },
  (effect) =>
    effect.pipe(
      Effect.catchIf(
        (error) => !(error instanceof CookieImportError),
        () =>
          Effect.fail(
            new CookieImportError({
              reason: "Cannot read Chromium cookies. Close the browser and try again.",
            }),
          ),
      ),
    ),
);

export const readBrowserCookies = (
  browser: CookieBrowser,
  profile: CookieProfile,
  login: BrowserLogin,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const now = (yield* Clock.currentTimeMillis) / 1000;
      if (browser.family === "safari") {
        const data = yield* fs.readFile(profile.file).pipe(
          Effect.mapError(
            () =>
              new CookieImportError({
                reason:
                  "Cannot read Safari cookies. Give this terminal Full Disk Access in System Settings > Privacy & Security, restart it, then try again.",
              }),
          ),
        );
        return yield* Effect.try({
          try: () => selectCookies(login, parseSafariCookies(Buffer.from(data)), now),
          catch: () =>
            new CookieImportError({
              reason: "Cannot parse Safari cookies. Export a cookie file instead.",
            }),
        });
      }
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dyad-cookies-" });
      const file = path.join(directory, "cookies.sqlite");
      yield* fs.copyFile(profile.file, file);
      if (yield* fs.exists(`${profile.file}-wal`))
        yield* fs.copyFile(`${profile.file}-wal`, `${file}-wal`);
      const database = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new DatabaseSync(file),
          catch: () =>
            new CookieImportError({
              reason: "Cannot open the cookie database. Close the browser and try again.",
            }),
        }),
        (db) => Effect.sync(() => db.close()),
      );
      const cookies =
        browser.family === "firefox"
          ? yield* firefoxCookies(database)
          : yield* chromiumCookies(database, browser, login, now);
      return selectCookies(login, cookies, now);
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(
        new CookieImportError({
          reason:
            "Cannot copy browser cookies. Close the browser and try again, or export a cookie file.",
        }),
      ),
    ),
  );
