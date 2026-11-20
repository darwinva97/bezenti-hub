/**
 * A fake Keycloak realm in process, where the Hub's `KeycloakHttp` goes instead of the network:
 * discovery, keys and the token endpoint. `signIn` plays the person at Keycloak's sign-in page;
 * `serve` changes an answer; `requests` lists what the Hub asked. Its `.test` issuer never resolves.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Jwk from "effect/jose/Jwk";
import * as Jwt from "effect/jose/Jwt";

import { KeycloakHttp } from "./KeycloakClient.ts";

export const TEST_ISSUER = "https://keycloak.test/realms/hub";
/** The Hub's client in the fake realm, and its secret (fake: it opens nothing anywhere). */
const TEST_CLIENT_ID = "t3-hub";
const TEST_CLIENT_SECRET = "fake-realm-client-secret-7f3a9c";

/** How the fake answers one address. */
export type FakeAnswer =
  | {
      readonly status?: number;
      /** A JSON body. */
      readonly json?: unknown;
      /** A raw body, for what is not JSON. */
      readonly body?: string | Uint8Array;
      readonly headers?: Record<string, string>;
    }
  /** Never answers: the Hub's timeout ends it. */
  | "hang"
  /** The connection fails, as an unknown host or a refused port. */
  | "unreachable";

/** Keycloak's discovery document for a realm, as Keycloak 26 writes it (the parts the Hub reads). */
export const discoveryDocument = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
  userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  backchannel_logout_supported: true,
  backchannel_logout_session_supported: true,
  scopes_supported: ["openid", "profile", "email", "offline_access", "roles"],
  acr_values_supported: ["0", "1", "basico", "critica"],
  id_token_signing_alg_values_supported: ["RS256", "PS256", "ES256", "EdDSA"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  authorization_response_iss_parameter_supported: true,
});

const discoveryUrl = (issuer: string) => `${issuer}/.well-known/openid-configuration`;
const jwksUrl = (issuer: string) => `${issuer}/protocol/openid-connect/certs`;
const tokenUrl = (issuer: string) => `${issuer}/protocol/openid-connect/token`;

/** A KeycloakHttp that refuses every request: the testkit Hub's default, so no test goes out. */
export const layerNoNetwork = Layer.succeed(
  KeycloakHttp,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: "tests never reach the network",
        }),
      }),
    ),
  ),
);

/** Who signs in at the fake realm, and how its answer is bent for a test. */
export interface FakeSignIn {
  readonly sub: string;
  readonly username?: string;
  readonly email?: string;
  /** Claims to set (or, `undefined`, to drop) in the ID token. */
  readonly claims?: Record<string, unknown>;
  /** Sign the ID token with a key the realm never published. */
  readonly foreignKey?: boolean;
  /** The `iss` the authorization response names (RFC 9207); `null` leaves it out. */
  readonly responseIss?: string | null;
  /** Leave out the refresh token, as when `offline_access` is not granted. */
  readonly noRefreshToken?: boolean;
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | undefined;
  readonly as: FakeSignIn;
}

const Claims = Schema.Record(Schema.String, Schema.Unknown);

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256Base64Url = (text: string) =>
  Effect.promise(async () =>
    base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    ),
  );

const formDecode = (value: string) => decodeURIComponent(value.replaceAll("+", " "));

const bodyText = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body;
  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body);
  if (body._tag === "Raw" && typeof body.body === "string") return body.body;
  return "";
};

// Untraced: the realm (and its secret) is the test's, not the Hub's, and stays out of spans.
export const makeFakeKeycloak = Effect.fnUntraced(function* (
  options: {
    readonly issuer?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
  } = {},
) {
  const issuer = options.issuer ?? TEST_ISSUER;
  const clientId = options.clientId ?? TEST_CLIENT_ID;
  const clientSecret = options.clientSecret ?? TEST_CLIENT_SECRET;
  const [signingKey, foreignKey] = yield* Effect.all([
    Jwk.generateKeyPair({ algorithm: "ES256", kid: "fake-realm-1" }),
    Jwk.generateKeyPair({ algorithm: "ES256", kid: "fake-realm-1" }),
  ]).pipe(Effect.provide(NodeCrypto.layer));
  const answers = new Map<string, FakeAnswer>([
    [discoveryUrl(issuer), { json: discoveryDocument(issuer) }],
    [jwksUrl(issuer), { json: { keys: [signingKey.publicKey] } }],
  ]);
  const requests: Array<string> = [];
  /** The `Authorization` header of every token request, to see how the secret went. */
  const tokenRequests: Array<{
    readonly authorization: string | undefined;
    readonly body: string;
  }> = [];
  const codes = new Map<string, PendingCode>();
  /** Every refresh token the realm handed out, to look for it where it must not be. */
  const refreshTokens: Array<string> = [];
  let counter = 0;

  const respond = (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    status: number,
    json: unknown,
  ) => {
    const response = new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
    // fetch sets the address it answered from; a built Response has none.
    Object.defineProperty(response, "url", { value: url.href });
    return HttpClientResponse.fromWeb(request, response);
  };

  const idToken = Effect.fnUntraced(function* (pending: PendingCode) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    counter += 1;
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: pending.as.sub,
      aud: pending.clientId,
      azp: pending.clientId,
      exp: now + 300,
      iat: now,
      auth_time: now,
      sid: `fake-sso-session-${counter}`,
      preferred_username: pending.as.username ?? pending.as.sub,
      email: pending.as.email ?? `${pending.as.sub}@example.test`,
      ...(pending.nonce === undefined ? {} : { nonce: pending.nonce }),
    };
    for (const [name, value] of Object.entries(pending.as.claims ?? {})) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }
    const key = yield* Jwk.importPrivate(
      (pending.as.foreignKey === true ? foreignKey : signingKey).privateKey,
      "ES256",
    );
    const token = yield* Jwt.sign(Claims, claims, key, { kid: "fake-realm-1", typ: "JWT" });
    return Redacted.value(token);
  }, Effect.provide(NodeCrypto.layer));

  const tokenEndpoint = Effect.fnUntraced(function* (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
  ) {
    const authorization = request.headers.authorization;
    const body = bodyText(request);
    tokenRequests.push({ authorization, body });
    const expected = `Basic ${Buffer.from(
      `${new URLSearchParams({ v: clientId }).toString().slice(2)}:${new URLSearchParams({ v: clientSecret }).toString().slice(2)}`,
    ).toString("base64")}`;
    if (authorization !== expected) {
      return respond(request, url, 401, { error: "unauthorized_client" });
    }
    const form = new Map(
      body
        .split("&")
        .filter((pair) => pair !== "")
        .map((pair) => {
          const [name = "", value = ""] = pair.split("=");
          return [formDecode(name), formDecode(value)] as const;
        }),
    );
    const code = form.get("code") ?? "";
    const pending = codes.get(code);
    // A code is spent the first time it is presented, whatever comes next.
    codes.delete(code);
    if (
      form.get("grant_type") !== "authorization_code" ||
      pending === undefined ||
      pending.clientId !== clientId ||
      pending.redirectUri !== form.get("redirect_uri") ||
      (yield* sha256Base64Url(form.get("code_verifier") ?? "")) !== pending.codeChallenge
    ) {
      return respond(request, url, 400, {
        error: "invalid_grant",
        error_description: "Code not valid",
      });
    }
    counter += 1;
    const refreshToken = `fake-refresh-token-${counter}-q8w7e6r5t4y3u2i1`;
    if (pending.as.noRefreshToken !== true) refreshTokens.push(refreshToken);
    return respond(request, url, 200, {
      access_token: `fake-access-token-${counter}`,
      token_type: "Bearer",
      expires_in: 300,
      id_token: yield* idToken(pending),
      ...(pending.as.noRefreshToken === true
        ? { scope: "openid profile email" }
        : {
            refresh_token: refreshToken,
            refresh_expires_in: 0,
            scope: "openid profile email offline_access",
          }),
    });
  });

  const client = HttpClient.make((request, url) => {
    requests.push(url.href);
    if (url.href === tokenUrl(issuer) && request.method === "POST" && !answers.has(url.href)) {
      return tokenEndpoint(request, url).pipe(Effect.orDie);
    }
    const answer = answers.get(url.href) ?? { status: 404, json: { error: "not found" } };
    if (answer === "hang") return Effect.never;
    if (answer === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        }),
      );
    }
    const body =
      answer.body ?? (answer.json === undefined ? undefined : JSON.stringify(answer.json));
    const response = new Response(body ?? null, {
      status: answer.status ?? 200,
      headers: {
        ...(answer.json === undefined ? {} : { "content-type": "application/json" }),
        ...answer.headers,
      },
    });
    // fetch sets the address it answered from; a built Response has none.
    Object.defineProperty(response, "url", { value: url.href });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  /**
   * The person at the realm's sign-in page: reads the authorization request the Hub sent the
   * browser to, signs in as `as.sub`, and answers the address Keycloak sends the browser back to
   * (the Hub's callback with `code`, `state` and `iss`).
   */
  const signIn = (authorizationUrl: string, as: FakeSignIn) =>
    Effect.sync(() => {
      const url = new URL(authorizationUrl);
      const param = (name: string) => url.searchParams.get(name) ?? "";
      if (
        `${url.origin}${url.pathname}` !== discoveryDocument(issuer).authorization_endpoint ||
        param("response_type") !== "code" ||
        param("code_challenge_method") !== "S256" ||
        !param("scope").split(" ").includes("openid")
      ) {
        throw new Error(`not an authorization request the realm takes: ${authorizationUrl}`);
      }
      counter += 1;
      const code = `fake-authorization-code-${counter}`;
      codes.set(code, {
        clientId: param("client_id"),
        redirectUri: param("redirect_uri"),
        codeChallenge: param("code_challenge"),
        nonce: url.searchParams.get("nonce") ?? undefined,
        as,
      });
      const callback = new URL(param("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", param("state"));
      callback.searchParams.set("session_state", `fake-sso-session-${counter}`);
      if (as.responseIss !== null) callback.searchParams.set("iss", as.responseIss ?? issuer);
      return callback.href;
    });

  return {
    issuer,
    clientId,
    clientSecret,
    /** Put the fake where the Hub's Keycloak requests go. */
    layer: Layer.succeed(KeycloakHttp, client),
    /** The realm's signing key; its public half is in the served key set. */
    signingKey,
    /** Every address the Hub asked, in order. */
    requests,
    tokenRequests,
    refreshTokens,
    signIn,
    /** Answer `url` another way from now on. */
    serve: (url: string, answer: FakeAnswer) => {
      answers.set(url, answer);
    },
    discoveryUrl: discoveryUrl(issuer),
    jwksUrl: jwksUrl(issuer),
    tokenUrl: tokenUrl(issuer),
  };
});

export type FakeKeycloak = Effect.Success<ReturnType<typeof makeFakeKeycloak>>;
