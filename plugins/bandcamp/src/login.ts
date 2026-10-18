import { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import type { Credentials } from "@dyad/plugin";
import { getJson, providerError } from "@dyad/plugin/http";
import { Effect, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

const summaryUrl = "https://bandcamp.com/api/fan/2/collection_summary";
const identityCookie = "identity";

// The sign-in page always runs a reCAPTCHA, so only the browser can sign in (October 2026)
export const browserLogin = new BrowserLogin({
  url: "https://bandcamp.com/login",
  domain: "bandcamp.com",
  cookies: [identityCookie],
});

const FanSummary = Schema.Union([
  Schema.Struct({ collection_summary: Schema.Struct({ username: Schema.String }) }),
  Schema.Struct({ error: Schema.Literal(true), error_message: Schema.String }),
]);

/** The username of the signed-in fan */
export const readFanName = (credentials: Credentials) =>
  Effect.gen(function* () {
    const identity = credentials.get(identityCookie);
    if (identity === undefined) {
      return yield* new AccountLinkFailed({ reason: `No ${identityCookie} cookie` });
    }

    const request = HttpClientRequest.get(summaryUrl).pipe(
      HttpClientRequest.setHeader("Cookie", `${identityCookie}=${Redacted.value(identity)}`),
    );
    const summary = yield* getJson(request, FanSummary).pipe(
      Effect.mapError(
        (error) => new AccountLinkFailed({ reason: providerError("Bandcamp")(error).reason }),
      ),
    );
    if ("error" in summary) {
      return yield* new AccountLinkFailed({ reason: `Bandcamp: ${summary.error_message}` });
    }
    return summary.collection_summary.username;
  });
