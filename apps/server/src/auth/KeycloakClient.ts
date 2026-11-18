/**
 * The Hub's one adapter to a Keycloak realm over OIDC (Keycloak sign-in spec, «Módulos»). Not a
 * fetch tool: only the issuer's host, no redirects, 5 s and 128 KiB a request, and errors that
 * never echo a body (but the issuer a mismatching realm names, to show the address to type).
 */
import {
  KeycloakCheckFailureReason,
  type KeycloakCheckResult,
  KeycloakCheckStep,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as JoseError from "effect/jose/JoseError";
import * as Jwk from "effect/jose/Jwk";
import * as Jwks from "effect/jose/Jwks";

/** How long the Hub waits for each request to the realm, body included. */
const REQUEST_TIMEOUT = "5 seconds";
/** The largest discovery document or key set the Hub reads. */
export const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_KEYS = 64;
/** At most one key set fetch per this long for an unknown `kid` (loopback realms). */
const UNKNOWN_KEY_COOLDOWN_MS = 30_000;

/** The ID token algorithms the Hub accepts (spec: RS256, PS256, ES256, EdDSA). */
const ID_TOKEN_ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"] as const;

/**
 * The HTTP client for the realm, apart from the Hub's: it must never follow a redirect, so a 3xx
 * comes back as itself. Tests put a fake realm here (`Keycloak.testkit.ts`): no network.
 */
export class KeycloakHttp extends Context.Service<KeycloakHttp, HttpClient.HttpClient>()(
  "t3/auth/KeycloakClient/KeycloakHttp",
) {}

/** fetch, with `redirect: "manual"` on every request it sends. */
const layerHttp = Layer.effect(
  KeycloakHttp,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transform(client, (response) =>
      Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

/** Why a step failed, in plain words for the Owner (`message`). */
export class KeycloakProblem extends Schema.TaggedError<KeycloakProblem>()("KeycloakProblem", {
  step: KeycloakCheckStep,
  reason: KeycloakCheckFailureReason,
  message: Schema.String,
}) {}

const problem = (
  step: KeycloakCheckStep,
  reason: KeycloakCheckFailureReason,
  message: string,
): KeycloakProblem => new KeycloakProblem({ step, reason, message });

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https:`, or `http:` to this machine's loopback (a realm for development). */
const isSecure = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

/**
 * The issuer as Keycloak writes it in `iss`, or `undefined` when the Hub refuses it: https (http
 * only to loopback), no user, query nor fragment, a path allowed (`/realms/<name>`), one trailing
 * `/` dropped.
 */
export const normalizeIssuer = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) return undefined;
  const url = URL.parse(trimmed);
  if (url === null || !isSecure(url) || url.username !== "" || url.password !== "") {
    return undefined;
  }
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}${path}`;
};

export const INVALID_ISSUER_MESSAGE =
  "The issuer must be the realm's https:// address, such as https://auth.example.com/realms/acme " +
  "(http:// only on localhost), without a user, a query or a #.";

/** What the Hub keeps of the realm's discovery document. */
export interface KeycloakDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly endSessionEndpoint: string | undefined;
  readonly backchannelLogoutSupported: boolean;
  readonly backchannelLogoutSessionSupported: boolean;
  readonly scopesSupported: ReadonlyArray<string>;
  readonly acrValuesSupported: ReadonlyArray<string>;
}

const DiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  end_session_endpoint: Schema.optionalKey(Schema.String),
  backchannel_logout_supported: Schema.optionalKey(Schema.Boolean),
  backchannel_logout_session_supported: Schema.optionalKey(Schema.Boolean),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  acr_values_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeDiscovery = Schema.decodeUnknownEffect(DiscoveryDocument);
const decodeKeySet = Schema.decodeUnknownEffect(Jwks.KeySet);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isPublicJwk = Schema.is(Jwk.PublicJwk);

/** Whether the Hub can verify an ID token with this key (as `Jwks` selects one). */
const isUsable = (key: Jwk.PublicJwk) =>
  (key.use === undefined || key.use === "sig") &&
  (key.key_ops === undefined || key.key_ops.includes("verify")) &&
  ID_TOKEN_ALGORITHMS.some((algorithm) => {
    if (key.alg !== undefined && key.alg !== algorithm) return false;
    const crv = "crv" in key ? key.crv : undefined;
    switch (algorithm) {
      case "RS256":
      case "PS256":
        return key.kty === "RSA";
      case "ES256":
        return key.kty === "EC" && crv === "P-256";
      case "EdDSA":
        return key.kty === "OKP" && crv === "Ed25519";
    }
  });

/** The keys of a set the Hub can verify ID tokens with. */
const usableKeys = (keySet: Jwks.KeySet): ReadonlyArray<Jwk.PublicJwk> =>
  keySet.keys.filter(isPublicJwk).filter(isUsable);

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

export class KeycloakClient extends Context.Service<
  KeycloakClient,
  {
    /** The realm's discovery document, its `issuer` exactly the configured one. */
    readonly discover: (issuer: string) => Effect.Effect<KeycloakDiscovery, KeycloakProblem>;
    /**
     * The realm's keys to verify its tokens with (ticket 02): jose's remote set over https (10
     * minutes, refetched for an unknown `kid`), or on a loopback realm the Hub's own download
     * served by `Jwks.makeLocal`, downloaded again for an unknown `kid`.
     */
    readonly keySet: (
      discovery: KeycloakDiscovery,
    ) => Effect.Effect<Jwks.Jwks["Service"], KeycloakProblem, Scope.Scope>;
    /** «Check»: discovery, then the key set; a failure says which step and why. */
    readonly check: (issuer: string) => Effect.Effect<KeycloakCheckResult>;
  }
>()("t3/auth/KeycloakClient") {}

export const make = Effect.gen(function* () {
  const http = yield* KeycloakHttp;

  /** A JSON document from the realm: 200 from that very URL, within the time and size caps. */
  const fetchJson = (url: string, step: KeycloakCheckStep, what: string) => {
    const host = new URL(url).host;
    return Effect.gen(function* () {
      const response = yield* http
        .get(url, { headers: { accept: "application/json" } })
        .pipe(
          Effect.mapError(() =>
            problem(
              step,
              "unreachable",
              `Could not connect to ${host}. Check the address and that this Hub can reach it.`,
            ),
          ),
        );
      if (response.status >= 300 && response.status < 400) {
        return yield* problem(
          step,
          "redirect",
          `${host} answered ${what} with a redirect (${response.status}). The Hub never follows ` +
            "one: use the realm's exact address, as Keycloak names it in its issuer.",
        );
      }
      if (response.status !== 200) {
        return yield* problem(
          step,
          "http-status",
          response.status === 404
            ? `${host} has no ${what} there (404). Check the realm's name in the address.`
            : `${host} answered ${what} with status ${response.status}.`,
        );
      }
      if (response.url !== new URL(url).href) {
        return yield* problem(step, "redirect", `${what} came from another address than asked.`);
      }
      const body = new Uint8Array(MAX_DOCUMENT_BYTES);
      const length = yield* Stream.runFoldEffect(
        response.stream,
        () => 0,
        (length, chunk) => {
          if (chunk.length > body.length - length) {
            return Effect.fail(
              problem(
                step,
                "too-large",
                `${what} is larger than ${MAX_DOCUMENT_BYTES / 1024} KiB.`,
              ),
            );
          }
          body.set(chunk, length);
          return Effect.succeed(length + chunk.length);
        },
      ).pipe(
        Effect.catchTags({
          HttpClientError: () =>
            Effect.fail(problem(step, "unreachable", `${host} stopped while sending ${what}.`)),
        }),
      );
      return yield* parseJson(new TextDecoder().decode(body.subarray(0, length))).pipe(
        Effect.mapError(() => problem(step, "invalid-document", `${what} is not JSON.`)),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(problem(step, "timeout", `${host} did not send ${what} within 5 seconds.`)),
      }),
    );
  };

  const discover = Effect.fn("KeycloakClient.discover")(function* (issuer: string) {
    if (normalizeIssuer(issuer) !== issuer) {
      return yield* problem("issuer", "invalid-issuer", INVALID_ISSUER_MESSAGE);
    }
    const what = "the discovery document";
    const document = yield* fetchJson(
      `${issuer}/.well-known/openid-configuration`,
      "discovery",
      what,
    ).pipe(
      Effect.flatMap(decodeDiscovery),
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(
            problem(
              "discovery",
              "invalid-document",
              "The discovery document is not an OpenID Connect configuration.",
            ),
          ),
      }),
    );
    if (document.issuer !== issuer) {
      return yield* problem(
        "discovery",
        "issuer-mismatch",
        `The realm names its issuer ${clip(document.issuer)}, not ${issuer}. Use exactly the ` +
          "address it names.",
      );
    }
    // The Hub fetches these itself: only from the issuer's own host. The browser's, only secure.
    const origin = new URL(issuer).origin;
    for (const [field, value] of [
      ["key set (jwks_uri)", document.jwks_uri],
      ["token endpoint", document.token_endpoint],
    ] as const) {
      const url = URL.parse(value);
      if (url === null || url.origin !== origin) {
        return yield* problem(
          "discovery",
          "endpoint-off-issuer",
          `The realm's ${field} is not on ${new URL(issuer).host}. The Hub only talks to the ` +
            "issuer's own host.",
        );
      }
    }
    for (const value of [
      document.authorization_endpoint,
      ...(document.end_session_endpoint === undefined ? [] : [document.end_session_endpoint]),
    ]) {
      const url = URL.parse(value);
      if (url === null || !isSecure(url)) {
        return yield* problem(
          "discovery",
          "invalid-document",
          "The realm's sign-in or sign-out address is not https.",
        );
      }
    }
    return {
      issuer,
      authorizationEndpoint: document.authorization_endpoint,
      tokenEndpoint: document.token_endpoint,
      jwksUri: document.jwks_uri,
      endSessionEndpoint: document.end_session_endpoint,
      backchannelLogoutSupported: document.backchannel_logout_supported ?? false,
      backchannelLogoutSessionSupported: document.backchannel_logout_session_supported ?? false,
      scopesSupported: document.scopes_supported ?? [],
      acrValuesSupported: document.acr_values_supported ?? [],
    } satisfies KeycloakDiscovery;
  });

  /** The realm's key set, read by the Hub itself: at least one key it can verify with. */
  const fetchKeySet = Effect.fn("KeycloakClient.fetchKeySet")(function* (
    discovery: KeycloakDiscovery,
  ) {
    const keySet = yield* fetchJson(discovery.jwksUri, "keys", "the key set").pipe(
      Effect.flatMap(decodeKeySet),
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(problem("keys", "invalid-document", "The realm's key set is not a JWK set.")),
      }),
    );
    if (keySet.keys.length > MAX_KEYS) {
      return yield* problem("keys", "too-large", `The realm's key set has over ${MAX_KEYS} keys.`);
    }
    if (usableKeys(keySet).length === 0) {
      return yield* problem(
        "keys",
        "no-usable-keys",
        "The realm's key set has no signing key the Hub can verify with (RS256, PS256, ES256 " +
          "or EdDSA).",
      );
    }
    return keySet;
  });

  const keySet = Effect.fn("KeycloakClient.keySet")(function* (discovery: KeycloakDiscovery) {
    const unavailable = (cause: JoseError.JoseError) =>
      problem(
        "keys",
        "invalid-document",
        `The realm's key set could not be used: ${cause.message}`,
      );
    if (new URL(discovery.jwksUri).protocol === "https:") {
      return yield* Jwks.makeRemote({
        url: discovery.jwksUri,
        timeout: REQUEST_TIMEOUT,
        maxResponseBytes: MAX_DOCUMENT_BYTES,
        maxKeys: MAX_KEYS,
      }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(unavailable));
    }
    // A loopback realm over http (development): jose's remote set takes only https.
    let local = yield* Jwks.makeLocal(yield* fetchKeySet(discovery));
    let fetchedAt = yield* Clock.currentTimeMillis;
    /** A `kid` the set lacks may be a rotated key: download again, at most once per cooldown. */
    const refetch = Effect.fn("KeycloakClient.refetchLocalKeys")(function* (
      selection: Jwks.Selection,
      notFound: JoseError.JoseError,
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (now - fetchedAt < UNKNOWN_KEY_COOLDOWN_MS) return yield* notFound;
      fetchedAt = now;
      const fetched = yield* fetchKeySet(discovery).pipe(Effect.mapError(() => notFound));
      local = yield* Jwks.makeLocal(fetched);
      return yield* local.resolve(selection);
    });
    const resolve = Effect.fn("KeycloakClient.resolveLocalKey")(function* (
      selection: Jwks.Selection,
    ) {
      return yield* local.resolve(selection).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "KeyNotFound",
          (error) => refetch(selection, error),
        ),
      );
    });
    return Jwks.Jwks.of({ resolve });
  });

  const check = Effect.fn("KeycloakClient.check")(
    function* (issuer: string) {
      const discovery = yield* discover(issuer);
      const keys = yield* fetchKeySet(discovery);
      const ok: KeycloakCheckResult = {
        _tag: "ok",
        issuer,
        signingKeys: usableKeys(keys).length,
        backchannelLogoutSupported: discovery.backchannelLogoutSupported,
        offlineAccessOffered: discovery.scopesSupported.includes("offline_access"),
        acrValuesSupported: discovery.acrValuesSupported,
      };
      return ok;
    },
    Effect.catchTags({
      KeycloakProblem: (failed) =>
        Effect.succeed<KeycloakCheckResult>({
          _tag: "failed",
          step: failed.step,
          reason: failed.reason,
          message: failed.message,
        }),
    }),
  );

  return KeycloakClient.of({ discover, keySet, check });
});

export const layer = Layer.effect(KeycloakClient, make);

/** The adapter over the Hub's own fetch, which never follows a redirect. */
export const layerLive = layer.pipe(Layer.provide(layerHttp));
