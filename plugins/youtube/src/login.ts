import { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import type { Credentials } from "@dyad/plugin";
import { getJson, providerError } from "@dyad/plugin/http";
import { NodeCrypto } from "@effect/platform-node";
import { Clock, Crypto, Effect, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpClientRequest } from "effect/http";

import { web } from "./api.ts";

const origin = "https://www.youtube.com";

// Google clears `LOGIN_INFO` when it ends the session, but can keep the others
const sessionCookies = [
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "LOGIN_INFO",
] as const;

// The sign-in link of youtube.com, which returns to youtube.com where `LOGIN_INFO` is set
export const browserLogin = new BrowserLogin({
  url: `https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=${encodeURIComponent(`${origin}/signin?action_handle_signin=true&app=desktop&next=%2F`)}`,
  domain: "youtube.com",
  cookies: [...sessionCookies],
  requiredCookies: ["LOGIN_INFO"],
});

const Text = Schema.Struct({
  simpleText: Schema.optional(Schema.String),
  runs: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))),
});

const AccountMenu = Schema.Struct({
  actions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        openPopupAction: Schema.Struct({
          popup: Schema.Struct({
            multiPageMenuRenderer: Schema.Struct({
              // Missing when YouTube sees no signed-in account
              header: Schema.optional(
                Schema.Struct({
                  activeAccountHeaderRenderer: Schema.Struct({ accountName: Text }),
                }),
              ),
            }),
          }),
        }),
      }),
    ),
  ),
});

/**
 * The cookies and the `Authorization` of a request of the signed-in web client at `site`. The web
 * client signs each request with a hash of the `*APISID` cookies and the origin.
 */
export const accountHeaders = Effect.fn("accountHeaders")(function* (
  credentials: Credentials,
  site: string,
) {
  const crypto = yield* Crypto.Crypto;
  const value = (name: string) => Redacted.value(credentials.get(name) ?? Redacted.make(""));
  const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const hash = (scheme: string, cookie: string) =>
    crypto
      .digest("SHA-1", new TextEncoder().encode(`${seconds} ${value(cookie)} ${site}`))
      .pipe(Effect.map((digest) => `${scheme} ${seconds}_${Hex.encode(digest)}`));
  const authorization = yield* Effect.all(
    (
      [
        ["SAPISIDHASH", "SAPISID"],
        ["SAPISID1PHASH", "__Secure-1PAPISID"],
        ["SAPISID3PHASH", "__Secure-3PAPISID"],
      ] as const
    ).flatMap(([scheme, cookie]) => (value(cookie) === "" ? [] : [hash(scheme, cookie)])),
  ).pipe(Effect.orDie);

  return {
    Cookie: sessionCookies
      .flatMap((name) => (value(name) === "" ? [] : [`${name}=${value(name)}`]))
      .join("; "),
    Authorization: authorization.join(" "),
    Origin: site,
    "X-Origin": site,
    "X-Goog-AuthUser": "0",
  };
}, Effect.provide(NodeCrypto.layer));

/** The name of the signed-in account, with one request of the web client */
export const readAccountName = Effect.fn("readAccountName")(function* (credentials: Credentials) {
  if (
    !["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"].some((name) => {
      const cookie = credentials.get(name);
      return cookie !== undefined && Redacted.value(cookie) !== "";
    })
  ) {
    return yield* new AccountLinkFailed({ reason: "The import needs a YouTube APISID cookie" });
  }

  const request = HttpClientRequest.post(`${origin}/youtubei/v1/account/account_menu`).pipe(
    HttpClientRequest.setUrlParam("prettyPrint", "false"),
    HttpClientRequest.setHeaders(yield* accountHeaders(credentials, origin)),
    HttpClientRequest.bodyJsonUnsafe({
      context: { client: web },
    }),
  );
  const menu = yield* getJson(request, AccountMenu).pipe(
    Effect.mapError(
      (error) => new AccountLinkFailed({ reason: providerError("YouTube")(error).reason }),
    ),
  );

  const header = menu.actions?.[0]?.openPopupAction.popup.multiPageMenuRenderer.header;
  if (header === undefined) {
    return yield* new AccountLinkFailed({ reason: "YouTube does not see a signed-in account" });
  }
  const name = header.activeAccountHeaderRenderer.accountName;
  return name.simpleText ?? name.runs?.map((run) => run.text).join("") ?? "Google account";
});
