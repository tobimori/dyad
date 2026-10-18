import { homedir } from "node:os";

import type { BrowserLogin } from "@dyad/domain";
import { Clock, Data, Effect, FileSystem, Path, Schema } from "effect";

export class CookieImportError extends Data.TaggedError("CookieImportError")<{
  readonly reason: string;
}> {}

export class ImportedCookie extends Schema.Class<ImportedCookie>("ImportedCookie")({
  domain: Schema.String,
  name: Schema.String,
  value: Schema.String,
  expires: Schema.Finite,
}) {}

export const cookieMatches = (
  login: BrowserLogin,
  cookie: { readonly domain: string; readonly name: string; readonly expires: number },
  now: number,
) => {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  return (
    login.cookies.includes(cookie.name) &&
    (domain === login.domain || domain.endsWith(`.${login.domain}`)) &&
    (cookie.expires === 0 || cookie.expires > now)
  );
};

export const selectCookies = (
  login: BrowserLogin,
  cookies: ReadonlyArray<ImportedCookie>,
  now: number,
) =>
  Object.fromEntries(
    cookies.flatMap((cookie) =>
      cookieMatches(login, cookie, now) ? [[cookie.name, cookie.value]] : [],
    ),
  );

export const parseCookieFile = (text: string) =>
  Effect.try({
    try: () =>
      text.split(/\r?\n/).flatMap((line) => {
        const content = line.replace(/^#HttpOnly_/, "");
        if (content.trim() === "" || content.startsWith("#")) return [];
        const fields = content.split("\t");
        if (fields.length !== 7) throw new Error();
        const [domain, subdomains, path, secure, expires, name, value] = fields;
        if (
          !["TRUE", "FALSE"].includes(subdomains ?? "") ||
          !["TRUE", "FALSE"].includes(secure ?? "") ||
          !path?.startsWith("/") ||
          !/^(?:\d+(?:\.\d+)?)?$/.test(expires ?? "")
        )
          throw new Error();
        return [
          Schema.decodeUnknownSync(ImportedCookie)({
            domain,
            name,
            value,
            expires: Number(expires),
          }),
        ];
      }),
    catch: () => new CookieImportError({ reason: "Not a Netscape cookies.txt file" }),
  });

export const readCookieFile = (login: BrowserLogin, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file;
    const text = yield* fs
      .readFileString(filename)
      .pipe(
        Effect.mapError(() => new CookieImportError({ reason: "Cannot read the cookie file" })),
      );
    return selectCookies(
      login,
      yield* parseCookieFile(text),
      (yield* Clock.currentTimeMillis) / 1000,
    );
  });
